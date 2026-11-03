import { putSnapshot, getSnapshot, putAsset, getAsset, getAllSnapshotEntries, getAllAssets } from './storage.js';
import { cloud } from './cloud.js';

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
    if (saved && Array.isArray(saved.readings) && Array.isArray(saved.marks)) return saved;
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
let showReaderMarks = true;
let selection = null;
let toastTimer;
let progressTimer;
let lastRenderedReader = null;
const loadingSnapshots = new Set();
const assetURLs = new Map();
const snapshotCacheKey = (id) => account ? `account:${account.id}:snapshot:${id}` : id;
const assetCacheKey = (key) => account ? `account:${account.id}:asset:${key}` : key;
const localSnapshot = (id) => getSnapshot(snapshotCacheKey(id));
const writeSnapshot = (id, snapshot) => putSnapshot(snapshotCacheKey(id), snapshot);
const localAsset = (key) => getAsset(assetCacheKey(key));
const writeAsset = (key, blob) => putAsset(assetCacheKey(key), blob);

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
const marksFor = (id) => store.marks.filter((mark) => mark.readingID === id).sort((a, b) => a.paragraphIndex - b.paragraphIndex || a.start - b.start);
const wordCount = (item) => item.wordCount || item.paragraphs?.join(' ').trim().split(/\s+/).length || 0;
const minutes = (item) => Math.max(1, Math.ceil(wordCount(item) / 220));
const day = (value) => new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' }).format(new Date(value));
const featureSource = (item) => item.coverAssetKey ? assetURLs.get(item.coverAssetKey) || '/editorial.png' : item.images?.[0]?.url || '/editorial.png';
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
  location.hash = next === 'reader' ? `#/reader/${id}` : `#/${next}`;
  if (location.hash === `#/${next}` && view === next) render();
}

function navItem(area, label, symbol) {
  return `<button class="nav-item ${view === area ? 'active' : ''}" data-route="${area}">${icon(symbol)}<span>${label}</span>${area === 'inbox' && store.readings.some((item) => item.status !== 'ready') ? '<i class="nav-dot"></i>' : ''}</button>`;
}

