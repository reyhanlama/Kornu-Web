import dns from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { createBrotliDecompress, createGunzip, createInflate } from 'node:zlib';
import { Readability } from '@mozilla/readability';
import { JSDOM } from 'jsdom';

const MAX_HTML_BYTES = 5_000_000;
const MAX_IMAGE_BYTES = 4_000_000;
const MAX_IMAGES = 30;

function privateAddress(address) {
  if (net.isIP(address) === 4) {
    const [a, b] = address.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) ||
      (a === 192 && b === 0) || (a === 198 && (b === 18 || b === 19));
  }
  if (net.isIP(address) === 6) {
    const lower = address.toLowerCase();
    return lower === '::1' || lower === '::' || lower.startsWith('fc') ||
      lower.startsWith('fd') || lower.startsWith('fe8') || lower.startsWith('fe9') ||
      lower.startsWith('fea') || lower.startsWith('feb') || lower.startsWith('::ffff:');
  }
  return true;
}

export async function validatePublicURL(input) {
  let url;
  try { url = new URL(input); } catch { throw new Error('Enter a complete article URL.'); }
  if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password || url.port) {
    throw new Error('Enter a public http or https article URL.');
  }
  const host = url.hostname.toLowerCase();
  if (host === 'localhost' || host.endsWith('.local') || host.endsWith('.internal') || net.isIP(host)) {
    throw new Error('This link cannot be imported.');
  }
  const addresses = await dns.lookup(host, { all: true });
  if (!addresses.length || addresses.some(({ address }) => privateAddress(address))) {
    throw new Error('This link cannot be imported.');
  }
  return url;
}

const escapeHTML = (value = '') => String(value).replace(/[&<>"']/g, (char) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
})[char]);

function publicLink(raw, base) {
  if (typeof raw !== 'string' || !raw.trim()) return null;
  try {
    const url = new URL(raw, base);
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password ? url.href : null;
  } catch { return null; }
}

function bestImageSource(image) {
  const srcset = image.getAttribute('data-srcset') || image.getAttribute('srcset');
  const candidate = srcset?.split(',').at(-1)?.trim().split(/\s+/)[0];
  const source = image.getAttribute('data-src') || image.getAttribute('data-original') || candidate || image.getAttribute('src');
  return source && !source.startsWith('data:') ? source : null;
}

function prepareImages(document, base) {
  for (const image of document.querySelectorAll('img')) {
    const source = bestImageSource(image);
    const url = source && publicLink(source, base);
    if (url) image.setAttribute('src', url);
    image.removeAttribute('srcset');
    image.removeAttribute('data-srcset');
  }
}

function trimSourceFurniture(document, url) {
  if (!url.hostname.endsWith('wikipedia.org')) return;
  document.querySelectorAll('sup.reference, .mw-editsection, .noprint, ol.references, .mw-references-wrap').forEach((node) => node.remove());
  const article = document.querySelector('.mw-parser-output');
  if (!article) return;
  const heading = article.querySelector('h2#See_also, h2#References, h2#Further_reading, h2#External_links');
  const section = heading?.closest('section');
  const cutoff = section?.parentElement === article ? section : heading?.parentElement?.parentElement === article ? heading.parentElement : null;
  for (let node = cutoff; node;) {
    const next = node.nextElementSibling;
    node.remove();
    node = next;
  }
}

function inline(node, base) {
  if (node.nodeType === 3) return escapeHTML(node.nodeValue.replace(/\s+/g, ' '));
  if (node.nodeType !== 1) return '';
  const tag = node.localName.toLowerCase();
  if (tag === 'br') return ' ';
  if (['img', 'picture', 'svg', 'script', 'style', 'iframe', 'button', 'input'].includes(tag)) return '';
  const children = [...node.childNodes].map((child) => inline(child, base)).join('');
  if (tag === 'a') {
    const href = publicLink(node.getAttribute('href'), base);
    return href ? `<a href="${escapeHTML(href)}" target="_blank" rel="noopener noreferrer">${children}</a>` : children;
  }
  const mapped = { b: 'strong', strong: 'strong', i: 'em', em: 'em', code: 'code', sub: 'sub', sup: 'sup', s: 's', del: 's' }[tag];
  return mapped ? `<${mapped}>${children}</${mapped}>` : children;
}

function inlineChildren(element, base) {
  return [...element.childNodes].map((child) => inline(child, base)).join('');
}

