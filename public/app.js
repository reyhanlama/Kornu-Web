import { putSnapshot, getSnapshot, putAsset, getAsset, putBook, getBook, getAllSnapshotEntries, getAllAssets } from './storage.js';
import { cloud } from './cloud.js';
import { inspectBook, openBook } from './book.js';

const STORE_KEY = 'kornu.web.v1';
const accountStoreKey = (id) => `${STORE_KEY}.account.${id}`;
const dirtyStoreKey = (id) => `${STORE_KEY}.pending.${id}`;
const uploadedStoreKey = (id) => `${STORE_KEY}.uploaded.${id}`;
const markNames = { highlight: 'Highlight', underline: 'Underline', note: 'Note' };
const sampleReadings = [
  {
    id: 'sample-noticing', title: 'The Practice of Noticing', source: 'Kornu sample',
    subtitle: 'A small field guide to paying attention', url: 'https://example.com/kornu/noticing',
    status: 'ready', savedAt: new Date().toISOString(),
    paragraphs: [
      'There is a kind of attention that asks nothing of us except that we stay a little longer. We look again at the room, the street, the familiar face, and something ordinary begins to acquire its own shape.',
      'A notebook can hold these moments before they disappear. Not because each one is important, but because writing it down gives us permission to notice what we might otherwise pass by.',
      'At first, the record is modest: a line of light across the table, a sentence overheard on the train, a question that arrives while walking home. Over time, the fragments begin to speak to one another.',
      'The page makes a little room between an experience and the next thing we need to do. In that room, thought has time to arrive.',
      'Paying attention is not a way to collect more. It is a way to be more fully present with what is already here.'
    ],
    images: [{ url: '/editorial.png', caption: 'A place to pause and look again.', afterParagraph: 1 }]
  },
  {
    id: 'sample-room', title: 'A Room for Thought', source: 'Kornu sample',
    subtitle: 'On reading slowly and leaving a mark', url: 'https://example.com/kornu/room-for-thought',
    status: 'ready', savedAt: new Date(Date.now() - 86400000).toISOString(),
    paragraphs: [
      'Reading is often treated as something to finish. Yet the most useful pages may be the ones that interrupt us, asking for a note in the margin or a moment of quiet before we continue.',
      'A mark is a record of meeting an idea. It tells a future reader where we paused, what seemed strange, and what we wanted to remember.',
      'When we return, the page is no longer quite the same. It carries the first reading alongside the second, and our earlier questions become part of the conversation.'
    ], images: []
  }
];

const readStore = (key = STORE_KEY) => {
  try {
    const saved = JSON.parse(localStorage.getItem(key));
    if (saved && Array.isArray(saved.readings) && Array.isArray(saved.marks)) {
      saved.readings.forEach((item) => {
        if (item.status === 'preparing') {
          item.status = 'needsReview';
          item.issue = 'Capture was interrupted. Try again to prepare this reading.';
        }
      });
      return saved;
    }
  } catch { /* Start clean if browser storage is unavailable or malformed. */ }
  return { readings: sampleReadings, marks: [], articleNotes: {}, progress: {} };
};
let store = readStore();
let activeStoreKey = STORE_KEY;
let account = null;
let cloudStatus = 'Saved in this browser';
let dirtyReadings = new Set();
let uploadedAssets = new Set();
let syncTimer;
let syncing = false;
let accountGeneration = 0;
const changeVersions = new Map();
let view = location.hash.match(/^#\/(inbox|library|marks|reader)/)?.[1] || 'library';
let readerID = location.hash.match(/^#\/reader\/([^/]+)/)?.[1] || null;
let search = '';
let filter = 'all';
let showReaderMarks = false;
let selection = null;
let openNoteID = null;
let toastTimer;
let progressTimer;
let lastRenderedReader = null;
let openInitialReaderAtTop = false;
let activeBookView = null;
let bookMountToken = 0;
const loadingSnapshots = new Set();
const assetURLs = new Map();
const snapshotCacheKey = (id) => account ? `account:${account.id}:snapshot:${id}` : id;
const assetCacheKey = (key) => account ? `account:${account.id}:asset:${key}` : key;
const localSnapshot = (id) => getSnapshot(snapshotCacheKey(id));
const writeSnapshot = (id, snapshot) => putSnapshot(snapshotCacheKey(id), snapshot);
const localAsset = (key) => getAsset(assetCacheKey(key));
const writeAsset = (key, blob) => putAsset(assetCacheKey(key), blob);
const bookCacheKey = (id) => account ? `account:${account.id}:book:${id}` : id;
const localBook = (id) => getBook(bookCacheKey(id));
const writeBook = (id, blob) => putBook(bookCacheKey(id), blob);

const $ = (selector, root = document) => root.querySelector(selector);
const esc = (value = '') => String(value).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
const compactItem = (item) => {
  if (!item.snapshotStored) return item;
  const { blocks, paragraphs, images, ...metadata } = item;
  return metadata;
};
const compactStore = () => ({ ...store, readings: store.readings.map(compactItem) });
const persistStore = () => { try { localStorage.setItem(activeStoreKey, JSON.stringify(compactStore())); } catch { notify('Browser storage is full. Export a backup from the menu.'); } };
const save = (readingID = null) => {
  persistStore();
  if (account && readingID) {
    dirtyReadings.add(readingID);
    changeVersions.set(readingID, (changeVersions.get(readingID) || 0) + 1);
    persistPending();
    scheduleCloudSync();
  }
};
const uid = () => crypto.randomUUID();
const reading = () => store.readings.find((item) => item.id === readerID);
// Book support is paused in this web preview. Preserve saved books for a later release.
const visibleReadings = () => store.readings.filter((item) => item.kind !== 'book');
const marksFor = (id) => store.marks.filter((mark) => mark.readingID === id).sort((a, b) => a.paragraphIndex - b.paragraphIndex || a.start - b.start);
const wordCount = (item) => item.wordCount || item.paragraphs?.join(' ').trim().split(/\s+/).length || 0;
const minutes = (item) => Math.max(1, Math.ceil(wordCount(item) / 220));
const day = (value) => new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' }).format(new Date(value));
const featureSource = (item) => item.coverAssetKey ? assetURLs.get(item.coverAssetKey) || null : item.kind === 'book' ? null : item.images?.[0]?.url || null;
const notify = (message) => {
  const toast = $('#toast'); toast.textContent = message; toast.classList.add('visible');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => toast.classList.remove('visible'), 3200);
};
const icon = (name, size = 18) => {
  const paths = {
    plus: '<path d="M12 5v14M5 12h14"/>', search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-4-4"/>',
    tray: '<path d="M3 4h18v15H3zM3 14h5l2 3h4l2-3h5"/>', book: '<path d="M4 4.5c3-1 6-.6 8 1.1 2-1.7 5-2.1 8-1.1V20c-3-1-6-.6-8 1-2-1.6-5-2-8-1zM12 5.6V21"/>',
    mark: '<path d="M6 3h12v18l-6-4-6 4z"/>', arrow: '<path d="m5 12 14 0m-6-6 6 6-6 6"/>',
    back: '<path d="m14 5-7 7 7 7"/>', external: '<path d="M13 4h7v7M20 4l-10 10M19 14v6H4V5h6"/>',
    dots: '<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>',
    close: '<path d="M5 5l14 14M19 5 5 19"/>', check: '<path d="m4 12 5 5L20 6"/>',
    quote: '<path d="M4 5h7v7H7l-2 5M14 5h7v7h-4l-2 5"/>',
    download: '<path d="M12 3v13m-5-5 5 5 5-5M4 19h16"/>',
    account: '<circle cx="12" cy="8" r="4"/><path d="M4 21c0-4 3-7 8-7s8 3 8 7"/>'
  };
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name] || ''}</svg>`;
};

function route(next, id) {
  if (next === 'library' && matchMedia('(min-width: 1251px)').matches) {
    const selected = visibleReadings().find((item) => item.id === readerID && item.status === 'ready')
      || visibleReadings().find((item) => item.status === 'ready');
    if (selected) { route('reader', selected.id); return; }
  }
  const destination = next === 'reader' ? `#/reader/${id}` : `#/${next}`;
  if (location.hash === destination) render();
  else location.hash = destination;
}

