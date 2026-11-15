import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';

const html = readFileSync(new URL('./extension/popup.html', import.meta.url), 'utf8');
const script = readFileSync(new URL('./extension/popup.js', import.meta.url), 'utf8');
const manifest = JSON.parse(readFileSync(new URL('./extension/manifest.json', import.meta.url), 'utf8'));
const tick = () => new Promise((resolve) => setImmediate(resolve));

function popup(tab, state = { state: 'saved', readingID: 'reading-1' }, permissionAllowed = true, loadedManifest = manifest, inactiveTabError = null) {
  const dom = new JSDOM(html, { url: 'https://kornu.test/', runScripts: 'outside-only' });
  const calls = { opened: [], saved: [], checked: [], requested: [], removed: [], updated: [], closed: 0 };
  dom.window.chrome = {
    runtime: { getManifest: () => loadedManifest },
    storage: { local: {
      get: async () => ({}),
      set: async (value) => { calls.saved.push(value); }
    } },
    tabs: {
      query: async () => [tab],
      create: async (value) => {
        calls.opened.push(value);
        if (value.active === false && inactiveTabError) throw inactiveTabError;
        return { id: 42 };
      },
      remove: async (id) => { calls.removed.push(id); },
      update: async (id, value) => { calls.updated.push({ id, value }); }
    },
    permissions: {
      contains: async (value) => {
        calls.checked.push(value);
        return loadedManifest.host_permissions?.includes(value.origins[0]) || false;
      },
      request: async (value) => {
        calls.requested.push(value);
        if (permissionAllowed instanceof Error) throw permissionAllowed;
        return permissionAllowed;
      }
    },
    scripting: { executeScript: async () => [{ result: state }] }
  };
  dom.window.close = () => { calls.closed++; };
  dom.window.eval(script);
  return { dom, calls, document: dom.window.document };
}

test('clipper captures in a background Kornu tab and offers to open the saved reading', async () => {
  const { document, calls } = popup({ url: 'https://example.com/article?a=1#section', title: 'An article' });
  await tick();
  assert.equal(document.querySelector('#page-title').textContent, 'An article');
  assert.equal(document.querySelector('#site-url').value, 'https://kornu.netlify.app/');
  assert.equal(document.querySelector('.destination-label').textContent, 'Kornu library');
  assert.equal(document.querySelector('#save').disabled, false);

  document.querySelector('#save').click();
  await tick();
  assert.equal(calls.opened.length, 1);
  const opened = new URL(calls.opened[0].url);
  assert.equal(opened.origin, 'https://kornu.netlify.app');
  assert.equal(calls.opened[0].active, false);
  assert.equal(new URLSearchParams(opened.hash.slice(7)).get('url'), 'https://example.com/article?a=1#section');
  assert.equal(calls.saved[0].kornuSiteURL, 'https://kornu.netlify.app/');
  assert.deepEqual(Array.from(calls.checked[0].origins), ['https://kornu.netlify.app/*']);
  assert.equal(calls.requested.length, 0);
  assert.deepEqual(calls.removed, [42]);
  assert.equal(document.querySelector('.save-label').textContent, 'Open reading');
  assert.equal(document.querySelector('#page-title').textContent, 'Saved to your library.');
  assert.equal(document.querySelector('#article-context').textContent, 'An article');
  assert.equal(document.querySelector('#message').textContent, '');

  document.querySelector('#save').click();
  await tick();
  assert.equal(calls.opened[1].url, 'https://kornu.netlify.app/#/reader/reading-1');
  assert.equal(calls.opened[1].active, true);
});

test('changing the destination after saving keeps the current reading link', async () => {
  const { document, calls, dom } = popup({ url: 'https://example.com/article', title: 'Article' });
  await tick();
  document.querySelector('#save').click();
  await tick();
  const site = document.querySelector('#site-url');
  assert.equal(site.disabled, false);
  site.value = 'https://new.kornu.example/';
  site.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  site.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
  await tick();
  assert.equal(calls.saved.at(-1).kornuSiteURL, 'https://new.kornu.example/');
  assert.match(document.querySelector('#site-hint').textContent, /saved for your next clip/);
  document.querySelector('#save').click();
  await tick();
  assert.equal(calls.opened.at(-1).url, 'https://kornu.netlify.app/#/reader/reading-1');
});

test('clipper waits for sign-in and reuses the pending Kornu tab', async () => {
  const { document, calls } = popup(
    { url: 'https://example.com/article', title: 'Article' },
    { state: 'auth-required' }
  );
  await tick();
  document.querySelector('#save').click();
  await tick();
  assert.equal(document.querySelector('#page-title').textContent, 'Sign in to save.');
  assert.equal(document.querySelector('.save-label').textContent, 'Continue in Kornu');
  assert.match(document.querySelector('#message').textContent, /article is waiting/);
  assert.deepEqual(calls.removed, []);
  document.querySelector('#save').click();
  await tick();
  assert.equal(calls.updated.length, 1);
  assert.equal(calls.updated[0].id, 42);
  assert.equal(calls.updated[0].value.active, true);
  assert.equal(calls.closed, 1);
});

