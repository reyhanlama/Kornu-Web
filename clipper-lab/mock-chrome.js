// This runs only inside the local preview iframe, before the real popup.js.
const preview = window.__clipperPreviewConfig;
const announce = (label, state = '') => window.parent.postMessage({ kornuClipperPreview: true, label, state }, '*');
let clipState = '';
let readingID = 'preview-reading';
let timers = [];
let savedSiteURL = preview.siteURL;

function startCapture() {
  for (const timer of timers) clearTimeout(timer);
  if (preview.previewStage && preview.previewStage !== 'auto') {
    clipState = preview.previewStage === 'result'
      ? preview.scenario === 'review' ? 'review' : preview.scenario === 'local' ? 'saved-local' : 'saved'
      : preview.previewStage;
    announce(`Holding the ${preview.previewStage} state`, clipState);
    return;
  }
  clipState = 'initializing';
  announce('Opening the Kornu library', clipState);
  const stages = [
    [350, 'capturing', 'Preparing article text'],
    [1200, 'images', 'Saving article images'],
    [2150, 'syncing', 'Saving to the library'],
    [3050, preview.scenario === 'review' ? 'review' : preview.scenario === 'local' ? 'saved-local' : 'saved', 'Capture finished']
  ];
  timers = stages.map(([delay, state, label]) => setTimeout(() => {
    clipState = state;
    announce(label, state);
  }, delay));
}

window.chrome = {
  runtime: { getManifest: () => preview.manifest },
  storage: { local: {
    get: async () => ({ kornuSiteURL: savedSiteURL }),
    set: async (value) => { savedSiteURL = value.kornuSiteURL; announce(`Destination set to ${savedSiteURL}`); }
  } },
  permissions: {
    contains: async ({ origins }) => preview.scenario !== 'permission' && /^http:\/\/(127\.0\.0\.1|localhost)\//.test(origins[0]),
    request: async () => {
      const allowed = preview.scenario !== 'permission';
      announce(allowed ? 'Site access granted' : 'Site access declined', allowed ? '' : 'permission');
      return allowed;
    }
  },
  tabs: {
    query: async () => [{ url: preview.scenario === 'unsupported' ? 'chrome://settings' : preview.articleURL, title: preview.articleTitle }],
    create: async ({ url, active }) => {
      if (active === false && preview.scenario === 'active') {
        announce('Browser requires an active tab');
        throw new Error('Owl extension-created tabs must be active.');
      }
      if (url.includes('#/clip?')) {
        announce(active ? 'Kornu opened in an active tab' : 'Kornu opened in a background tab');
        startCapture();
      } else announce('Opened the saved reading');
      return { id: 42 };
    },
    remove: async () => { announce('Background tab closed'); },
    update: async () => { announce('Kornu tab brought forward'); }
  },
  scripting: { executeScript: async () => [{ result: { state: clipState, readingID, issue: preview.scenario === 'review' ? 'This site did not return a readable article.' : '' } }] }
};

window.close = () => announce('Popup closed', 'handoff');
