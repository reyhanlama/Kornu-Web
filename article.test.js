import test from 'node:test';
import assert from 'node:assert/strict';
import { extractArticle, extractMediumFeed, validatePublicURL } from './article.js';

const paragraphOne = 'Reading slowly gives an idea space to settle before we decide what we think about it.';
const paragraphTwo = 'A good note records the exact sentence that made us pause and the question it brought to mind.';
const paragraphThree = 'When we return to the article later, the note and its passage can resume the conversation.';
const paragraphFour = 'The saved reading copy keeps these thoughts together even if the original website changes.';

test('extracts readable text and a photo from an article while removing script content', () => {
  const html = `<html><head><meta name="description" content="A quiet essay"></head><body><article><h1>Thinking &amp; Reading</h1><script>unwanted words</script><p>${paragraphOne}</p><figure><img src="/photo.jpg" alt="A reading desk"><figcaption>After the first passage</figcaption></figure><p>${paragraphTwo}</p><p>${paragraphThree}</p><p>${paragraphFour}</p></article></body></html>`;
  const article = extractArticle(html, 'https://example.com/essay');
  assert.equal(article.title, 'Thinking & Reading');
  assert.equal(article.subtitle, 'A quiet essay');
  assert.equal(article.paragraphs.length, 4);
  assert.equal(article.paragraphs.join(' ').includes('unwanted'), false);
  assert.deepEqual(article.images[0], { url: 'https://example.com/photo.jpg', caption: 'After the first passage', afterParagraph: 0 });
});

test('keeps commas inside responsive image URLs', () => {
  const small = 'https://substackcdn.com/image/fetch/w_424,c_limit/https%3A%2F%2Fexample.com%2Fphoto.png';
  const large = 'https://substackcdn.com/image/fetch/w_848,c_limit/https%3A%2F%2Fexample.com%2Fphoto.png';
  const html = `<html><body><article><h1>A pictured essay</h1><p>${paragraphOne}</p><figure><img src="${small}" srcset="${small} 424w, ${large} 848w" alt="The picture"></figure><p>${paragraphTwo}</p><p>${paragraphThree}</p><p>${paragraphFour}</p></article></body></html>`;
  const article = extractArticle(html, 'https://example.com/essay');
  assert.equal(article.images[0].url, large);
});

test('preserves article structure and safe inline formatting', () => {
  const long = 'The reading copy should retain the structure of an article while giving every idea enough space for a careful response. ';
  const html = `<html><head><title>Structured article</title></head><body><article><h1>Structured article</h1><p>${long.repeat(3)}</p><h2>A second section</h2><p>Here is <strong>important language</strong> with <em>emphasis</em>, an <a href="https://example.com/source">original source</a>, and a <a href="javascript:alert(1)">bad link</a>.</p><ul><li>First point with enough detail to read carefully.</li><li>Second point that matters to the argument.</li></ul><blockquote><p>A quoted observation to return to later.</p></blockquote><table><tr><th>Item</th><th>Value</th></tr><tr><td>One</td><td>Two</td></tr></table><p>${long.repeat(3)}</p></article></body></html>`;
  const article = extractArticle(html, 'https://example.com/structured');
  assert.equal(article.title, 'Structured article');
  assert.deepEqual(article.blocks.map((block) => block.kind), ['paragraph', 'heading', 'paragraph', 'list-item', 'list-item', 'quote', 'table', 'paragraph']);
  assert.match(article.blocks[2].html, /<strong>important language<\/strong>/);
  assert.match(article.blocks[2].html, /<em>emphasis<\/em>/);
  assert.match(article.blocks[2].html, /href="https:\/\/example.com\/source"/);
  assert.doesNotMatch(article.blocks[2].html, /javascript:/);
  assert.equal(article.blocks[6].rows[1][1].text, 'Two');
});

test('rejects incomplete pages instead of presenting a misleading reading copy', () => {
  assert.throws(() => extractArticle('<html><body><p>Short preview.</p></body></html>', 'https://example.com/essay'), /not find enough article text/);
});

test('uses a matching full Medium RSS entry and removes its feed footer', () => {
  const url = 'https://medium.com/blog/a-full-story-13a9ef77962b';
  const content = `<p>${paragraphOne.repeat(15)}</p><p>${paragraphTwo.repeat(15)}</p><figure><img src="https://cdn-images-1.medium.com/photo.jpg" alt="Notebook"></figure><p>${paragraphThree.repeat(15)}</p><p>${paragraphFour.repeat(15)}</p><hr><p>This was originally published on Medium.</p>`;
  const feed = `<rss xmlns:content="http://purl.org/rss/1.0/modules/content/" xmlns:dc="http://purl.org/dc/elements/1.1/"><channel><item><title>A full story</title><link>${url}?source=rss</link><dc:creator>Medium Writer</dc:creator><content:encoded><![CDATA[${content}]]></content:encoded></item></channel></rss>`;
  const article = extractMediumFeed(feed, url);
  assert.equal(article.title, 'A full story');
  assert.equal(article.byline, 'Medium Writer');
  assert.equal(article.images[0].url, 'https://cdn-images-1.medium.com/photo.jpg');
  assert.equal(article.paragraphs.some((paragraph) => paragraph.includes('originally published')), false);
  assert.equal(extractMediumFeed(feed, 'https://medium.com/blog/another-story-aabbccddeeff'), null);
});

test('refuses local import targets', async () => {
  await assert.rejects(() => validatePublicURL('http://127.0.0.1/private'), /cannot be imported/);
  await assert.rejects(() => validatePublicURL('http://localhost/private'), /cannot be imported/);
  await assert.rejects(() => validatePublicURL('file:///etc/passwd'), /public http or https/);
});
