const DEFAULT_SITE = 'http://127.0.0.1:4174/';
const title = document.querySelector('#page-title');
const host = document.querySelector('#page-host');
const articleContext = document.querySelector('#article-context');
const statusMark = document.querySelector('#status-mark');
const saveButton = document.querySelector('#save');
const saveLabel = document.querySelector('.save-label');
const saveSymbol = document.querySelector('.save-symbol');
const siteInput = document.querySelector('#site-url');
const siteHint = document.querySelector('#site-hint');
const message = document.querySelector('#message');
const captureSteps = document.querySelector('#capture-steps');

let articleURL = null;
let phase = 'ready';
let clipTabID = null;
let readingURL = null;
let originalTitle = 'Untitled page';

function present(heading, context = '', symbol = '', kind = '') {
  title.textContent = heading;
  articleContext.textContent = context;
  articleContext.hidden = !context;
  statusMark.textContent = symbol;
  statusMark.hidden = !symbol;
  statusMark.dataset.kind = kind;
}

function requiresActiveTab(error) {
  return /extension-created tabs must be active/i.test(error?.message || '');
}

function webURL(value) {
  let url;
  try { url = new URL(value); }
  catch { throw new Error('Enter a valid web address.'); }
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Use an http or https web address.');
  return url;
}

function sitePermission(site) {
  const origin = `${site.protocol}//${site.hostname}/*`;
  const manifest = chrome.runtime.getManifest();
  const declared = [
    ...(manifest.host_permissions || []),
    ...(manifest.optional_host_permissions || [])
  ];
  const schemePattern = `${site.protocol}//*/*`;
  if (!declared.includes(origin) && !declared.includes(schemePattern) && !declared.includes('*://*/*') && !declared.includes('<all_urls>')) {
    throw new Error('Chrome has an older Kornu Clipper manifest. Open chrome://extensions, reload Kornu Clipper, then try again.');
  }
  return origin;
}

async function ensureSiteAccess(site) {
  const permission = sitePermission(site);
  if (await chrome.permissions.contains({ origins: [permission] })) return true;
  showPermissionNeeded(true);
  try {
    return await chrome.permissions.request({ origins: [permission] });
  } catch (error) {
    if (/Only permissions specified in the manifest may be requested/i.test(error.message || '')) {
      throw new Error('Chrome is using an older Kornu Clipper manifest. Reload the extension at chrome://extensions, then try again.');
    }
    throw error;
  }
}

function showSaving(label, detail, step = 'opening') {
  phase = 'saving';
  present(originalTitle);
  saveButton.disabled = true;
  saveButton.classList.add('is-saving');
  saveButton.classList.remove('is-saved', 'is-review');
  saveLabel.textContent = label;
  message.classList.remove('is-success');
  message.classList.add('is-pending');
  message.textContent = detail;
  captureSteps.hidden = false;
  captureSteps.dataset.step = step;
  siteInput.disabled = true;
}

function showResult(result, issue = '') {
  phase = result;
  saveButton.disabled = false;
  saveButton.classList.remove('is-saving');
  saveButton.classList.toggle('is-saved', result === 'saved' || result === 'saved-local');
  saveButton.classList.toggle('is-review', result === 'review' || result === 'review-local');
  saveSymbol.textContent = '→';
  message.classList.remove('is-pending');
  message.classList.toggle('is-success', result === 'saved' || result === 'saved-local');
  captureSteps.hidden = true;
  siteInput.disabled = false;
  if (result === 'saved' || result === 'saved-local') {
    present(result === 'saved' ? 'Saved to your library.' : 'Saved on this browser.', originalTitle, '✓', 'saved');
    saveLabel.textContent = 'Open reading';
    message.textContent = result === 'saved' ? '' : 'Profile sync will retry later.';
  } else if (result === 'review' || result === 'review-local') {
    present('Needs a quick check.', originalTitle, '!', 'review');
    saveLabel.textContent = 'Review capture';
    const reason = typeof issue === 'string' && issue.trim() ? issue.trim().slice(0, 180) : 'Kornu saved the link, but the reading copy is incomplete.';
    message.textContent = result === 'review' ? reason : `${reason} Profile sync will retry later.`;
  } else {
    present('Still saving.', originalTitle, '…', 'saving');
    saveLabel.textContent = 'Open Kornu';
    message.textContent = 'Open Kornu to check the reading.';
  }
}

function showPermissionNeeded(requesting = false) {
  phase = requesting ? 'saving' : 'permission';
  present('Allow Kornu access.', originalTitle, '↗', 'permission');
  saveButton.disabled = requesting;
  saveButton.classList.remove('is-saving', 'is-saved', 'is-review');
  saveLabel.textContent = requesting ? 'Waiting for access…' : 'Allow access & save';
  saveSymbol.textContent = '→';
  siteInput.disabled = false;
  captureSteps.hidden = true;
  message.classList.remove('is-success', 'is-pending');
  message.textContent = requesting ? 'Approve your browser’s access prompt to continue.' : 'Your browser needs access to your Kornu site to confirm this save.';
}

function showHandoff() {
  phase = 'handoff';
  present('Opening in Kornu.', originalTitle, '↗', 'permission');
  saveButton.disabled = true;
  saveButton.classList.remove('is-saving', 'is-saved', 'is-review');
  saveLabel.textContent = 'Continue in Kornu';
  saveSymbol.textContent = '→';
  captureSteps.hidden = true;
  message.classList.remove('is-success');
  message.classList.add('is-pending');
  message.textContent = 'This browser finishes saving in an active Kornu tab.';
}

