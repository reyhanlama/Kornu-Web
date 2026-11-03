import dns from 'node:dns/promises';
import net from 'node:net';

const MAX_BYTES = 5_000_000;

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

const decodeEntities = (value) => value
  .replace(/&#(x[0-9a-f]+|\d+);/gi, (_, raw) => {
    const number = raw[0].toLowerCase() === 'x' ? parseInt(raw.slice(1), 16) : Number(raw);
    return Number.isFinite(number) && number >= 0 && number <= 0x10ffff ? String.fromCodePoint(number) : '';
  })
  .replace(/&(?:nbsp|amp|quot|apos|lt|gt|ldquo|rdquo|lsquo|rsquo|mdash|ndash|hellip);/gi, (entity) => ({
    '&nbsp;': ' ', '&amp;': '&', '&quot;': '"', '&apos;': "'", '&lt;': '<', '&gt;': '>',
    '&ldquo;': '“', '&rdquo;': '”', '&lsquo;': '‘', '&rsquo;': '’', '&mdash;': '—',
    '&ndash;': '–', '&hellip;': '…'
  })[entity.toLowerCase()] ?? entity);

function plain(value) {
  return decodeEntities(value.replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').replace(/\s+([,.;:!?])/g, '$1').trim();
}

function first(html, pattern) { return html.match(pattern)?.[1] ?? ''; }
function attr(tag, name) { return first(tag, new RegExp(`\\b${name}\\s*=\\s*["']([^"']*)["']`, 'i')); }
function meta(html, key) {
  for (const tag of html.match(/<meta\b[^>]*>/gi) ?? []) {
    if ((attr(tag, 'property') || attr(tag, 'name')).toLowerCase() === key) return plain(attr(tag, 'content'));
  }
  return '';
}

export function extractArticle(html, urlString) {
  const url = new URL(urlString);
  const source = url.hostname.replace(/^www\./, '');
  const sections = [...html.matchAll(/<(article|main)\b[^>]*>([\s\S]*?)<\/\1>/gi)]
    .map((match) => match[2]).sort((a, b) => b.length - a.length);
  let content = sections[0] || first(html, /<body\b[^>]*>([\s\S]*?)<\/body>/i) || html;
  const title = plain(first(content, /<h1\b[^>]*>([\s\S]*?)<\/h1>/i) ||
    meta(html, 'og:title') || first(html, /<title\b[^>]*>([\s\S]*?)<\/title>/i) || source);
  const subtitle = meta(html, 'description') || meta(html, 'og:description');
  content = content.replace(/<(script|style|nav|header|footer|aside|form|noscript|svg)\b[^>]*>[\s\S]*?<\/\1>/gi, '');
  if (source.includes('wikipedia.org')) content = content.replace(/<sup\b[^>]*>[\s\S]*?<\/sup>/gi, '');
  const paragraphs = [];
  const images = [];
  const seen = new Set();
  for (const match of content.matchAll(/<figure\b[^>]*>[\s\S]*?<\/figure>|<p\b[^>]*>[\s\S]*?<\/p>|<img\b[^>]*>/gi)) {
    const block = match[0];
    if (/^<p\b/i.test(block)) {
      const text = plain(block);
      if (text.length >= 40) paragraphs.push(text);
      continue;
    }
    const tag = block.match(/<img\b[^>]*>/i)?.[0];
    if (!tag) continue;
    const srcset = attr(tag, 'data-srcset') || attr(tag, 'srcset');
    const raw = (srcset?.split(',').at(-1)?.trim().split(/\s+/)[0]) || attr(tag, 'data-src') || attr(tag, 'src');
    if (!raw || raw.startsWith('data:') || (Number(attr(tag, 'width')) > 0 && Number(attr(tag, 'width')) < 160)) continue;
    let imageURL;
    try { imageURL = new URL(decodeEntities(raw), url); } catch { continue; }
    if (!['http:', 'https:'].includes(imageURL.protocol) || /\.(svg)(?:\?|$)/i.test(imageURL.pathname) ||
        /avatar|logo|icon|pixel|tracking|padlock/i.test(imageURL.href) || seen.has(imageURL.href)) continue;
    seen.add(imageURL.href);
    images.push({ url: imageURL.href, caption: plain(first(block, /<figcaption\b[^>]*>([\s\S]*?)<\/figcaption>/i) || attr(tag, 'alt')), afterParagraph: paragraphs.length - 1 });
  }
  if (paragraphs.length < 2 || paragraphs.join('').length < 280) {
    throw new Error('Kornu could not find enough article text on this page. Open the original instead.');
  }
  const words = paragraphs.join(' ').split(/\s+/).length;
  const warning = source.includes('medium.com') && words < 700 && /(?:…|\.\.\.)$/.test(paragraphs.at(-1))
    ? 'Only an opening preview was available. Open the original story for the rest.' : null;
  return { title, source, subtitle, paragraphs, images: images.slice(0, 24), warning, url: url.href };
}

export async function importArticle(input) {
  let url = await validatePublicURL(input);
  for (let redirects = 0; redirects < 4; redirects++) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 20000);
    let response;
    try {
      response = await fetch(url, {
        redirect: 'manual', signal: controller.signal,
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; KornuReader/0.1)', Accept: 'text/html,application/xhtml+xml' }
      });
    } finally { clearTimeout(timeout); }
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get('location');
      if (!location) throw new Error('The article redirected without a destination.');
      url = await validatePublicURL(new URL(location, url).href);
      continue;
    }
    if (!response.ok) throw new Error(`The page returned ${response.status}.`);
    if (!/html/i.test(response.headers.get('content-type') || '')) throw new Error('This link is not an HTML article.');
    const chunks = [];
    let size = 0;
    for await (const chunk of response.body) {
      size += chunk.byteLength;
      if (size > MAX_BYTES) { await response.body.cancel().catch(() => {}); throw new Error('This page is too large to import.'); }
      chunks.push(chunk);
    }
    return extractArticle(Buffer.concat(chunks).toString('utf8'), url.href);
  }
  throw new Error('The article redirected too many times.');
}
