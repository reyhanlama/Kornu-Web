const [popupHTML, manifest] = await Promise.all([
  fetch('/extension/popup.html').then((response) => response.text()),
  fetch('/extension/manifest.json').then((response) => response.json())
]);
const config = {
  scenario: 'standard', manifest, previewStage: 'auto',
  articleTitle: 'The art of paying attention',
  articleURL: 'https://example.com/journal/the-art-of-paying-attention',
  siteURL: 'https://kornu.netlify.app/'
};
const extensionBase = new URL('../extension/', location.href).href;
const mockURL = new URL('mock-chrome.js', location.href).href;
const prelude = `<base href="${extensionBase}"><script>window.__clipperPreviewConfig=${JSON.stringify(config)};<\/script><script src="${mockURL}"><\/script>`;
const html = popupHTML.replace('<head>', `<head>${prelude}`).replace('<script src="popup.js" defer></script>', `<script src="${extensionBase}popup.js" defer></script>`);
const frame = document.querySelector('#popup');
frame.addEventListener('load', () => { document.body.dataset.ready = 'true'; }, { once:true });
frame.srcdoc = html;