function navItem(area, label, symbol) {
  return `<button class="nav-item ${view === area || (view === 'reader' && area === 'library') ? 'active' : ''}" data-route="${area}">${icon(symbol)}<span>${label}</span>${area === 'inbox' && visibleReadings().some((item) => item.status !== 'ready') ? '<i class="nav-dot"></i>' : ''}</button>`;
}

function shell(content, title, kicker = '') {
  const accountName = account?.user_metadata?.full_name || account?.email || 'Your account';
  const split = view === 'library' || view === 'reader';
  const main = split ? `<div class="split-workspace"><aside class="split-library"><div class="split-library-head"><button class="top-brand" data-route="library" aria-label="Kornu library"><img src="/wordmark.svg" alt="Kornu"></button><nav class="split-nav" aria-label="Primary">${navItem('library', 'Library', 'book')}${navItem('marks', 'Marks & Notes', 'mark')}${navItem('inbox', 'Inbox', 'tray')}</nav><details class="topbar-more"><summary aria-label="More options">${icon('dots', 20)}</summary><div class="more-panel"><div class="more-status" data-cloud-status>${esc(account ? cloudStatus : 'Saved in this browser')}</div><button data-action="account">${icon('account', 17)} ${esc(account ? accountName : 'Sign in with Google')}</button><button data-action="backup">${icon('download', 17)} Export backup</button></div></details></div>${libraryPanel()}</aside><section class="split-reading">${content}</section></div>` : content;
  return `<div class="app-shell view-${view}">
    <header class="topbar"><button class="top-brand" data-route="library" aria-label="Kornu library"><img src="/wordmark.svg" alt="Kornu"></button>
      <nav class="top-nav" aria-label="Primary">${navItem('library', 'Library', 'book')}${navItem('marks', 'Marks & Notes', 'mark')}${navItem('inbox', 'Inbox', 'tray')}</nav>
      <div class="topbar-actions">${view === 'reader' ? '' : `<button class="primary-button" data-action="add" aria-label="Add a reading">${icon('plus', 17)}<span>Add a reading</span></button>`}
        <details class="topbar-more"><summary aria-label="More options">${icon('dots', 20)}<span>More</span></summary><div class="more-panel"><div class="more-status" data-cloud-status>${esc(account ? cloudStatus : 'Saved in this browser')}</div><button data-action="account" aria-label="${esc(account ? `Account: ${accountName}` : 'Sign in with Google')}">${icon('account', 17)} ${esc(account ? accountName : 'Sign in with Google')}</button><button data-action="backup" aria-label="Export backup">${icon('download', 17)} Export backup</button></div></details>
      </div></header>
    <div class="workspace"><main class="main-content">${main}</main></div>
    <nav class="mobile-nav" aria-label="Primary mobile">${navItem('library', 'Library', 'book')}${navItem('inbox', 'Inbox', 'tray')}${navItem('marks', 'Marks', 'mark')}</nav>
  </div>`;
}

function loadSet(key) {
  try { return new Set(JSON.parse(localStorage.getItem(key) || '[]')); }
  catch { return new Set(); }
}

function setCloudStatus(message) {
  cloudStatus = message;
  document.querySelectorAll('[data-cloud-status]').forEach((element) => { element.textContent = message; });
}

function persistPending() {
  if (account) localStorage.setItem(dirtyStoreKey(account.id), JSON.stringify([...dirtyReadings]));
}

function persistUploaded() {
  if (account) localStorage.setItem(uploadedStoreKey(account.id), JSON.stringify([...uploadedAssets]));
}

function scheduleCloudSync(delay = 1400) {
  if (!account) return;
  setCloudStatus('Saving to your profile…');
  clearTimeout(syncTimer);
  syncTimer = setTimeout(flushCloudSync, delay);
}

async function flushCloudSync() {
  if (!account || syncing) return;
  syncing = true;
  const userID = account.id;
  try {
    while (account?.id === userID && dirtyReadings.size) {
      const readingID = dirtyReadings.values().next().value;
      const item = store.readings.find((entry) => entry.id === readingID);
      if (!item) { dirtyReadings.delete(readingID); persistPending(); continue; }
      if (item.status === 'preparing') break;
      const version = changeVersions.get(readingID) || 0;
      const snapshot = item.snapshotStored ? await localSnapshot(readingID) : null;
      if (account?.id !== userID) return;
      if (item.snapshotStored && !snapshot) throw new Error('A saved article copy is missing on this browser.');
      const keys = [...new Set([...((snapshot?.blocks || []).map((block) => block.assetKey)), item.coverAssetKey].filter(Boolean))];
      for (const key of keys) {
        if (uploadedAssets.has(key)) continue;
        const blob = await localAsset(key);
        if (account?.id !== userID) return;
        if (!blob) continue;
        await cloud.uploadAsset(userID, key, blob);
        uploadedAssets.add(key);
        persistUploaded();
      }
      if (item.kind === 'book' && !uploadedAssets.has(`${readingID}:book`)) {
        const file = await localBook(readingID);
        if (account?.id !== userID) return;
        if (!file) throw new Error('A saved book file is missing on this browser.');
        await cloud.uploadBook(userID, readingID, file);
        uploadedAssets.add(`${readingID}:book`);
        persistUploaded();
      }
      await cloud.saveReading(userID, readingID, {
        item: compactItem(item), snapshot,
        marks: marksFor(readingID), progress: store.progress[readingID] || 0,
        articleNote: store.articleNotes[readingID] || ''
      });
      if (account?.id !== userID) return;
      if ((changeVersions.get(readingID) || 0) === version) {
        dirtyReadings.delete(readingID);
        persistPending();
      }
    }
    if (account?.id === userID) setCloudStatus(dirtyReadings.size ? 'Saved here; waiting to sync' : 'Saved to your profile');
  } catch (error) {
    if (account?.id === userID) {
      setCloudStatus('Saved here; cloud sync paused');
      notify(error.message || 'Cloud sync is unavailable right now.');
    }
  } finally {
    syncing = false;
    if (account?.id !== userID && dirtyReadings.size) scheduleCloudSync(0);
  }
}

async function savedAsset(key) {
  const userID = account?.id;
  let blob = await localAsset(key);
  if (!blob && userID && account?.id === userID) {
    blob = await cloud.downloadAsset(userID, key);
    await putAsset(`account:${userID}:asset:${key}`, blob);
  }
  return blob;
}

async function savedBook(id) {
  const userID = account?.id;
  let file = await localBook(id);
  if (!file && userID && account?.id === userID) {
    file = await cloud.downloadBook(userID, id);
    await putBook(`account:${userID}:book:${id}`, file);
  }
  return file;
}

async function loadProfile(userID, generation) {
  setCloudStatus('Loading your profile…');
  try {
    const rows = await cloud.readings();
    if (account?.id !== userID || generation !== accountGeneration) return;
    const remoteIDs = new Set();
    for (const row of rows) {
      const data = row.data;
      if (!data?.item || data.item.id !== row.reading_id) continue;
      remoteIDs.add(row.reading_id);
      if (dirtyReadings.has(row.reading_id)) continue;
      const position = store.readings.findIndex((item) => item.id === row.reading_id);
      if (position >= 0) store.readings[position] = data.item;
      else store.readings.unshift(data.item);
      store.marks = store.marks.filter((mark) => mark.readingID !== row.reading_id).concat(data.marks || []);
      store.progress[row.reading_id] = data.progress || 0;
      store.articleNotes[row.reading_id] = data.articleNote || '';
      if (data.snapshot) await putSnapshot(`account:${userID}:snapshot:${row.reading_id}`, data.snapshot);
      if (account?.id !== userID || generation !== accountGeneration) return;
    }
    store.readings = store.readings.filter((item) => item.source === 'Kornu sample' || remoteIDs.has(item.id) || dirtyReadings.has(item.id));
    persistStore();
    render();
    preloadCovers();
    if (dirtyReadings.size) scheduleCloudSync(0);
    else setCloudStatus('Saved to your profile');
  } catch (error) {
    if (account?.id === userID) {
      setCloudStatus('Saved here; cloud sync paused');
      notify(error.message || 'Your profile could not be loaded.');
    }
  }
}