function shell(content, title, kicker = '') {
  const accountName = account?.user_metadata?.full_name || account?.email || 'Your account';
  return `<div class="app-shell">
    <aside class="sidebar">
      <div class="brand-row"><img src="/wordmark.svg" alt="Kornu" class="wordmark"></div>
      <div class="sidebar-main"><div class="nav-label">WORKSPACE</div>
        ${navItem('inbox', 'Inbox', 'tray')}${navItem('library', 'Library', 'book')}${navItem('marks', 'Marks & Notes', 'mark')}
      </div>
      <div class="sidebar-bottom"><div class="sidebar-line"></div><div class="sidebar-foot-title">A quieter place to think.</div><div class="sidebar-foot-copy" data-cloud-status>${esc(account ? cloudStatus : 'Your browser library is stored on this device.')}</div><button class="account-button" data-action="account">${icon('account', 17)} <span>${esc(account ? accountName : 'Sign in with Google')}</span></button><button class="text-link" data-action="backup">Export backup ${icon('arrow', 14)}</button></div>
    </aside>
    <div class="workspace">
      <header class="topbar"><button class="mobile-brand" data-route="library"><img src="/wordmark.svg" alt="Kornu"></button><div class="breadcrumb">${kicker ? `<span>${esc(kicker)}</span><span class="crumb-slash">/</span>` : ''}<strong>${esc(title)}</strong></div><div class="topbar-actions"><button class="icon-button account-top" aria-label="${esc(account ? `Account: ${accountName}` : 'Sign in with Google')}" data-action="account">${icon('account')}</button><button class="icon-button backup-top" aria-label="Export browser backup" data-action="backup">${icon('download')}</button><button class="icon-button" aria-label="Search library" data-action="focus-search">${icon('search')}</button><button class="primary-button" data-action="add">${icon('plus', 17)}<span>Add a link</span></button></div></header>
      <main class="main-content">${content}</main>
      <nav class="mobile-nav">${navItem('inbox', 'Inbox', 'tray')}${navItem('library', 'Library', 'book')}${navItem('marks', 'Marks', 'mark')}</nav>
    </div></div>`;
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
      const keys = [...new Set((snapshot?.blocks || []).map((block) => block.assetKey).filter(Boolean))];
      for (const key of keys) {
        if (uploadedAssets.has(key)) continue;
        const blob = await localAsset(key);
        if (account?.id !== userID) return;
        if (!blob) continue;
        await cloud.uploadAsset(userID, key, blob);
        uploadedAssets.add(key);
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

function searchBar() {
  return `<label class="search-field">${icon('search', 18)}<input id="library-search" type="search" placeholder="Search your readings" value="${esc(search)}" autocomplete="off"><span>⌘ K</span></label>`;
}

function readingRow(item, index = 0) {
  const progress = store.progress[item.id] || 0;
  const count = marksFor(item.id).length;
  return `<button class="reading-row" data-open="${esc(item.id)}"><span class="row-index">${String(index + 1).padStart(2, '0')}</span><span class="row-main"><span class="row-source">${esc(item.source)}</span><strong>${esc(item.title)}</strong><span class="row-detail">${esc(item.subtitle || 'Saved to your reading space')}</span></span><span class="row-meta">${item.status === 'ready' ? `${minutes(item)} min read` : item.status === 'preparing' ? 'Preparing…' : 'Needs review'}${count ? `<small>${count} mark${count === 1 ? '' : 's'}</small>` : ''}${progress > 0 ? `<small>${progress >= 100 ? 'Finished' : `${progress}% read`}</small>` : ''}</span><span class="row-arrow">${icon('arrow', 19)}</span></button>`;
}

function libraryView() {
  const ready = store.readings.filter((item) => item.status === 'ready');
  const filtered = ready.filter((item) => {
    const matches = `${item.title} ${item.source} ${item.subtitle}`.toLowerCase().includes(search.toLowerCase());
    const progress = store.progress[item.id] || 0;
    return matches && (filter === 'all' || (filter === 'unread' && progress === 0) || (filter === 'reading' && progress > 0 && progress < 100) || (filter === 'finished' && progress >= 100));
  });
  const featured = ready.find((item) => store.progress[item.id] > 0 && store.progress[item.id] < 100)
    || ready.find((item) => item.images?.some((image) => image.url === '/editorial.png')) || ready[0];
  const intro = `<div class="page-heading"><div><div class="eyebrow">YOUR READING SPACE</div><h1>Library<span class="heading-dot">.</span></h1><p>${ready.length} reading${ready.length === 1 ? '' : 's'} saved for later.</p></div>${searchBar()}</div>`;
  const feature = !search && filter === 'all' && featured ? `<section class="feature"><img class="feature-image" src="${esc(featureSource(featured))}" alt=""><div class="feature-shade"></div><div class="feature-content"><span class="feature-label">${(store.progress[featured.id] || 0) > 0 ? 'CONTINUE READING' : 'START HERE'}</span><h2>${esc(featured.title)}</h2><p>${esc(featured.subtitle)}</p><button class="light-button" data-open="${esc(featured.id)}">Open reading ${icon('arrow', 17)}</button></div><span class="feature-number">01 / ${String(ready.length).padStart(2, '0')}</span></section>` : '';
  const filters = [['all', 'All'], ['unread', 'Unread'], ['reading', 'In progress'], ['finished', 'Finished']].map(([key, label]) => `<button class="filter ${filter === key ? 'selected' : ''}" data-filter="${key}">${label}</button>`).join('');
  const list = filtered.length ? filtered.map(readingRow).join('') : `<div class="empty"><strong>Nothing here yet.</strong><p>${search ? 'Try another search.' : 'Add a link or choose another filter.'}</p></div>`;
  return shell(`<div class="content-wrap">${intro}${feature}<section class="list-section"><div class="section-heading"><h2>All readings</h2><div class="filters">${filters}</div></div><div class="reading-list">${list}</div></section></div>`, 'Library');
}

function inboxView() {
  const pending = store.readings.filter((item) => item.status !== 'ready');
  const recent = store.readings.filter((item) => item.status === 'ready').slice(0, 5);
  return shell(`<div class="content-wrap"><div class="page-heading"><div><div class="eyebrow">SAVED FROM THE WEB</div><h1>Inbox<span class="heading-dot">.</span></h1><p>Everything you collect arrives here first.</p></div>${searchBar()}</div>
    <div class="inbox-intro"><div><span class="overline">A LINK, THEN A READING</span><h2>Keep what is worth returning to.</h2></div><button class="outline-button" data-action="add">Paste a link ${icon('plus', 16)}</button></div>
    ${pending.length ? `<section class="list-section"><div class="section-heading"><h2>Needs attention</h2><span class="count-label">${pending.length}</span></div><div class="reading-list">${pending.map(readingRow).join('')}</div></section>` : '<div class="inbox-clear">'+icon('check', 18)+'<span>All caught up. New links will appear here.</span></div>'}
    <section class="list-section"><div class="section-heading"><h2>Recently saved</h2></div><div class="reading-list">${recent.filter((item) => `${item.title} ${item.source}`.toLowerCase().includes(search.toLowerCase())).map(readingRow).join('') || '<div class="empty">No readings match your search.</div>'}</div></section></div>`, 'Inbox');
}

function marksView() {
  const results = store.marks.filter((mark) => {
    const item = store.readings.find((entry) => entry.id === mark.readingID);
    return `${mark.quote} ${mark.note || ''} ${item?.title || ''}`.toLowerCase().includes(search.toLowerCase());
  }).sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  return shell(`<div class="content-wrap"><div class="page-heading"><div><div class="eyebrow">YOUR THINKING, IN CONTEXT</div><h1>Marks & Notes<span class="heading-dot">.</span></h1><p>Every marked passage leads back to its place in the reading.</p></div>${searchBar()}</div>
    <div class="marks-layout"><div class="marks-column"><div class="section-heading"><h2>Passages</h2><span class="count-label">${results.length}</span></div>${results.length ? results.map((mark) => {
      const item = store.readings.find((entry) => entry.id === mark.readingID);
      return `<button class="mark-result" data-jump="${esc(mark.id)}"><span class="mark-kind">${mark.kind === 'note' ? `<i class="mark-number">${noteNumber(mark)}</i>` : esc(markNames[mark.kind])}</span><span class="mark-result-main"><span class="mark-source">${esc(item?.title || 'Reading')} · ${esc(item?.source || '')}</span><strong>“${esc(mark.quote)}”</strong>${mark.note ? `<em>${esc(mark.note)}</em>` : ''}</span><span class="mark-result-arrow">${icon('arrow', 18)}</span></button>`;
    }).join('') : `<div class="empty marks-empty">${icon('mark', 24)}<strong>Your marks will gather here.</strong><p>Open a reading, select a passage, and add a highlight, underline, or note.</p><button class="outline-button" data-route="library">Browse library ${icon('arrow', 16)}</button></div>`}</div>
    <aside class="marks-aside"><span class="overline">A SMALL THOUGHT</span><p>“A mark is a record of meeting an idea.”</p><small>From A Room for Thought</small></aside></div></div>`, 'Marks & Notes');
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
  return `<div class="paragraph-wrap" data-paragraph="${index}"><p class="article-paragraph">${markedText(item, text, index)}</p>${notes.map((mark) => `<button class="note-marker" data-edit-note="${esc(mark.id)}" aria-label="Open note ${noteNumber(mark)}">${noteNumber(mark)}</button>`).join('')}</div>${figures}`;
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
  return `<div class="paragraph-wrap ${typeClass}" data-paragraph="${index}">${listPrefix}<${tag} class="article-paragraph">${markedText(item, paragraph, index, block.html)}</${tag}>${notes.map((mark) => `<button class="note-marker" data-edit-note="${esc(mark.id)}" aria-label="Open note ${noteNumber(mark)}">${noteNumber(mark)}</button>`).join('')}</div>`;
}

function readerView() {
  const item = reading();
  if (!item) return libraryView();
  if (item.status !== 'ready') {
    return shell(`<div class="content-wrap"><div class="reader-back"><button class="back-button" data-route="inbox">${icon('back', 16)} Back to Inbox</button></div><div class="review-screen"><div class="eyebrow">NEEDS REVIEW</div><h1>${esc(item.title)}</h1><p>${esc(item.issue || 'Kornu could not prepare this link.')}</p><div class="review-actions"><button class="primary-button" data-retry="${esc(item.id)}">Try again</button><a class="outline-button" href="${esc(item.url)}" target="_blank" rel="noopener noreferrer">Open original ${icon('external', 16)}</a></div></div></div>`, 'Review', 'Inbox');
  }
  if (item.snapshotStored && !item.blocks) {
    return shell('<div class="content-wrap"><div class="review-screen"><div class="eyebrow">OPENING READING</div><h1>Preparing your copy.</h1><p>Loading the article and its saved images from this browser.</p></div></div>', item.title, 'Library');
  }
  const itemMarks = marksFor(item.id);
  const count = itemMarks.length;
  const articleNote = store.articleNotes[item.id] || '';
  return shell(`<div class="reader-layout"><div class="reader-main"><div class="reader-toolbar"><button class="back-button" data-route="library">${icon('back', 17)} Library</button><div class="reader-toolbar-right"><span class="read-time">${minutes(item)} min read</span>${item.source !== 'Kornu sample' ? `<button class="plain-button recapture-button" data-retry="${esc(item.id)}" title="Capture this article again">${icon('download', 15)}<span>Recapture</span></button>` : ''}<a href="${esc(item.url)}" target="_blank" rel="noopener noreferrer" class="plain-button">Original ${icon('external', 15)}</a><button class="plain-button" data-action="toggle-marks">${icon('mark', 16)} Marks <span class="toolbar-count">${count}</span></button></div></div>
    <article class="paper" id="reading-paper"><div class="article-overline">${esc(item.source)} <span>·</span> SAVED ${day(item.savedAt).toUpperCase()}</div><h1>${esc(item.title)}</h1>${item.byline ? `<div class="article-byline">By ${esc(item.byline)}</div>` : ''}${item.subtitle ? `<p class="article-deck">${esc(item.subtitle)}</p>` : ''}${item.issue ? `<div class="capture-notice">${esc(item.issue)}</div>` : ''}<div class="article-rule"></div><div class="article-body">${item.blocks ? item.blocks.map((block) => articleBlock(item, block)).join('') : item.paragraphs.map((paragraph, index) => articleParagraph(item, paragraph, index)).join('')}</div><div class="article-end"><span class="end-mark">✳</span><p>You reached the end of this reading.</p><button class="text-link" data-action="finish">Mark as finished ${icon('check', 15)}</button></div></article></div>
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
      button.style.top = `${Math.max(2, rect.top - wrap.getBoundingClientRect().top + rect.height / 2 - 12)}px`;
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
    item.issue = error.message || 'The saved copy could not be opened.';
    save();
  } finally {
    loadingSnapshots.delete(id);
    if (generation === accountGeneration && view === 'reader' && readerID === id) render();
  }
}

function render() {
  const sameReader = view === 'reader' && lastRenderedReader === readerID && Boolean($('#reading-paper'));
  const previousScroll = sameReader ? window.scrollY : null;
  const item = reading();
  if (view === 'reader' && item?.status === 'ready' && item.snapshotStored && !item.blocks && !loadingSnapshots.has(item.id)) hydrateReading(item.id);
  if (view === 'reader') $('#app').innerHTML = readerView();
  else if (view === 'inbox') $('#app').innerHTML = inboxView();
  else if (view === 'marks') $('#app').innerHTML = marksView();
  else $('#app').innerHTML = libraryView();
  positionMarkers();
  if (view === 'reader') {
    if (sameReader) requestAnimationFrame(() => window.scrollTo({ top: previousScroll, behavior: 'instant' }));
    else restorePosition();
  }
  lastRenderedReader = view === 'reader' ? readerID : null;
}

function restorePosition() {
  const item = reading(); if (!item) return;
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
  showModal(`<div class="modal-overline">ADD TO KORNU</div><button class="modal-close" data-action="close-modal" aria-label="Close">${icon('close')}</button><h2>Save a link.</h2><p>Kornu will prepare a clean reading copy when the article is available.</p><form id="add-form"><label for="article-url">Article URL</label><input id="article-url" type="url" placeholder="https://example.com/article" required autofocus><div class="modal-actions"><button type="button" class="outline-button" data-action="close-modal">Cancel</button><button class="primary-button" type="submit">Save reading ${icon('arrow', 16)}</button></div></form><div class="modal-footnote">Some sites block extraction or show only a preview. You can always open the original.</div>`);
}

function noteModal(mark) {
  showModal(`<div class="modal-overline">PASSAGE NOTE ${noteNumber(mark)}</div><button class="modal-close" data-action="close-modal" aria-label="Close">${icon('close')}</button><h2>A thought on this line.</h2><blockquote>“${esc(mark.quote)}”</blockquote><form id="note-form" data-id="${esc(mark.id)}"><label for="note-text">Your note</label><textarea id="note-text" rows="6" placeholder="Write what this passage brought to mind…">${esc(mark.note || '')}</textarea><div class="modal-actions"><button type="button" class="danger-link" data-delete-mark="${esc(mark.id)}">Delete note</button><button class="primary-button" type="submit">Save thought ${icon('check', 16)}</button></div></form>`);
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
  store.marks.push(mark); save(readerID); hideSelection(); render();
  if (kind === 'note') noteModal(mark);
  else notify(`${markNames[kind]} saved.`);
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
  item.status = 'preparing'; item.issue = ''; save(item.id); render(); notify('Preparing your reading…');
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
    const archive = { version: 2, exportedAt: new Date().toISOString(), ...compactStore(), snapshots, assets };
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
  if (generation === accountGeneration && view === 'library') render();
}

document.addEventListener('click', (event) => {
  const target = event.target.closest('[data-route],[data-open],[data-action],[data-filter],[data-mark-kind],[data-edit-note],[data-delete-mark],[data-jump],[data-retry]');
  if (!target) {
    if (event.target.classList.contains('modal-backdrop')) closeModal();
    return;
  }
  if (target.dataset.route) { hideSelection(); route(target.dataset.route); return; }
  if (target.dataset.open) { hideSelection(); route('reader', target.dataset.open); return; }
  if (target.dataset.filter) { filter = target.dataset.filter; render(); return; }
  if (target.dataset.markKind) { addMark(target.dataset.markKind); return; }
  if (target.dataset.editNote) { const mark = store.marks.find((entry) => entry.id === target.dataset.editNote); if (mark) noteModal(mark); return; }
  if (target.dataset.deleteMark) { const mark = store.marks.find((entry) => entry.id === target.dataset.deleteMark); store.marks = store.marks.filter((entry) => entry.id !== target.dataset.deleteMark); save(mark?.readingID); closeModal(); render(); notify('Note removed.'); return; }
  if (target.dataset.jump) { jumpTo(target.dataset.jump); return; }
  if (target.dataset.retry) { const item = store.readings.find((entry) => entry.id === target.dataset.retry); if (item) { route('inbox'); importLink(item.url, item.id); } return; }
  const action = target.dataset.action;
  if (action === 'add') addModal();
  else if (action === 'account') accountModal();
  else if (action === 'sign-in-google') cloud.signIn().catch((error) => notify(error.message || 'Google sign-in could not start.'));
  else if (action === 'sign-out') cloud.signOut().then(() => { closeModal(); switchAccount(null); }).catch((error) => notify(error.message || 'Sign out failed.'));
  else if (action === 'copy-browser-library') copyBrowserLibrary();
  else if (action === 'close-modal') closeModal();
  else if (action === 'focus-search') { if (view === 'reader') route('library'); requestAnimationFrame(() => $('#library-search')?.focus()); }
  else if (action === 'toggle-marks') { showReaderMarks = !showReaderMarks; render(); }
  else if (action === 'article-note') articleNoteModal();
  else if (action === 'finish') { store.progress[readerID] = 100; save(readerID); notify('Marked as finished.'); }
  else if (action === 'backup') backup();
});

document.addEventListener('submit', (event) => {
  event.preventDefault();
  if (event.target.id === 'add-form') {
    const url = $('#article-url').value.trim();
    if (store.readings.some((item) => item.url === url && !item.id.startsWith('sample-'))) { closeModal(); notify('This link is already in your library.'); return; }
    closeModal(); route('inbox'); importLink(url);
  } else if (event.target.id === 'note-form') {
    const mark = store.marks.find((entry) => entry.id === event.target.dataset.id);
    if (mark) { mark.note = $('#note-text').value.trim(); save(mark.readingID); closeModal(); render(); notify('Thought saved.'); }
  } else if (event.target.id === 'article-note-form') {
    store.articleNotes[readerID] = $('#article-note-text').value.trim(); save(readerID); closeModal(); render(); notify('Reading note saved.');
  }
});

document.addEventListener('input', (event) => {
  if (event.target.id === 'library-search') {
    search = event.target.value;
    const caret = event.target.selectionStart;
    render();
    const input = $('#library-search'); input?.focus(); input?.setSelectionRange(caret, caret);
  }
});

document.addEventListener('mouseup', () => setTimeout(inspectSelection, 0));
document.addEventListener('touchend', () => setTimeout(inspectSelection, 180), { passive: true });
document.addEventListener('keyup', (event) => {
  if (event.key === 'Escape') { closeModal(); hideSelection(); return; }
  if (event.key === 'ArrowLeft' || event.key === 'ArrowRight' || event.key === 'Shift') setTimeout(inspectSelection, 0);
});
document.addEventListener('keydown', (event) => {
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); if (view === 'reader') route('library'); requestAnimationFrame(() => $('#library-search')?.focus()); }
});
window.addEventListener('resize', positionMarkers);
window.addEventListener('scroll', () => {
  if (view !== 'reader' || !reading()) return;
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
  window.scrollTo({ top: 0, behavior: 'instant' }); render();
});

render();
preloadCovers();
if (cloud.configured) {
  cloud.onAuthChange((user) => switchAccount(user));
  cloud.session().then((session) => switchAccount(session?.user || null))
    .catch((error) => notify(error.message || 'Your account could not be opened.'));
}
