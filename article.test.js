import test from 'node:test';
import assert from 'node:assert/strict';
import { extractArticle, validatePublicURL } from './article.js';

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

test('rejects incomplete pages instead of presenting a misleading reading copy', () => {
  assert.throws(() => extractArticle('<html><body><p>Short preview.</p></body></html>', 'https://example.com/essay'), /not find enough article text/);
});

test('refuses local import targets', async () => {
  await assert.rejects(() => validatePublicURL('http://127.0.0.1/private'), /cannot be imported/);
  await assert.rejects(() => validatePublicURL('http://localhost/private'), /cannot be imported/);
  await assert.rejects(() => validatePublicURL('file:///etc/passwd'), /public http or https/);
});