function switchAccount(user) {
  if (account?.id === user?.id) return;
  const generation = ++accountGeneration;
  clearTimeout(syncTimer);
  for (const url of assetURLs.values()) URL.revokeObjectURL(url);
  assetURLs.clear();
  account = user;
  activeStoreKey = user ? accountStoreKey(user.id) : STORE_KEY;
  store = readStore(activeStoreKey);
  dirtyReadings = user ? loadSet(dirtyStoreKey(user.id)) : new Set();
  uploadedAssets = user ? loadSet(uploadedStoreKey(user.id)) : new Set();
  changeVersions.clear();
  cloudStatus = user ? 'Loading your profile…' : 'Saved in this browser';
  view = 'library'; readerID = null;
  location.hash = '#/library';
  render();
  preloadCovers();
  if (user) loadProfile(user.id, generation);
}

function hasGuestLibrary() {
  const guest = readStore(STORE_KEY);
  return guest.readings.some((item) => item.source !== 'Kornu sample') || guest.marks.length ||
    Object.keys(guest.articleNotes || {}).length || Object.keys(guest.progress || {}).length;
}

function accountModal() {
  if (!cloud.configured) {
    showModal(`<div class="modal-overline">KORNU ACCOUNT</div><button class="modal-close" data-action="close-modal" aria-label="Close">${icon('close')}</button><h2>Make this space yours.</h2><p>Google sign-in needs a Kornu cloud project. The app is ready to connect once its Supabase URL, publishable key, and Google provider are set up.</p><div class="modal-actions"><button class="primary-button" data-action="close-modal">Keep reading here</button></div>`);
    return;
  }
  if (!account) {
    showModal(`<div class="modal-overline">KORNU ACCOUNT</div><button class="modal-close" data-action="close-modal" aria-label="Close">${icon('close')}</button><h2>Take your readings with you.</h2><p>Sign in to save articles, images, highlights, notes, and reading progress to your private profile.</p><div class="modal-actions"><button class="outline-button" data-action="close-modal">Not now</button><button class="primary-button" data-action="sign-in-google">Continue with Google ${icon('arrow', 16)}</button></div><div class="modal-footnote">Your current browser library stays here until you choose to copy it into your profile.</div>`);
    return;
  }
  showModal(`<div class="modal-overline">YOUR KORNU ACCOUNT</div><button class="modal-close" data-action="close-modal" aria-label="Close">${icon('close')}</button><h2>Your reading space.</h2><p>${esc(account.email || 'Signed in with Google')}</p><p class="account-modal-status">${esc(cloudStatus)}</p>${hasGuestLibrary() ? `<button class="outline-button account-import-button" data-action="copy-browser-library">Copy this browser's library into my profile</button>` : ''}<div class="modal-actions"><button class="outline-button" data-action="sign-out">Sign out</button><button class="primary-button" data-action="close-modal">Done</button></div>`);
}

async function copyBrowserLibrary() {
  if (!account) return;
  const profileID = account.id;
  const guest = readStore(STORE_KEY);
  const changed = new Set();
  const existing = new Set(store.readings.map((item) => item.id));
  for (const item of guest.readings) {
    if (!existing.has(item.id)) { store.readings.push(item); existing.add(item.id); changed.add(item.id); }
  }
  const markIDs = new Set(store.marks.map((mark) => mark.id));
  for (const mark of guest.marks) {
    if (existing.has(mark.readingID) && !markIDs.has(mark.id)) { store.marks.push(mark); markIDs.add(mark.id); changed.add(mark.readingID); }
  }
  for (const [id, note] of Object.entries(guest.articleNotes || {})) {
    if (existing.has(id) && note && !store.articleNotes[id]) { store.articleNotes[id] = note; changed.add(id); }
  }
  for (const [id, progress] of Object.entries(guest.progress || {})) {
    if (existing.has(id) && progress > (store.progress[id] || 0)) { store.progress[id] = progress; changed.add(id); }
  }
  persistStore();
  for (const id of changed) {
    dirtyReadings.add(id);
    changeVersions.set(id, (changeVersions.get(id) || 0) + 1);
  }
  persistPending();
  try {
    for (const id of changed) {
      const guestItem = guest.readings.find((item) => item.id === id);
      if (guestItem?.kind === 'book') {
        const file = await getBook(id);
        if (file) await putBook(`account:${profileID}:book:${id}`, file);
        if (guestItem.coverAssetKey) {
          const cover = await getAsset(guestItem.coverAssetKey);
          if (cover) await putAsset(`account:${profileID}:asset:${guestItem.coverAssetKey}`, cover);
        }
      }
      const snapshot = await getSnapshot(id);
      if (!snapshot) continue;
      await putSnapshot(`account:${profileID}:snapshot:${id}`, snapshot);
      for (const key of [...new Set((snapshot.blocks || []).map((block) => block.assetKey).filter(Boolean))]) {
        const blob = await getAsset(key);
        if (blob) await putAsset(`account:${profileID}:asset:${key}`, blob);
      }
    }
  } catch (error) { notify(error.message || 'This browser copy could not be prepared.'); return; }
  if (account?.id !== profileID) return;
  closeModal(); render();
  if (changed.size) scheduleCloudSync(0);
  notify(changed.size ? 'Copying your browser library to your profile…' : 'Your profile already has these readings.');
}

function searchBar(placeholder = 'Search your readings') {
  return `<label class="search-field">${icon('search', 18)}<input id="library-search" type="search" placeholder="${esc(placeholder)}" value="${esc(search)}" autocomplete="off"><span>⌘ K</span></label>`;
}

function readingRow(item, index = 0) {
  const progress = store.progress[item.id] || 0;
  const count = marksFor(item.id).length;
  const status = item.status === 'ready' ? progress >= 100 ? 'Finished' : progress > 0 ? 'In progress' : 'Not started' : item.status === 'preparing' ? 'Preparing…' : 'Needs review';
  return `<button class="reading-row ${item.id === readerID ? 'selected' : ''}" data-open="${esc(item.id)}"><span class="row-index">${String(index + 1).padStart(2, '0')}</span><span class="row-main"><strong>${esc(item.title)}</strong><span class="row-source">${esc(item.source)}</span><span class="row-detail">${esc(item.subtitle || 'Saved to your reading space')}</span></span><span class="row-meta"><span class="status-pill">${status}</span>${count ? `<small>${count} mark${count === 1 ? '' : 's'}</small>` : ''}</span><span class="row-arrow">${icon('arrow', 19)}</span></button>`;
}

function abstractCover() {
  return `<span class="continue-art" aria-hidden="true"><svg viewBox="0 0 144 144" xmlns="http://www.w3.org/2000/svg"><rect width="144" height="144" fill="#e9d8f0"/><path d="M0 0h72v72H0c0-39.8 32.2-72 72-72Z" fill="#ff672b"/><path d="M144 0v72H72C72 32.2 104.2 0 144 0Z" fill="#fff5ef"/><path d="M0 72h72v72C32.2 144 0 111.8 0 72Z" fill="#4f2b66"/><path d="M72 72h72v72c-39.8 0-72-32.2-72-72Z" fill="#ff672b"/></svg></span>`;
}

function libraryPanel() {
  const ready = visibleReadings().filter((item) => item.status === 'ready');
  const filtered = ready.filter((item) => {
    const matches = `${item.title} ${item.source} ${item.subtitle}`.toLowerCase().includes(search.toLowerCase());
    const progress = store.progress[item.id] || 0;
    return matches && (filter === 'all' || (filter === 'unread' && progress === 0) || (filter === 'reading' && progress > 0 && progress < 100) || (filter === 'finished' && progress >= 100));
  });
  const featured = ready.find((item) => item.id === readerID && store.progress[item.id] > 0 && store.progress[item.id] < 100)
    || ready.find((item) => store.progress[item.id] > 0 && store.progress[item.id] < 100);
  const intro = `<div class="page-heading"><div><h1>Library</h1><p>${ready.length} saved article${ready.length === 1 ? '' : 's'}.</p></div><button class="primary-button library-add" data-action="add">${icon('plus', 17)} Add a link</button></div>`;
  const feature = !search && filter === 'all' && featured ? `<section class="continue-section"><button class="continue-reading ${featured.id === readerID ? 'selected' : ''}" data-open="${esc(featured.id)}">${featureSource(featured) ? `<img class="continue-cover" src="${esc(featureSource(featured))}" alt="" loading="lazy">` : abstractCover()}<span class="continue-copy"><strong>${esc(featured.title)}</strong><span class="continue-source">${esc(featured.source)}</span><span class="continue-progress"><span class="progress-track"><span style="width:${Math.max(0, Math.min(100, store.progress[featured.id] || 0))}%"></span></span><span>${store.progress[featured.id]}% read</span></span></span></button></section>` : '';
  const filters = `<label class="status-filter">Status <select id="status-filter" aria-label="Filter by reading status"><option value="all" ${filter === 'all' ? 'selected' : ''}>All</option><option value="unread" ${filter === 'unread' ? 'selected' : ''}>Not started</option><option value="reading" ${filter === 'reading' ? 'selected' : ''}>In progress</option><option value="finished" ${filter === 'finished' ? 'selected' : ''}>Finished</option></select></label>`;
  const otherReadings = feature ? filtered.filter((item) => item.id !== featured.id) : filtered;
  const list = otherReadings.length ? otherReadings.map(readingRow).join('') : `<div class="empty"><strong>${search ? 'No matches.' : feature ? 'Nothing else saved yet.' : 'Nothing here yet.'}</strong><p>${search ? 'Try another search.' : 'Add an article link, or choose another filter.'}</p></div>`;
  return `<div class="content-wrap">${intro}${feature}${searchBar('Search your library…')}<section class="list-section"><div class="section-heading"><h2>Saved articles</h2>${filters}</div><div class="reading-list">${list}</div></section></div>`;
}

function libraryView() {
  return shell(`<div class="reader-placeholder"><span class="reader-placeholder-mark">✳</span><h2>Choose a reading.</h2><p>Open an article from your library to read and annotate it here.</p></div>`, 'Library');
}

function inboxView() {
  const pending = visibleReadings().filter((item) => item.status !== 'ready');
  const recent = visibleReadings().filter((item) => item.status === 'ready').slice(0, 5);
  return shell(`<div class="content-wrap"><div class="page-heading"><div><div class="eyebrow">CAPTURE STATUS</div><h1>Inbox</h1><p>Check readings that are still preparing or need another look.</p></div>${searchBar()}</div>
    ${pending.length ? `<section class="list-section"><div class="section-heading"><h2>Needs attention</h2><span class="count-label">${pending.length}</span></div><div class="reading-list">${pending.map(readingRow).join('')}</div></section>` : '<div class="inbox-clear">'+icon('check', 18)+'<span>All caught up. New readings will appear here.</span></div>'}
    <section class="list-section"><div class="section-heading"><h2>Recently saved</h2></div><div class="reading-list">${recent.filter((item) => `${item.title} ${item.source}`.toLowerCase().includes(search.toLowerCase())).map(readingRow).join('') || '<div class="empty">No readings match your search.</div>'}</div></section></div>`, 'Inbox');
}

function marksView() {
  const results = store.marks.filter((mark) => {
    const item = visibleReadings().find((entry) => entry.id === mark.readingID);
    if (!item) return false;
    return `${mark.quote} ${mark.note || ''} ${item?.title || ''}`.toLowerCase().includes(search.toLowerCase());
  }).sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  return shell(`<div class="content-wrap"><div class="page-heading"><div><div class="eyebrow">YOUR PASSAGES</div><h1>Marks & Notes</h1><p>Open a mark to return to its place in the reading.</p></div></div>${searchBar('Search passages and notes')}
    <div class="marks-layout"><div class="marks-column"><div class="section-heading"><h2>Passages</h2><span class="count-label">${results.length}</span></div>${results.length ? results.map((mark) => {
      const item = store.readings.find((entry) => entry.id === mark.readingID);
      return `<button class="mark-result" data-jump="${esc(mark.id)}"><span class="mark-kind">${mark.kind === 'note' ? `<i class="mark-number">${noteNumber(mark)}</i>` : esc(markNames[mark.kind])}</span><span class="mark-result-main"><span class="mark-source">${esc(item?.title || 'Reading')} · ${esc(item?.source || '')}</span><strong>“${esc(mark.quote)}”</strong>${mark.note ? `<em>${esc(mark.note)}</em>` : ''}</span><span class="mark-result-arrow">${icon('arrow', 18)}</span></button>`;
    }).join('') : `<div class="empty marks-empty">${icon('mark', 24)}<strong>Your marks will gather here.</strong><p>Open a reading, select a passage, and add a highlight, underline, or note.</p><button class="outline-button" data-route="library">Browse library ${icon('arrow', 16)}</button></div>`}</div></div></div>`, 'Marks & Notes');
}

function noteNumber(mark) {
  return marksFor(mark.readingID).filter((item) => item.kind === 'note').findIndex((item) => item.id === mark.id) + 1;
}

function markedText(item, paragraph, index, richHTML = null) {
  const marks = marksFor(item.id).filter((mark) => mark.paragraphIndex === index && mark.start >= 0 && mark.end <= paragraph.length && mark.start < mark.end);
  const original = richHTML || esc(paragraph);
  if (!marks.length) return original;
  const template = document.createElement('template');
  template.innerHTML = original;
  const walker = document.createTreeWalker(template.content, NodeFilter.SHOW_TEXT);
  const nodes = [];
  while (walker.nextNode()) nodes.push(walker.currentNode);
  let cursor = 0;
  for (const node of nodes) {
    const start = cursor, end = start + node.textContent.length;
    cursor = end;
    const points = [...new Set([start, end, ...marks.flatMap((mark) => [mark.start, mark.end]).filter((point) => point > start && point < end)])].sort((a, b) => a - b);
    const fragment = document.createDocumentFragment();
    for (let i = 0; i < points.length - 1; i++) {
      const from = points[i], to = points[i + 1];
      const piece = node.textContent.slice(from - start, to - start);
      const active = marks.filter((mark) => mark.start <= from && mark.end >= to);
      if (!active.length) fragment.append(document.createTextNode(piece));
      else {
        const span = document.createElement('span');
        span.className = ['text-segment', ...new Set(active.map((mark) => `mark-${mark.kind}`))].join(' ');
        span.textContent = piece;
        fragment.append(span);
      }
    }
    node.replaceWith(fragment);
  }
  return template.innerHTML;
}

function articleParagraph(item, text, index) {
  const notes = marksFor(item.id).filter((mark) => mark.kind === 'note' && mark.paragraphIndex === index);
  const figures = (item.images || []).filter((image) => image.afterParagraph === index).map((image) => `<figure><img src="${esc(image.url)}" alt="${esc(image.caption || '')}" loading="lazy" referrerpolicy="no-referrer"><figcaption>${esc(image.caption)}</figcaption></figure>`).join('');
  return `<div class="paragraph-wrap" data-paragraph="${index}"><p class="article-paragraph">${markedText(item, text, index)}</p>${notes.map((mark) => `<button class="note-marker" data-edit-note="${esc(mark.id)}" aria-label="Open note ${noteNumber(mark)}">${noteNumber(mark)}</button>`).join('')}${notes.map(passageNote).join('')}${notePreview(notes.find((mark) => mark.note && mark.id !== openNoteID))}</div>${figures}`;
}

function notePreview(mark) {
  if (!mark) return '';
  return `<button class="passage-note-preview" data-edit-note="${esc(mark.id)}" data-note-preview="${esc(mark.id)}" aria-label="Open note ${noteNumber(mark)}"><span>Note ${noteNumber(mark)}</span><em>${esc(mark.note)}</em></button>`;
}

function passageNote(mark) {
  if (openNoteID !== mark.id) return '';
  return `<form class="passage-note" data-note-id="${esc(mark.id)}" aria-label="Note ${noteNumber(mark)}"><div class="passage-note-top"><span>NOTE ${noteNumber(mark)}</span><button type="button" class="passage-note-close" data-close-note aria-label="Close note">${icon('close', 15)}</button></div><blockquote>“${esc(mark.quote)}”</blockquote><label for="passage-note-text">Your thought</label><textarea id="passage-note-text" rows="5" placeholder="Write beside this passage…">${esc(mark.note || '')}</textarea><div class="passage-note-foot"><span class="passage-note-status" aria-live="polite">Saved in this browser</span><button type="button" class="passage-note-delete" data-delete-mark="${esc(mark.id)}">Delete</button></div></form>`;
}

function articleBlock(item, block) {
  if (block.kind === 'rule') return '<hr class="body-rule">';
  if (block.kind === 'image') {
    const saved = block.assetKey && assetURLs.get(block.assetKey);
    return `<figure class="article-figure">${saved ? `<img src="${esc(saved)}" alt="${esc(block.caption || '')}" loading="lazy">` : '<div class="image-unavailable">This image could not be saved.</div>'}<figcaption>${esc(block.caption || '')}</figcaption></figure>`;
  }
  if (block.kind === 'table') {
    return `<div class="article-table-scroll"><table>${block.rows.map((row) => `<tr>${row.map((cell) => `<${cell.heading ? 'th' : 'td'}>${esc(cell.text)}</${cell.heading ? 'th' : 'td'}>`).join('')}</tr>`).join('')}</table>${block.caption ? `<div class="table-caption">${esc(block.caption)}</div>` : ''}</div>`;
  }
  const index = block.index;
  const paragraph = item.paragraphs[index] || '';
  const notes = marksFor(item.id).filter((mark) => mark.kind === 'note' && mark.paragraphIndex === index);
  const tag = block.kind === 'heading' ? (block.level <= 2 ? 'h2' : 'h3') : block.kind === 'quote' ? 'blockquote' : block.kind === 'code' ? 'pre' : 'p';
  const typeClass = `body-${block.kind}`;
  const listPrefix = block.kind === 'list-item' ? `<span class="list-prefix" aria-hidden="true">${block.ordered ? `${Number(block.number) || 1}.` : '•'}</span>` : '';
  return `<div class="paragraph-wrap ${typeClass}" data-paragraph="${index}">${listPrefix}<${tag} class="article-paragraph">${markedText(item, paragraph, index, block.html)}</${tag}>${notes.map((mark) => `<button class="note-marker" data-edit-note="${esc(mark.id)}" aria-label="Open note ${noteNumber(mark)}">${noteNumber(mark)}</button>`).join('')}${notes.map(passageNote).join('')}${notePreview(notes.find((mark) => mark.note && mark.id !== openNoteID))}</div>`;
}

function bookReaderView(item) {
  const progress = store.progress[item.id] || 0;
  return shell(`<div class="book-reader"><div class="book-reader-head"><button class="back-button" data-route="library">${icon('back', 17)} Library</button><div class="book-reader-heading"><span>${esc(item.format || 'EBOOK')} ${item.byline ? `· ${esc(item.byline)}` : ''}</span><strong>${esc(item.title)}</strong></div><button class="plain-button" data-action="book-toc">Contents</button></div><div class="book-reading-area"><div id="book-view-mount" class="book-view-mount"><div class="book-loading">Opening your book…</div></div><aside id="book-toc" class="book-toc" hidden><div class="overline">CONTENTS</div><div id="book-toc-list"></div></aside></div><div class="book-reader-foot"><button class="outline-button" data-action="book-prev">${icon('back', 15)} Previous</button><span class="book-progress">${progress}% read</span><button class="outline-button" data-action="book-next">Next ${icon('arrow', 15)}</button></div></div>`, item.title, 'Library');
}

function bookTOC(items, depth = 0) {
  return (items || []).map((item) => `<button class="book-toc-item" style="padding-left:${12 + Math.min(depth, 3) * 15}px" data-book-href="${esc(item.href || '')}">${esc(item.label || 'Untitled section')}</button>${bookTOC(item.subitems, depth + 1)}`).join('');
}

async function mountBookReader(id, token) {
  const item = store.readings.find((entry) => entry.id === id);
  const mount = $('#book-view-mount');
  if (!item || !mount) return;
  try {
    const file = await savedBook(id);
    if (token !== bookMountToken) return;
    if (!file) throw new Error('The book file is missing from this browser.');
    const view = await openBook(mount, file, item, (location) => {
      if (token !== bookMountToken || !Number.isInteger(location?.index)) return;
      const progress = Math.max(0, Math.min(100, Math.round((location.fraction || 0) * 100)));
      const changed = item.bookLocation !== location.index || store.progress[id] !== progress;
      item.bookLocation = location.index;
      store.progress[id] = progress;
      const label = $('.book-progress'); if (label) label.textContent = `${progress}% read`;
      if (changed) save(id);
    });
    if (token !== bookMountToken) { view.close(); return; }
    activeBookView = view;
    const toc = $('#book-toc-list');
    if (toc) toc.innerHTML = bookTOC(view.book.toc) || '<p class="book-toc-empty">No contents list in this file.</p>';
  } catch (error) {
    if (token === bookMountToken) mount.innerHTML = `<div class="book-loading book-load-error"><strong>Could not open this book.</strong><p>${esc(error.message || 'This file could not be read.')}</p><button class="outline-button" data-action="add">Add another file</button></div>`;
  }
}

function readerView() {
  const item = reading();
  if (!item) return libraryView();
  if (item.status === 'preparing') {
    return shell(`<div class="reader-layout reader-pending"><div class="reader-main"><div class="reader-toolbar"><button class="back-button" data-route="library">${icon('back', 17)} Library</button><a href="${esc(item.url)}" target="_blank" rel="noopener noreferrer" class="plain-button">Original ${icon('external', 15)}</a></div><article class="paper pending-paper" aria-busy="true" aria-live="polite"><div class="article-overline">${esc(item.source)}</div><h1>Opening your reading.</h1><p class="pending-description">Kornu is preparing the article and saving its images. You can keep reading here when it is ready.</p><div class="pending-lines" aria-hidden="true"><span></span><span></span><span></span><span></span><span></span></div></article></div></div>`, 'Opening reading', 'Library');
  }
  if (item.status !== 'ready' && !(item.status === 'needsReview' && item.snapshotStored)) {
    return shell(`<div class="content-wrap"><div class="reader-back"><button class="back-button" data-route="inbox">${icon('back', 16)} Back to Inbox</button></div><div class="review-screen"><div class="eyebrow">NEEDS REVIEW</div><h1>${esc(item.title)}</h1><p>${esc(item.issue || 'Kornu could not prepare this link.')}</p><div class="review-actions"><button class="primary-button" data-retry="${esc(item.id)}">Try again</button><a class="outline-button" href="${esc(item.url)}" target="_blank" rel="noopener noreferrer">Open original ${icon('external', 16)}</a></div></div></div>`, 'Review', 'Inbox');
  }
  if (item.kind === 'book') return bookReaderView(item);
  if (item.snapshotStored && !item.blocks) {
    return shell('<div class="content-wrap"><div class="review-screen"><div class="eyebrow">OPENING READING</div><h1>Preparing your copy.</h1><p>Loading the article and its saved images from this browser.</p></div></div>', item.title, 'Library');
  }
  const itemMarks = marksFor(item.id);
  const count = itemMarks.length;
  const articleNote = store.articleNotes[item.id] || '';
  return shell(`<div class="reader-layout"><div class="reader-main"><div class="reader-toolbar"><button class="back-button" data-action="close-reader">${icon('back', 17)} Back</button><span class="reader-toolbar-source">${esc(item.source)}</span><div class="reader-toolbar-right"><a href="${esc(item.url)}" target="_blank" rel="noopener noreferrer" class="plain-button">Original article ${icon('external', 15)}</a>${item.source !== 'Kornu sample' ? `<button class="plain-button recapture-button" data-retry="${esc(item.id)}" title="Capture this article again">${icon('download', 15)}<span>Recapture</span></button>` : ''}<button class="plain-button" data-action="toggle-marks">${icon('mark', 16)} Marks <span class="toolbar-count">${count}</span></button></div></div>
    <article class="paper" id="reading-paper"><div class="article-overline">SAVED ${day(item.savedAt).toUpperCase()}</div><h1>${esc(item.title)}</h1><div class="article-meta"><span>${minutes(item)} min read</span><i aria-hidden="true"></i><span>${esc(item.source)}</span></div>${item.byline ? `<div class="article-byline">By ${esc(item.byline)}</div>` : ''}${item.subtitle ? `<p class="article-deck">${esc(item.subtitle)}</p>` : ''}${item.issue ? `<div class="capture-notice" role="status"><strong>This copy may be incomplete.</strong><p>${esc(item.issue)}</p><div class="capture-notice-actions"><a href="${esc(item.url)}" target="_blank" rel="noopener noreferrer">Open original ${icon('external', 14)}</a><button data-retry="${esc(item.id)}">Retry capture ${icon('arrow', 14)}</button></div></div>` : ''}<div class="article-rule"></div><div class="article-body">${item.blocks ? item.blocks.map((block) => articleBlock(item, block)).join('') : item.paragraphs.map((paragraph, index) => articleParagraph(item, paragraph, index)).join('')}</div><div class="article-end"><span class="end-mark">✳</span><p>You reached the end of this reading.</p><button class="text-link" data-action="finish">Mark as finished ${icon('check', 15)}</button></div></article></div>
    <aside class="reader-aside ${showReaderMarks ? '' : 'reader-aside-hidden'}"><div class="aside-inner"><div class="aside-heading"><span class="overline">THIS READING</span><button class="aside-close" data-action="toggle-marks" aria-label="Close marks">${icon('close', 16)}</button></div><h2>Room for thought.</h2><p class="aside-subtitle">Select a passage to highlight, underline, or leave a note.</p><div class="aside-divider"></div><div class="aside-section-heading"><strong>Your marks</strong><span>${count}</span></div>
      ${itemMarks.length ? itemMarks.map((mark) => `<button class="aside-mark" data-jump="${esc(mark.id)}"><span class="aside-mark-type">${mark.kind === 'note' ? `NOTE ${noteNumber(mark)}` : esc(markNames[mark.kind]).toUpperCase()}</span><span>“${esc(mark.quote)}”</span>${mark.note ? `<em>${esc(mark.note)}</em>` : ''}</button>`).join('') : '<div class="aside-empty">Your first mark will appear here.</div>'}
      <div class="aside-divider"></div><button class="article-note-button" data-action="article-note"><span class="overline">READING NOTE</span><span>${articleNote ? esc(articleNote) : 'Why did you save this? Add a thought.'}</span>${icon('arrow', 16)}</button>
      <div class="aside-storage">Saved in this browser</div></div></aside></div>`, item.title, 'Library');
}

function positionMarkers() {
  const item = reading(); if (!item || view !== 'reader') return;
  for (const button of document.querySelectorAll('.note-marker')) {
    const mark = store.marks.find((entry) => entry.id === button.dataset.editNote);
    const wrap = button.closest('.paragraph-wrap');
    const paragraph = $('.article-paragraph', wrap);
    if (!mark || !paragraph) continue;
    const walker = document.createTreeWalker(paragraph, NodeFilter.SHOW_TEXT);
    let node, offset = 0, found = null;
    while ((node = walker.nextNode())) {
      const length = node.textContent.length;
      if (mark.start >= offset && mark.start < offset + length) { found = { node, offset: mark.start - offset }; break; }
      offset += length;
    }
    if (found) {
      const range = document.createRange(); range.setStart(found.node, found.offset); range.setEnd(found.node, Math.min(found.node.length, found.offset + 1));
      const rect = range.getBoundingClientRect();
      const lineTop = Math.max(2, rect.top - wrap.getBoundingClientRect().top);
      button.style.top = `${lineTop + rect.height / 2 - button.offsetHeight / 2}px`;
      const note = wrap.querySelector('.passage-note');
      if (note) {
        if (innerWidth > 1350 && !showReaderMarks) note.style.top = `${lineTop}px`;
        else note.style.removeProperty('top');
      }
      const preview = wrap.querySelector(`[data-note-preview="${mark.id}"]`);
      if (preview) preview.style.top = `${lineTop}px`;
    }
  }
}

async function hydrateReading(id) {
  if (loadingSnapshots.has(id)) return;
  loadingSnapshots.add(id);
  const item = store.readings.find((entry) => entry.id === id);
  const generation = accountGeneration;
  try {
    const snapshot = await localSnapshot(id);
    if (generation !== accountGeneration) return;
    if (!snapshot) throw new Error('The saved reading copy is missing from this browser.');
    item.paragraphs = snapshot.paragraphs;
    item.blocks = snapshot.blocks;
    item.images = snapshot.images;
    const keys = [...new Set(snapshot.blocks.map((block) => block.assetKey).filter(Boolean))];
    await Promise.all(keys.map(async (key) => {
      if (assetURLs.has(key)) return;
      const blob = await savedAsset(key);
      if (blob && generation === accountGeneration) assetURLs.set(key, URL.createObjectURL(blob));
    }));
  } catch (error) {
    item.status = 'needsReview';
    item.snapshotStored = false;
    item.issue = error.message || 'The saved copy could not be opened.';
    save();
  } finally {
    loadingSnapshots.delete(id);
    if (generation === accountGeneration && view === 'reader' && readerID === id) render();
  }
}

function render() {
  const token = ++bookMountToken;
  if (activeBookView) { activeBookView.close(); activeBookView = null; }
  if (view === 'reader' && (!reading() || reading().kind === 'book')) {
    view = 'library'; readerID = null;
    if (location.hash !== '#/library') history.replaceState(null, '', '#/library');
  }
  const sameReader = view === 'reader' && lastRenderedReader === readerID && Boolean($('#reading-paper'));
  const previousScroll = sameReader ? window.scrollY : null;
  const item = reading();
  if (view === 'reader' && ['ready', 'needsReview'].includes(item?.status) && item.snapshotStored && !item.blocks && !loadingSnapshots.has(item.id)) hydrateReading(item.id);
  if (view === 'reader') $('#app').innerHTML = readerView();
  else if (view === 'inbox') $('#app').innerHTML = inboxView();
  else if (view === 'marks') $('#app').innerHTML = marksView();
  else $('#app').innerHTML = libraryView();
  positionMarkers();
  const markerPaper = $('#reading-paper');
  if (markerPaper && document.fonts) document.fonts.ready.then(() => {
    if (view === 'reader' && $('#reading-paper') === markerPaper) positionMarkers();
  });
  if (view === 'reader' && item?.kind === 'book' && item.status === 'ready') mountBookReader(item.id, token);
  if (view === 'reader' && item?.kind !== 'book') {
    if (sameReader) requestAnimationFrame(() => window.scrollTo({ top: previousScroll, behavior: 'instant' }));
    else restorePosition();
  }
  lastRenderedReader = view === 'reader' ? readerID : null;
}

function restorePosition() {
  const item = reading(); if (!item) return;
  if (!$('#reading-paper')) return;
  if (openInitialReaderAtTop) {
    openInitialReaderAtTop = false;
    requestAnimationFrame(() => window.scrollTo({ top: 0, behavior: 'instant' }));
    return;
  }
  const pending = sessionStorage.getItem('kornu.jump');
  if (pending) {
    sessionStorage.removeItem('kornu.jump');
    requestAnimationFrame(() => jumpTo(pending));
  } else {
    requestAnimationFrame(() => window.scrollTo({ top: Math.max(0, (store.progress[item.id] || 0) / 100 * (document.documentElement.scrollHeight - innerHeight)), behavior: 'instant' }));
  }
}

function jumpTo(id) {
  const mark = store.marks.find((entry) => entry.id === id);
  if (!mark) return;
  if (view !== 'reader' || readerID !== mark.readingID) { sessionStorage.setItem('kornu.jump', id); route('reader', mark.readingID); return; }
  const paragraph = $(`[data-paragraph="${mark.paragraphIndex}"]`);
  paragraph?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  paragraph?.classList.add('passage-focus');
  setTimeout(() => paragraph?.classList.remove('passage-focus'), 2000);
}

function showModal(html) {
  $('#modal-root').innerHTML = `<div class="modal-backdrop"><div class="modal" role="dialog" aria-modal="true">${html}</div></div>`;
  $('.modal input, .modal textarea')?.focus();
}
function closeModal() { $('#modal-root').innerHTML = ''; }

function addModal() {
  showModal(`<div class="modal-overline">ADD TO KORNU</div><button class="modal-close" data-action="close-modal" aria-label="Close">${icon('close')}</button><h2>Bring a reading in.</h2><p>Save an article to read and mark up later.</p><form id="add-form"><label for="article-url">Article URL</label><input id="article-url" type="url" placeholder="https://example.com/article" required autofocus><div class="modal-actions"><button class="primary-button" type="submit">Save link ${icon('arrow', 16)}</button></div></form>`);
}

function openPassageNote(mark) {
  openNoteID = mark.id;
  render();
  requestAnimationFrame(() => $('#passage-note-text')?.focus({ preventScroll: true }));
}

function articleNoteModal() {
  const item = reading(); if (!item) return;
  showModal(`<div class="modal-overline">READING NOTE</div><button class="modal-close" data-action="close-modal" aria-label="Close">${icon('close')}</button><h2>Why this reading?</h2><p>A place for the thought you want to keep about the whole article.</p><form id="article-note-form"><label for="article-note-text">Your thought</label><textarea id="article-note-text" rows="7" placeholder="What made you save it?">${esc(store.articleNotes[item.id] || '')}</textarea><div class="modal-actions"><button type="button" class="outline-button" data-action="close-modal">Cancel</button><button class="primary-button" type="submit">Save note ${icon('check', 16)}</button></div></form>`);
}

function hideSelection() { selection = null; $('#selection-menu').hidden = true; window.getSelection()?.removeAllRanges(); }
function inspectSelection() {
  if (view !== 'reader' || $('#modal-root').children.length) return;
  const selected = window.getSelection();
  if (!selected || selected.isCollapsed || !selected.rangeCount) return;
  const range = selected.getRangeAt(0);
  const startParagraph = range.startContainer.parentElement?.closest('[data-paragraph]');
  const endParagraph = range.endContainer.parentElement?.closest('[data-paragraph]');
  if (!startParagraph || startParagraph !== endParagraph) return;
  const para = $('.article-paragraph', startParagraph);
  const measure = range.cloneRange(); measure.selectNodeContents(para); measure.setEnd(range.startContainer, range.startOffset);
  const start = measure.toString().length;
  const quote = range.toString();
  if (!quote.trim() || quote.length > 600) return;
  selection = { paragraphIndex: Number(startParagraph.dataset.paragraph), start, end: start + quote.length, quote };
  const rect = range.getBoundingClientRect();
  const menu = $('#selection-menu');
  menu.innerHTML = `<button data-mark-kind="highlight">Highlight</button><button data-mark-kind="underline">Underline</button><button data-mark-kind="note">Add note</button>`;
  menu.style.left = `${Math.max(8, Math.min(innerWidth - 298, rect.left + rect.width / 2 - 145))}px`;
  menu.style.top = `${Math.max(8, rect.top - 52)}px`;
  menu.hidden = false;
}

function addMark(kind) {
  if (!selection || !reading()) return;
  const mark = { id: uid(), readingID: readerID, kind, ...selection, note: '', createdAt: new Date().toISOString() };
  store.marks.push(mark); save(readerID); hideSelection();
  if (kind === 'note') openPassageNote(mark);
  else { render(); notify(`${markNames[kind]} saved.`); }
}

async function importLink(url, existingID = null) {
  if (existingID && (marksFor(existingID).length || store.articleNotes[existingID])) {
    existingID = null;
    notify('Making a new copy so your existing marks stay in place.');
  }
  let item = existingID ? store.readings.find((entry) => entry.id === existingID) : null;
  if (!item) {
    item = { id: uid(), title: 'New reading', source: new URL(url).hostname.replace(/^www\./, ''), subtitle: '', url, status: 'preparing', issue: '', savedAt: new Date().toISOString(), paragraphs: [], images: [] };
    store.readings.unshift(item);
  }
  item.status = 'preparing'; item.issue = ''; save(item.id); route('reader', item.id);
  try {
    const response = await fetch('/api/import', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url }) });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Import failed.');
    if (existingID && account) {
      for (const key of uploadedAssets) if (key.startsWith(`${item.id}:image:`)) uploadedAssets.delete(key);
      persistUploaded();
    }
    const blocks = data.blocks || [];
    const pictures = blocks.filter((block) => block.kind === 'image');
    let cursor = 0, failed = 0, coverAssetKey = null;
    async function worker() {
      while (cursor < pictures.length) {
        const index = cursor++;
        const picture = pictures[index];
        const key = `${item.id}:image:${index}`;
        try {
          const assetResponse = await fetch('/api/asset', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url: picture.url }) });
          if (!assetResponse.ok) throw new Error('Image unavailable.');
          const blob = await assetResponse.blob();
          await writeAsset(key, blob);
          picture.assetKey = key;
          assetURLs.set(key, URL.createObjectURL(blob));
          if (!coverAssetKey) coverAssetKey = key;
        } catch { failed++; }
      }
    }
    await Promise.all(Array.from({ length: Math.min(3, pictures.length) }, worker));
    await writeSnapshot(item.id, { id: item.id, paragraphs: data.paragraphs, blocks, images: data.images, wordCount: data.wordCount });
    const issue = [data.warning, failed ? `${failed} image${failed === 1 ? '' : 's'} could not be saved for offline reading.` : ''].filter(Boolean).join(' ');
    Object.assign(item, {
      title: data.title, source: data.source, subtitle: data.subtitle, byline: data.byline,
      url: data.url, paragraphs: data.paragraphs, blocks, images: data.images,
      wordCount: data.wordCount, snapshotStored: true, coverAssetKey,
      status: data.warning?.startsWith('Only an opening preview') ? 'needsReview' : 'ready', issue
    });
    notify(item.status === 'ready' ? `Reading saved${pictures.length ? ` with ${pictures.length - failed} images` : ''}.` : 'Only a preview was found.');
  } catch (error) { item.status = 'needsReview'; item.issue = error.message || 'Import failed.'; notify('This link needs review.'); }
  save(item.id); render();
}