function showError(error, siteError = false) {
  phase = 'error';
  present(originalTitle);
  saveButton.disabled = !articleURL;
  saveButton.classList.remove('is-saving', 'is-saved', 'is-review');
  saveLabel.textContent = 'Try again';
  saveSymbol.textContent = '→';
  siteInput.disabled = false;
  message.classList.remove('is-success', 'is-pending');
  message.textContent = error.message || 'Could not save this page.';
  captureSteps.hidden = true;
  if (siteError) {
    document.querySelector('details').open = true;
    siteInput.focus();
  }
}

async function readClipState(tabID) {
  const [result] = await chrome.scripting.executeScript({
    target: { tabId: tabID },
    func: () => ({
      state: document.documentElement.dataset.kornuClipState || '',
      readingID: document.documentElement.dataset.kornuClipReadingId || '',
      issue: document.documentElement.dataset.kornuClipIssue || ''
    })
  });
  return result?.result || {};
}

async function waitForCapture(tabID) {
  const started = Date.now();
  let sawKornu = false;
  while (Date.now() - started < 45000) {
    try {
      const result = await readClipState(tabID);
      if (result.state) sawKornu = true;
      if (['saved', 'review', 'saved-local', 'review-local', 'invalid'].includes(result.state)) return result;
      if (result.state === 'capturing') showSaving('Saving article…', 'Preparing the text.', 'capturing');
      else if (result.state === 'images') showSaving('Saving images…', 'Keeping the article images with your reading.', 'images');
      else if (result.state === 'initializing') showSaving('Opening library…', 'Checking your Kornu library.', 'opening');
      else if (result.state === 'syncing') showSaving('Saving to profile…', 'Keeping your reading in your Kornu profile.', 'syncing');
    } catch { /* The background tab may still be navigating. */ }
    if (!sawKornu && Date.now() - started > 8000) return { state: 'unreachable' };
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
  return { state: 'timeout' };
}

async function initialize() {
  const settings = await chrome.storage.local.get('kornuSiteURL');
  siteInput.value = settings.kornuSiteURL || DEFAULT_SITE;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  try {
    articleURL = webURL(tab?.url).href;
    originalTitle = tab.title || 'Untitled page';
    present(originalTitle);
    host.textContent = new URL(articleURL).hostname;
    saveButton.disabled = false;
  } catch {
    present('This page cannot be clipped');
    host.textContent = 'Unsupported tab';
    message.textContent = 'Open an article page to save it.';
  }
}

siteInput.addEventListener('input', () => {
  siteHint.textContent = 'Choose where future saves open your library.';
  siteHint.classList.remove('is-error');
  if (phase === 'ready' || phase === 'error') message.textContent = '';
});
siteInput.addEventListener('change', async () => {
  try {
    const site = webURL(siteInput.value.trim());
    if (site.username || site.password) throw new Error('Remove the username and password from the Kornu address.');
    await chrome.storage.local.set({ kornuSiteURL: site.origin + site.pathname });
    siteHint.textContent = 'Destination saved for your next clip.';
    siteHint.classList.remove('is-error');
  } catch (error) {
    siteHint.textContent = error.message;
    siteHint.classList.add('is-error');
  }
});

saveButton.addEventListener('click', async () => {
  if (['saved', 'review', 'saved-local', 'review-local'].includes(phase)) {
    await chrome.tabs.create({ url: readingURL.href, active: true });
    window.close();
    return;
  }
  if (phase === 'timeout') {
    if (clipTabID) await chrome.tabs.update(clipTabID, { active: true });
    window.close();
    return;
  }
  if (!articleURL || phase === 'saving') return;

  let site;
  try {
    site = webURL(siteInput.value.trim());
    if (site.username || site.password) throw new Error('Remove the username and password from the Kornu address.');
  } catch (error) { showError(error, true); return; }

  try {
    const allowed = await ensureSiteAccess(site);
    if (!allowed) { showPermissionNeeded(); return; }

    site.search = '';
    site.hash = `/clip?url=${encodeURIComponent(articleURL)}`;
    readingURL = new URL(site.href);
    readingURL.hash = '#/library';
    showSaving('Opening library…', 'Checking your Kornu library.');
    await chrome.storage.local.set({ kornuSiteURL: site.origin + site.pathname });
    let tab;
    try {
      tab = await chrome.tabs.create({ url: site.href, active: false });
    } catch (error) {
      if (!requiresActiveTab(error)) throw error;
      showHandoff();
      await new Promise((resolve) => setTimeout(resolve, 320));
      await chrome.tabs.create({ url: site.href, active: true });
      window.close();
      return;
    }
    clipTabID = tab.id;
    const result = await waitForCapture(clipTabID);
    if (['saved', 'review', 'saved-local', 'review-local'].includes(result.state)) {
      if (result.readingID) readingURL.hash = `#/reader/${encodeURIComponent(result.readingID)}`;
      await chrome.tabs.remove(clipTabID).catch(() => {});
      clipTabID = null;
      showResult(result.state, result.issue);
    } else if (result.state === 'invalid') {
      await chrome.tabs.remove(clipTabID).catch(() => {});
      clipTabID = null;
      showError(new Error('This page does not have a valid article link.'));
    } else if (result.state === 'unreachable') {
      await chrome.tabs.remove(clipTabID).catch(() => {});
      clipTabID = null;
      showError(new Error('Could not reach Kornu. Check its web address.'), true);
    } else showResult('timeout');
  } catch (error) { showError(error); }
});

initialize().catch(() => {
  present('Could not read this tab');
  host.textContent = 'Close and reopen the extension.';
});