export function extractArticle(html, urlString) {
  const url = new URL(urlString);
  const document = new JSDOM(html, { url: url.href }).window.document;
  const pageHeading = document.querySelector('article h1, main h1, h1')?.textContent.replace(/\s+/g, ' ').trim() || '';
  const description = document.querySelector('meta[name="description"], meta[property="og:description"]')?.getAttribute('content')?.trim() || '';
  trimSourceFurniture(document, url);
  prepareImages(document, url.href);
  const readable = new Readability(document, { charThreshold: 200, keepClasses: false }).parse();
  if (!readable?.content) throw new Error('Kornu could not find a readable article on this page. Open the original instead.');
  const source = url.hostname.replace(/^www\./, '');
  const title = readable.title?.trim() && readable.title.trim() !== source ? readable.title.trim() : pageHeading || readable.title?.trim() || source;
  const body = new JSDOM(`<article>${readable.content}</article>`, { url: url.href }).window.document;
  const root = body.querySelector('article');
  const blocks = [];
  const paragraphs = [];
  let imageCount = 0;
  let omittedImages = 0;

  function addText(kind, element, extra = {}) {
    const content = kind === 'code' ? escapeHTML(element.textContent || '') : inlineChildren(element, url.href);
    const text = kind === 'code' ? element.textContent || '' : JSDOM.fragment(content).textContent || '';
    if (text.trim().length < (kind === 'paragraph' ? 14 : 2)) return;
    const index = paragraphs.length;
    paragraphs.push(text);
    blocks.push({ kind, index, html: content, ...extra });
  }

  function addImage(image, caption = '') {
    const width = Number(image.getAttribute('width'));
    const height = Number(image.getAttribute('height'));
    if ((width > 0 && width < 160) || (height > 0 && height < 100)) return;
    const src = publicLink(bestImageSource(image), url.href);
    if (!src || /\.(svg)(?:\?|$)/i.test(src) || /avatar|logo|icon|pixel|tracking|padlock/i.test(src)) return;
    if (imageCount >= MAX_IMAGES) { omittedImages++; return; }
    blocks.push({ kind: 'image', url: src, caption: caption.trim() || image.getAttribute('alt')?.trim() || '', afterParagraph: paragraphs.length - 1 });
    imageCount++;
  }

  function visit(node) {
    if (node.nodeType !== 1) return;
    const tag = node.localName.toLowerCase();
    if (['script', 'style', 'nav', 'aside', 'form', 'iframe', 'noscript'].includes(tag)) return;
    if (/^h[2-6]$/.test(tag)) {
      if (node.textContent.replace(/\s+/g, ' ').trim() !== title) addText('heading', node, { level: Number(tag[1]) });
      return;
    }
    if (tag === 'p') {
      addText('paragraph', node);
      for (const image of node.querySelectorAll('img')) addImage(image);
      return;
    }
    if (tag === 'figure') {
      const caption = node.querySelector('figcaption')?.textContent.replace(/\s+/g, ' ').trim() || '';
      for (const image of node.querySelectorAll('img')) addImage(image, caption);
      return;
    }
    if (tag === 'img') { addImage(node); return; }
    if (tag === 'blockquote') {
      const parts = [...node.querySelectorAll('p')];
      if (parts.length) parts.forEach((part) => addText('quote', part));
      else addText('quote', node);
      return;
    }
    if (tag === 'ul' || tag === 'ol') {
      let number = Number(node.getAttribute('start')) || 1;
      for (const child of node.children) {
        if (child.localName === 'li') addText('list-item', child, { ordered: tag === 'ol', number: number++ });
      }
      return;
    }
    if (tag === 'pre') { addText('code', node); return; }
    if (tag === 'table') {
      const rows = [...node.querySelectorAll('tr')].slice(0, 80).map((row) => [...row.querySelectorAll('th,td')].slice(0, 16).map((cell) => ({ text: cell.textContent.replace(/\s+/g, ' ').trim(), heading: cell.localName === 'th' })));
      if (rows.some((row) => row.length)) blocks.push({ kind: 'table', rows, caption: node.querySelector('caption')?.textContent.trim() || '' });
      return;
    }
    if (tag === 'hr') { blocks.push({ kind: 'rule' }); return; }
    for (const child of node.children) visit(child);
  }

  for (const child of root.children) visit(child);
  const text = paragraphs.join(' ');
  if (paragraphs.length < 2 || text.trim().length < 280) {
    throw new Error('Kornu could not find enough article text on this page. Open the original instead.');
  }
  const wordCount = text.trim().split(/\s+/).length;
  const warnings = [];
  if (source.includes('medium.com') && wordCount < 700 && /(?:…|\.\.\.)\s*$/.test(text)) warnings.push('Only an opening preview was available. Open the original story for the rest.');
  if (omittedImages) warnings.push(`${omittedImages} images were beyond the current capture limit.`);
  const images = blocks.filter((block) => block.kind === 'image').map(({ url: imageURL, caption, afterParagraph }) => ({ url: imageURL, caption, afterParagraph }));
  return {
    title, source, subtitle: description || (readable.excerpt && !text.trim().startsWith(readable.excerpt.trim()) ? readable.excerpt.trim() : ''),
    byline: readable.byline?.trim() || '', siteName: readable.siteName?.trim() || source,
    paragraphs, blocks, images, wordCount, warning: warnings.join(' ') || null, url: url.href
  };
}