async function importBookFile(file) {
  if (!file) return;
  const generation = accountGeneration;
  closeModal();
  notify('Preparing your book…');
  try {
    const result = await inspectBook(file);
    if (generation !== accountGeneration) return;
    const id = uid();
    const coverAssetKey = result.cover ? `${id}:image:0` : null;
    await writeBook(id, result.file);
    if (coverAssetKey) {
      await writeAsset(coverAssetKey, result.cover);
      assetURLs.set(coverAssetKey, URL.createObjectURL(result.cover));
    }
    if (generation !== accountGeneration) return;
    const item = {
      id, kind: 'book', title: result.title, source: result.format,
      subtitle: result.author || 'A book from your files', byline: result.author,
      format: result.format, filename: result.file.name, fileType: result.file.type,
      coverAssetKey, status: 'ready', savedAt: new Date().toISOString(), bookLocation: null
    };
    store.readings.unshift(item);
    save(id);
    route('reader', id);
    notify(`${result.format} added to your library.`);
  } catch (error) {
    showModal(`<div class="modal-overline">BOOK IMPORT</div><button class="modal-close" data-action="close-modal" aria-label="Close">${icon('close')}</button><h2>Could not open this file.</h2><p>${esc(error.message || 'This book could not be read.')}</p><div class="modal-actions"><button class="primary-button" data-action="add">Choose another reading</button></div>`);
  }
}