test('clipper explains when the selected Kornu site has no account setup', async () => {
  const { document, calls } = popup(
    { url: 'https://example.com/article', title: 'Article' },
    { state: 'setup-required' }
  );
  await tick();
  document.querySelector('#save').click();
  await tick();
  assert.match(document.querySelector('#message').textContent, /needs account storage set up/);
  assert.equal(calls.removed[0], 42);
});

test('clipper opens an active Kornu reading when the browser disallows hidden tabs', async () => {
  const { document, calls } = popup(
    { url: 'https://example.com/story', title: 'Story' },
    undefined,
    true,
    manifest,
    new Error('Owl extension-created tabs must be active.')
  );
  await tick();
  document.querySelector('#save').click();
  await new Promise((resolve) => setTimeout(resolve, 370));
  assert.deepEqual(calls.opened.map((tab) => tab.active), [false, true]);
  assert.equal(calls.opened[1].url, calls.opened[0].url);
  assert.match(calls.opened[1].url, /#\/clip\?url=/);
  assert.equal(calls.closed, 1);
  assert.deepEqual(calls.removed, []);
  assert.equal(document.querySelector('#page-title').textContent, 'Opening in Kornu.');
  assert.match(document.querySelector('#message').textContent, /active Kornu tab/);
});

test('clipper disables unsupported tabs and keeps an invalid destination editable', async () => {
  const unsupported = popup({ url: 'chrome://settings', title: 'Settings' });
  await tick();
  assert.equal(unsupported.document.querySelector('#save').disabled, true);

  const { document, calls } = popup({ url: 'https://example.com/story', title: 'Story' });
  await tick();
  document.querySelector('#site-url').value = 'not a URL';
  document.querySelector('#save').click();
  await tick();
  assert.equal(calls.opened.length, 0);
  assert.equal(document.querySelector('details').open, true);
  assert.match(document.querySelector('#message').textContent, /valid web address/);
  assert.equal(document.querySelector('#save').disabled, false);
});

test('clipper shows review when article capture cannot be completed', async () => {
  const { document, calls } = popup(
    { url: 'https://example.com/story', title: 'Story' },
    { state: 'review', readingID: 'reading-2', issue: 'The article site returned 403.' }
  );
  await tick();
  document.querySelector('#save').click();
  await tick();
  assert.equal(document.querySelector('.save-label').textContent, 'Review capture');
  assert.equal(document.querySelector('#page-title').textContent, 'Needs a quick check.');
  assert.equal(document.querySelector('#article-context').textContent, 'Story');
  assert.match(document.querySelector('#message').textContent, /returned 403/);
  assert.deepEqual(calls.removed, [42]);
});

test('clipper distinguishes a local save from completed profile sync', async () => {
  const { document, calls } = popup(
    { url: 'https://example.com/story', title: 'Story' },
    { state: 'saved-local', readingID: 'reading-3' }
  );
  await tick();
  document.querySelector('#save').click();
  await tick();
  assert.equal(document.querySelector('.save-label').textContent, 'Open reading');
  assert.equal(document.querySelector('#page-title').textContent, 'Saved on this browser.');
  assert.match(document.querySelector('#message').textContent, /Profile sync will retry later/);
  assert.deepEqual(calls.removed, [42]);
});

test('clipper does not open Kornu if site access is declined', async () => {
  const { document, calls } = popup({ url: 'https://example.com/story', title: 'Story' }, undefined, false);
  await tick();
  document.querySelector('#site-url').value = 'https://kornu.example/';
  document.querySelector('#save').click();
  await tick();
  assert.equal(calls.opened.length, 0);
  assert.deepEqual(Array.from(calls.requested[0].origins), ['https://kornu.example/*']);
  assert.equal(document.querySelector('#page-title').textContent, 'Allow Kornu access.');
  assert.equal(document.querySelector('.save-label').textContent, 'Allow access & save');
  assert.match(document.querySelector('#message').textContent, /needs access to your Kornu site/);
  assert.equal(document.querySelector('#save').disabled, false);
});

test('clipper explains how to refresh a stale Chrome manifest', async () => {
  const { document, calls } = popup(
    { url: 'https://example.com/story', title: 'Story' },
    undefined,
    true,
    { ...manifest, host_permissions: [], optional_host_permissions: [] }
  );
  await tick();
  document.querySelector('#save').click();
  await tick();
  assert.equal(calls.requested.length, 0);
  assert.equal(calls.opened.length, 0);
  assert.match(document.querySelector('#message').textContent, /chrome:\/\/extensions.*reload Kornu Clipper/i);
});

test('clipper translates Chrome’s raw manifest error into a recovery step', async () => {
  const { document, calls } = popup(
    { url: 'https://example.com/story', title: 'Story' },
    undefined,
    new Error('Only permissions specified in the manifest may be requested.')
  );
  await tick();
  document.querySelector('#site-url').value = 'https://kornu.example/';
  document.querySelector('#save').click();
  await tick();
  assert.equal(calls.opened.length, 0);
  assert.match(document.querySelector('#message').textContent, /Reload the extension at chrome:\/\/extensions/);
});