function publicLookup(host, options, callback) {
  dns.lookup(host, { all: true }).then((addresses) => {
    if (!addresses.length || addresses.some(({ address }) => privateAddress(address))) {
      callback(new Error('This link cannot be imported.'));
      return;
    }
    if (options.all) callback(null, addresses);
    else callback(null, addresses[0].address, addresses[0].family);
  }).catch(callback);
}

function requestRemote(url, acceptedType, limit) {
  return new Promise((resolve, reject) => {
    const transport = url.protocol === 'https:' ? https : http;
    const request = transport.get(url, {
      lookup: publicLookup,
      signal: AbortSignal.timeout(20000),
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; KornuReader/0.2)',
        Accept: acceptedType === 'html' ? 'text/html,application/xhtml+xml' : 'image/avif,image/webp,image/png,image/jpeg,image/gif',
        'Accept-Encoding': 'gzip, deflate, br'
      }
    }, async (response) => {
      try {
        if ([301, 302, 303, 307, 308].includes(response.statusCode)) {
          response.resume();
          resolve({ redirect: response.headers.location });
          return;
        }
        if (response.statusCode < 200 || response.statusCode >= 300) throw new Error(`The source returned ${response.statusCode}.`);
        const mime = (response.headers['content-type'] || '').split(';')[0].toLowerCase();
        if (acceptedType === 'html' && !['text/html', 'application/xhtml+xml'].includes(mime)) throw new Error('This link is not an HTML article.');
        if (acceptedType === 'image' && !['image/jpeg', 'image/png', 'image/webp', 'image/avif', 'image/gif'].includes(mime)) throw new Error('This asset is not a supported image.');
        if (Number(response.headers['content-length']) > limit) throw new Error('The source is too large to capture.');
        const encoding = response.headers['content-encoding'];
        const decoder = { gzip: createGunzip, deflate: createInflate, br: createBrotliDecompress }[encoding];
        if (encoding && encoding !== 'identity' && !decoder) throw new Error('This source uses unsupported compression.');
        const stream = decoder ? response.pipe(decoder()) : response;
        const chunks = [];
        let size = 0;
        for await (const chunk of stream) {
          size += chunk.length;
          if (size > limit) throw new Error('The source is too large to capture.');
          chunks.push(chunk);
        }
        resolve({ bytes: Buffer.concat(chunks), mime, url: url.href });
      } catch (error) {
        request.destroy();
        reject(error);
      }
    });
    request.on('error', reject);
  });
}

async function fetchRemote(input, acceptedType, limit) {
  let url = await validatePublicURL(input);
  for (let redirects = 0; redirects < 4; redirects++) {
    const result = await requestRemote(url, acceptedType, limit);
    if (!('redirect' in result)) return result;
    if (!result.redirect) throw new Error('The article redirected without a destination.');
    url = await validatePublicURL(new URL(result.redirect, url).href);
  }
  throw new Error('The source redirected too many times.');
}

export async function importArticle(input) {
  const result = await fetchRemote(input, 'html', MAX_HTML_BYTES);
  return extractArticle(result.bytes.toString('utf8'), result.url);
}

export async function importImage(input) {
  return fetchRemote(input, 'image', MAX_IMAGE_BYTES);
}