async function backup() {
  notify('Preparing your browser backup…');
  try {
    const [allSnapshots, allAssets] = await Promise.all([getAllSnapshotEntries(), getAllAssets()]);
    const readingIDs = new Set(store.readings.map((item) => item.id));
    const snapshots = allSnapshots.filter((entry) => readingIDs.has(entry.snapshot.id) && entry.key === snapshotCacheKey(entry.snapshot.id)).map((entry) => entry.snapshot);
    const assetKeys = new Set(snapshots.flatMap((entry) => entry.blocks || []).map((block) => block.assetKey).filter(Boolean));
    await Promise.all([...assetKeys].map((key) => savedAsset(key)));
    const freshAssets = account ? await getAllAssets() : allAssets;
    const storedAssets = freshAssets.filter((entry) => assetKeys.has(entry.key.replace(`account:${account?.id}:asset:`, '')) && entry.key === assetCacheKey(entry.key.replace(`account:${account?.id}:asset:`, ''))).map((entry) => ({ key: entry.key.replace(`account:${account?.id}:asset:`, ''), blob: entry.blob }));
    const assets = await Promise.all(storedAssets.map(({ key, blob }) => new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve({ key, data: reader.result });
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(blob);
    })));
    const books = await Promise.all(store.readings.filter((item) => item.kind === 'book').map(async (item) => {
      const file = await savedBook(item.id);
      if (!file) throw new Error('A book file is missing.');
      const data = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = () => reject(reader.error);
        reader.readAsDataURL(file);
      });
      return { id: item.id, filename: item.filename, data };
    }));
    const archive = { version: 3, exportedAt: new Date().toISOString(), ...compactStore(), snapshots, assets, books };
    const blob = new Blob([JSON.stringify(archive)], { type: 'application/json' });
    const link = document.createElement('a'); link.href = URL.createObjectURL(blob);
    link.download = `kornu-backup-${new Date().toISOString().slice(0, 10)}.json`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 1000);
    notify('Backup downloaded.');
  } catch { notify('The backup could not be prepared.'); }
}

