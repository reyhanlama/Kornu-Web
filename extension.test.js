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
  const calls = { opened: [], saved: [], checked: [], requested: [], removed: [], closed: 0 };
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
      update: async () => {}
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
  assert.equal(document.querySelector('#site-name').textContent, '127.0.0.1:4174');
  assert.equal(document.querySelector('#save').disabled, false);

  document.querySelector('#save').click();
  await tick();
  assert.equal(calls.opened.length, 1);
  const opened = new URL(calls.opened[0].url);
  assert.equal(opened.origin, 'http://127.0.0.1:4174');
  assert.equal(calls.opened[0].active, false);
  assert.equal(new URLSearchParams(opened.hash.slice(7)).get('url'), 'https://example.com/article?a=1#section');
  assert.equal(calls.saved[0].kornuSiteURL, 'http://127.0.0.1:4174/');
  assert.deepEqual(Array.from(calls.checked[0].origins), ['http://127.0.0.1/*']);
  assert.equal(calls.requested.length, 0);
  assert.deepEqual(calls.removed, [42]);
  assert.equal(document.querySelector('.save-label').textContent, 'Open reading');
  assert.match(document.querySelector('#message').textContent, /Saved to your Kornu library/);

  document.querySelector('#save').click();
  await tick();
  assert.equal(calls.opened[1].url, 'http://127.0.0.1:4174/#/reader/reading-1');
  assert.equal(calls.opened[1].active, true);
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
  await tick();
  assert.deepEqual(calls.opened.map((tab) => tab.active), [false, true]);
  assert.equal(calls.opened[1].url, calls.opened[0].url);
  assert.match(calls.opened[1].url, /#\/clip\?url=/);
  assert.equal(calls.closed, 1);
  assert.deepEqual(calls.removed, []);
  assert.match(document.querySelector('#message').textContent, /active tab to finish saving/);
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
    { state: 'review', readingID: 'reading-2' }
  );
  await tick();
  document.querySelector('#save').click();
  await tick();
  assert.equal(document.querySelector('.save-label').textContent, 'Review in Kornu');
  assert.match(document.querySelector('#message').textContent, /needs a closer look/);
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
  assert.match(document.querySelector('#message').textContent, /Allow access to your Kornu site/);
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
