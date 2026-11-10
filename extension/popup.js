const DEFAULT_SITE = 'http://127.0.0.1:4174/';
const title = document.querySelector('#page-title');
const host = document.querySelector('#page-host');
const saveButton = document.querySelector('#save');
const saveLabel = document.querySelector('.save-label');
const saveSymbol = document.querySelector('.save-symbol');
const siteInput = document.querySelector('#site-url');
const siteName = document.querySelector('#site-name');
const message = document.querySelector('#message');

let articleURL = null;
let phase = 'ready';
let clipTabID = null;
let readingURL = null;

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
  try {
    return await chrome.permissions.request({ origins: [permission] });
  } catch (error) {
    if (/Only permissions specified in the manifest may be requested/i.test(error.message || '')) {
      throw new Error('Chrome is using an older Kornu Clipper manifest. Reload the extension at chrome://extensions, then try again.');
    }
    throw error;
  }
}

function updateDestination() {
  try { siteName.textContent = webURL(siteInput.value.trim()).host; }
  catch { siteName.textContent = 'Choose a site'; }
}

function showSaving(label, detail) {
  phase = 'saving';
  saveButton.disabled = true;
  saveButton.classList.add('is-saving');
  saveButton.classList.remove('is-saved');
  saveLabel.textContent = label;
  message.classList.remove('is-success');
  message.textContent = detail;
  siteInput.disabled = true;
}

function showResult(result) {
  phase = result;
  saveButton.disabled = false;
  saveButton.classList.remove('is-saving');
  saveButton.classList.toggle('is-saved', result === 'saved' || result === 'saved-local');
  saveSymbol.textContent = '↗';
  message.classList.toggle('is-success', result === 'saved' || result === 'saved-local');
  if (result === 'saved' || result === 'saved-local') {
    saveLabel.textContent = 'Open reading';
    message.textContent = result === 'saved' ? 'Saved to your Kornu library.' : 'Saved here. Profile sync will retry later.';
  } else if (result === 'review' || result === 'review-local') {
    saveLabel.textContent = 'Review in Kornu';
    message.textContent = result === 'review' ? 'Link saved. The article needs a closer look.' : 'Link saved here; profile sync will retry later.';
  } else {
    saveLabel.textContent = 'Open Kornu';
    message.textContent = 'Kornu is still working. Open it to check.';
  }
}

function showError(error, siteError = false) {
  phase = 'ready';
  saveButton.disabled = !articleURL;
  saveButton.classList.remove('is-saving', 'is-saved');
  saveLabel.textContent = 'Save to Kornu';
  saveSymbol.textContent = '↗';
  siteInput.disabled = false;
  message.classList.remove('is-success');
  message.textContent = error.message || 'Could not save this page.';
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
      readingID: document.documentElement.dataset.kornuClipReadingId || ''
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
      if (result.state === 'capturing') showSaving('Saving article…', 'Preparing the text.');
      else if (result.state === 'images') showSaving('Saving images…', 'Keeping the article images with your reading.');
      else if (result.state === 'initializing') showSaving('Opening library…', 'Checking your Kornu library.');
      else if (result.state === 'syncing') showSaving('Saving to profile…', 'Keeping your reading in your Kornu profile.');
    } catch { /* The background tab may still be navigating. */ }
    if (!sawKornu && Date.now() - started > 8000) return { state: 'unreachable' };
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
  return { state: 'timeout' };
}

async function initialize() {
  const settings = await chrome.storage.local.get('kornuSiteURL');
  siteInput.value = settings.kornuSiteURL || DEFAULT_SITE;
  updateDestination();
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  try {
    articleURL = webURL(tab?.url).href;
    title.textContent = tab.title || 'Untitled page';
    host.textContent = new URL(articleURL).hostname;
    saveButton.disabled = false;
  } catch {
    title.textContent = 'This page cannot be clipped';
    host.textContent = 'Open a regular article page and try again.';
  }
}

siteInput.addEventListener('input', () => { updateDestination(); message.textContent = ''; });

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
    if (!allowed) throw new Error('Allow access to your Kornu site to save without leaving this page.');

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
      showSaving('Opening Kornu…', 'This browser opens the reading in an active tab to finish saving.');
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
      showResult(result.state);
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
  title.textContent = 'Could not read this tab';
  host.textContent = 'Close and reopen the extension.';
});