async function preloadCovers() {
  const generation = accountGeneration;
  const keys = [...new Set(store.readings.map((item) => item.coverAssetKey).filter(Boolean))];
  if (!keys.length) return;
  await Promise.all(keys.map(async (key) => {
    if (assetURLs.has(key)) return;
    const blob = await savedAsset(key).catch(() => null);
    if (blob && generation === accountGeneration) assetURLs.set(key, URL.createObjectURL(blob));
  }));
  if (generation === accountGeneration && (view === 'library' || view === 'reader')) render();
}

document.addEventListener('click', (event) => {
  const target = event.target.closest('[data-route],[data-open],[data-action],[data-filter],[data-mark-kind],[data-edit-note],[data-close-note],[data-delete-mark],[data-jump],[data-retry],[data-book-href]');
  if (!target) {
    if (event.target.classList.contains('modal-backdrop')) closeModal();
    return;
  }
  if (target.dataset.route) { hideSelection(); route(target.dataset.route); return; }
  if (target.dataset.open) { hideSelection(); route('reader', target.dataset.open); return; }
  if (target.dataset.bookHref) { activeBookView?.goTo(target.dataset.bookHref); $('#book-toc').hidden = true; return; }
  if (target.dataset.filter) { filter = target.dataset.filter; render(); return; }
  if (target.dataset.markKind) { addMark(target.dataset.markKind); return; }
  if (target.dataset.editNote) { const mark = store.marks.find((entry) => entry.id === target.dataset.editNote); if (mark) openPassageNote(mark); return; }
  if (target.hasAttribute('data-close-note')) { openNoteID = null; render(); return; }
  if (target.dataset.deleteMark) { const mark = store.marks.find((entry) => entry.id === target.dataset.deleteMark); store.marks = store.marks.filter((entry) => entry.id !== target.dataset.deleteMark); openNoteID = null; save(mark?.readingID); closeModal(); render(); notify('Note removed.'); return; }
  if (target.dataset.jump) { jumpTo(target.dataset.jump); return; }
  if (target.dataset.retry) { const item = store.readings.find((entry) => entry.id === target.dataset.retry); if (item) importLink(item.url, item.id); return; }
  const action = target.dataset.action;
  if (action === 'add') addModal();
  else if (action === 'account') accountModal();
  else if (action === 'sign-in-google') cloud.signIn().catch((error) => notify(error.message || 'Google sign-in could not start.'));
  else if (action === 'sign-out') cloud.signOut().then(() => { closeModal(); switchAccount(null); }).catch((error) => notify(error.message || 'Sign out failed.'));
  else if (action === 'copy-browser-library') copyBrowserLibrary();
  else if (action === 'close-modal') closeModal();
  else if (action === 'close-reader') { hideSelection(); location.hash = '#/library'; }
  else if (action === 'focus-search') { if (view === 'reader') route('library'); requestAnimationFrame(() => $('#library-search')?.focus()); }
  else if (action === 'toggle-marks') { showReaderMarks = !showReaderMarks; render(); }
  else if (action === 'article-note') articleNoteModal();
  else if (action === 'book-toc') { const toc = $('#book-toc'); if (toc) toc.hidden = !toc.hidden; }
  else if (action === 'book-prev') activeBookView?.prev();
  else if (action === 'book-next') activeBookView?.next();
  else if (action === 'finish') { store.progress[readerID] = 100; save(readerID); notify('Marked as finished.'); }
  else if (action === 'backup') backup();
});

