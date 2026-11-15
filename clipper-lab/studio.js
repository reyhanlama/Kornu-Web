const frame = document.querySelector('#popup-frame');
const events = document.querySelector('#events');
const canvasState = document.querySelector('#canvas-state');
const handoff = document.querySelector('#active-handoff');
const fields = {
  articleTitle: document.querySelector('#article-title'),
  articleURL: document.querySelector('#article-url'),
  siteURL: document.querySelector('#kornu-url')
};

const defaults = {
  articleTitle: 'The art of paying attention',
  articleURL: 'https://example.com/journal/the-art-of-paying-attention',
  siteURL: 'http://127.0.0.1:4174/'
};
const titles = {
  long: 'How small observations turn into ideas that stay with us long after we close the browser',
  review: 'A page that needs a closer look',
  local: 'The art of paying attention',
  permission: 'The art of paying attention',
  active: 'The art of paying attention'
};
let scenario = 'standard';
let popupHTML;
let manifest;
let pendingLoad;

function selectStage(stage) {
  for (const button of document.querySelectorAll('.stage')) {
    const selected = button.dataset.stage === stage;
    button.classList.toggle('selected', selected);
    button.setAttribute('aria-pressed', String(selected));
  }
}

function log(label) {
  if (events.firstElementChild?.textContent === 'Ready to try a scenario.') events.replaceChildren();
  const item = document.createElement('li');
  item.textContent = label;
  events.prepend(item);
  while (events.children.length > 14) events.lastElementChild.remove();
}

function resizePopup() {
  const body = frame.contentDocument?.body;
  if (!body) return;
  const contentHeight = Math.ceil(body.getBoundingClientRect().height);
  frame.style.height = `${Math.max(330, Math.min(680, contentHeight + 18))}px`;
}

function safeScriptValue(value) {
  return JSON.stringify(value).replaceAll('<', '\\u003c');
}

function loadPopup(autoPlay = false, previewStage = 'auto') {
  if (!popupHTML || !manifest) return;
  const config = { scenario, manifest, previewStage, ...Object.fromEntries(Object.entries(fields).map(([key, field]) => [key, field.value.trim()])) };
  const extensionBase = new URL('../extension/', location.href).href;
  const mockURL = new URL('mock-chrome.js', location.href).href;
  const prelude = `<base href="${extensionBase}"><script>window.__clipperPreviewConfig=${safeScriptValue(config)};<\/script><script src="${mockURL}"><\/script>`;
  const html = popupHTML.replace('<head>', `<head>${prelude}`).replace('<script src="popup.js" defer></script>', `<script src="${extensionBase}popup.js" defer></script>`);
  handoff.hidden = true;
  canvasState.textContent = 'READY';
  if (pendingLoad) frame.removeEventListener('load', pendingLoad);
  pendingLoad = () => {
    pendingLoad = null;
    resizePopup();
    const body = frame.contentDocument?.body;
    if (body) new MutationObserver(resizePopup).observe(body, { attributes: true, childList: true, subtree: true });
    if (autoPlay) frame.contentDocument?.querySelector('#save')?.click();
  };
  frame.addEventListener('load', pendingLoad, { once: true });
  frame.srcdoc = html;
}

function selectScenario(next) {
  scenario = next;
  for (const button of document.querySelectorAll('.scenario')) {
    const selected = button.dataset.scenario === scenario;
    button.classList.toggle('selected', selected);
    button.setAttribute('aria-pressed', String(selected));
  }
  fields.articleTitle.value = titles[scenario] || defaults.articleTitle;
  fields.articleURL.value = scenario === 'unsupported' ? 'chrome://settings' : defaults.articleURL;
  fields.siteURL.value = defaults.siteURL;
  events.replaceChildren();
  log(`Scenario: ${document.querySelector('.scenario.selected strong').textContent}`);
  selectStage('ready');
  loadPopup();
}

window.addEventListener('message', (event) => {
  if (event.source !== frame.contentWindow || !event.data?.kornuClipperPreview) return;
  log(event.data.label);
  if (event.data.state) canvasState.textContent = event.data.state.toUpperCase().replace('-', ' ');
  if (event.data.state === 'handoff') handoff.hidden = false;
  if (event.data.state === 'capturing') selectStage('capturing');
  else if (event.data.state === 'images') selectStage('images');
  else if (['saved', 'saved-local', 'review', 'review-local', 'permission', 'handoff'].includes(event.data.state)) selectStage('result');
});

document.querySelectorAll('.scenario').forEach((button) => button.addEventListener('click', () => selectScenario(button.dataset.scenario)));
document.querySelectorAll('.stage').forEach((button) => button.addEventListener('click', () => {
  selectStage(button.dataset.stage);
  loadPopup(button.dataset.stage !== 'ready', button.dataset.stage === 'ready' ? 'auto' : button.dataset.stage);
}));
document.querySelector('#apply').addEventListener('click', () => { log('Preview updated'); selectStage('ready'); loadPopup(); });
document.querySelector('#play').addEventListener('click', () => { selectStage('ready'); loadPopup(true); });
document.querySelector('#clear-events').addEventListener('click', () => { events.replaceChildren(); log('Event log cleared'); });

try {
  [popupHTML, manifest] = await Promise.all([
    fetch('/extension/popup.html').then((response) => response.text()),
    fetch('/extension/manifest.json').then((response) => response.json())
  ]);
  selectScenario('standard');
} catch (error) {
  log(`Preview could not load: ${error.message}`);
}