document.addEventListener('submit', (event) => {
  event.preventDefault();
  if (event.target.id === 'add-form') {
    const url = $('#article-url').value.trim();
    const existing = store.readings.find((item) => item.url === url && !item.id.startsWith('sample-'));
    if (existing) { closeModal(); route('reader', existing.id); return; }
    closeModal(); importLink(url);
  } else if (event.target.id === 'article-note-form') {
    store.articleNotes[readerID] = $('#article-note-text').value.trim(); save(readerID); closeModal(); render(); notify('Reading note saved.');
  }
});

document.addEventListener('input', (event) => {
  if (event.target.id === 'passage-note-text') {
    const mark = store.marks.find((entry) => entry.id === event.target.closest('[data-note-id]')?.dataset.noteId);
    if (mark) { mark.note = event.target.value; save(mark.readingID); $('.passage-note-status').textContent = account ? 'Saved here; syncing if connected' : 'Saved in this browser'; }
  }
  if (event.target.id === 'library-search') {
    search = event.target.value;
    const caret = event.target.selectionStart;
    render();
    const input = $('#library-search'); input?.focus(); input?.setSelectionRange(caret, caret);
  }
});
document.addEventListener('change', (event) => {
  if (event.target.id === 'status-filter') { filter = event.target.value; render(); }
  if (event.target.id === 'book-file') importBookFile(event.target.files?.[0]);
});

document.addEventListener('mouseup', () => setTimeout(inspectSelection, 0));
document.addEventListener('touchend', () => setTimeout(inspectSelection, 180), { passive: true });
document.addEventListener('keyup', (event) => {
  if (event.key === 'Escape') { closeModal(); hideSelection(); if (openNoteID) { openNoteID = null; render(); } return; }
  if (event.key === 'ArrowLeft' || event.key === 'ArrowRight' || event.key === 'Shift') setTimeout(inspectSelection, 0);
});
document.addEventListener('keydown', (event) => {
  if (event.target.id === 'passage-note-text' && (event.metaKey || event.ctrlKey) && event.key === 'Enter') { event.preventDefault(); openNoteID = null; render(); return; }
  if (!['INPUT', 'TEXTAREA'].includes(document.activeElement?.tagName) && !event.metaKey && !event.ctrlKey && event.key.toLowerCase() === 'n' && selection) { event.preventDefault(); addMark('note'); return; }
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); if (view === 'reader') route('library'); requestAnimationFrame(() => $('#library-search')?.focus()); }
  if (activeBookView && !$('#modal-root').children.length && !['INPUT', 'TEXTAREA'].includes(document.activeElement?.tagName)) {
    if (event.key === 'ArrowLeft') { event.preventDefault(); activeBookView.goLeft(); }
    if (event.key === 'ArrowRight') { event.preventDefault(); activeBookView.goRight(); }
  }
});
window.addEventListener('resize', positionMarkers);
window.addEventListener('scroll', () => {
  if (view !== 'reader' || !reading() || reading().kind === 'book') return;
  const activeID = readerID;
  clearTimeout(progressTimer);
  progressTimer = setTimeout(() => {
    const max = document.documentElement.scrollHeight - innerHeight;
    if (max > 0 && readerID === activeID) { const progress = Math.max(store.progress[activeID] || 0, Math.min(99, Math.round(scrollY / max * 100))); if (progress !== store.progress[activeID]) { store.progress[activeID] = progress; save(activeID); } }
  }, 400);
}, { passive: true });
window.addEventListener('hashchange', () => {
  const parts = location.hash.split('/');
  view = ['inbox', 'library', 'marks', 'reader'].includes(parts[1]) ? parts[1] : 'library';
  readerID = view === 'reader' ? parts[2] : null;
  selection = null; $('#selection-menu').hidden = true;
  openNoteID = null;
  window.scrollTo({ top: 0, behavior: 'instant' }); render();
});

if (view === 'library' && matchMedia('(min-width: 1251px)').matches) {
  const selected = visibleReadings().find((item) => item.status === 'ready' && (store.progress[item.id] || 0) > 0 && (store.progress[item.id] || 0) < 100)
    || visibleReadings().find((item) => item.status === 'ready');
  if (selected) { view = 'reader'; readerID = selected.id; openInitialReaderAtTop = true; history.replaceState(null, '', `#/reader/${selected.id}`); }
}
render();
preloadCovers();
if (cloud.configured) {
  cloud.onAuthChange((user) => switchAccount(user));
  cloud.session().then((session) => switchAccount(session?.user || null))
    .catch((error) => notify(error.message || 'Your account could not be opened.'));
}
