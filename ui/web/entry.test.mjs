// The way into the web variant: the picker, the folders used before, the permission after a restart, and the state
// machine that joins them. A fake window, fake folder handles and a small fake IndexedDB: no browser.
//
//   node --experimental-strip-types --test web/entry.test.mjs        (from ui/)

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Entry, mountFolder } from '../src/web/entry.ts';
import {
  displayName,
  grantAccess,
  idbKeyValue,
  MAX_RECENT,
  oneLine,
  permissionOf,
  pickerSupport,
  pickFolder,
  PICKER_ID,
  RecentFolders,
} from '../src/web/folder.ts';
import { VaultLimitError } from '../src/web/vault-files.ts';

const enc = (s) => new TextEncoder().encode(s);

function domError(name, message = name) {
  return Object.assign(new Error(message), { name });
}

/** A folder handle. `perm` is what queryPermission says, `onRequest` what requestPermission does. */
function handle(name, { perm = 'granted', tree = {}, onRequest, same = [], log = [] } = {}) {
  const h = {
    kind: 'directory',
    name,
    perm,
    async queryPermission() {
      log.push(`query ${name}`);
      if (h.perm instanceof Error) throw h.perm;
      return h.perm;
    },
    async requestPermission() {
      log.push(`request ${name}`);
      if (onRequest) return onRequest(h);
      h.perm = 'granted';
      return 'granted';
    },
    async isSameEntry(other) {
      return same.includes(other.name);
    },
    async *values() {
      for (const [n, v] of Object.entries(tree)) {
        yield { kind: 'file', name: n, getFile: async () => ({ size: v.length, arrayBuffer: async () => enc(v).buffer }) };
      }
    },
  };
  return h;
}

function memoryKv() {
  const map = new Map();
  return { map, get: async (k) => map.get(k), put: async (k, v) => void map.set(k, v) };
}

const SECURE = (showDirectoryPicker) => ({ showDirectoryPicker, isSecureContext: true });

test('which windows can choose a folder', () => {
  assert.equal(pickerSupport({}), 'missing');
  assert.equal(pickerSupport({ showDirectoryPicker: 3 }), 'missing');
  assert.equal(pickerSupport({ showDirectoryPicker: () => {}, isSecureContext: false }), 'insecure');
  assert.equal(pickerSupport({ showDirectoryPicker: () => {}, isSecureContext: true }), 'ok');
  assert.equal(pickerSupport({ showDirectoryPicker: () => {} }), 'ok');
});

test('the picker is asked with the id and the mode, and each way it fails is told apart', async () => {
  const asked = [];
  const h = handle('v');
  assert.deepEqual(await pickFolder(SECURE(async (o) => (asked.push(o), h))), { kind: 'picked', handle: h });
  assert.deepEqual(asked, [{ id: PICKER_ID, mode: 'readwrite' }]);
  assert.deepEqual(await pickFolder(SECURE(async () => { throw domError('AbortError'); })), { kind: 'cancelled' });
  for (const name of ['SecurityError', 'NotAllowedError']) {
    const r = await pickFolder(SECURE(async () => { throw domError(name, 'blocked by policy'); }));
    assert.equal(r.kind, 'blocked', name);
    assert.match(r.message, /blocked by policy/);
  }
  const odd = await pickFolder(SECURE(async () => { throw new Error('line1\nline2\u0007' + 'x'.repeat(500)); }));
  assert.equal(odd.kind, 'failed');
  assert.ok(odd.message.length <= 200 && !/[\u0000-\u001f]/.test(odd.message), 'one short line');
  assert.equal((await pickFolder({})).kind, 'failed');
  assert.equal(oneLine('a\tb'), 'a b');
  assert.equal(displayName('a\nb'), 'a b');
  assert.equal(displayName(7), '');
});

test('the permission of a stored folder, and asking for it again', async () => {
  for (const state of ['granted', 'prompt', 'denied']) {
    assert.equal(await permissionOf(handle('v', { perm: state })), state);
  }
  assert.equal(await permissionOf(handle('v', { perm: domError('NotFoundError') })), 'gone');
  assert.equal(await permissionOf(handle('v', { perm: domError('Whatever') })), 'denied', 'a failure is no permission');
  assert.equal(await grantAccess(handle('v', { perm: 'prompt' })), 'granted');
  assert.equal(await grantAccess(handle('v', { onRequest: () => 'denied' })), 'denied');
  assert.equal(await grantAccess(handle('v', { onRequest: () => { throw domError('NotFoundError'); } })), 'gone');
});

test('the folders used before: newest first, one entry per folder, a limit, and a list that is not trusted', async () => {
  const kv = memoryKv();
  let n = 0;
  const recent = new RecentFolders(kv, { newId: () => `id${++n}` });
  assert.deepEqual(await recent.list(), []);
  // The stored handle answers `isSameEntry`: it knows the handle named 'a-again' as itself.
  const a = handle('a', { same: ['a-again'] });
  const b = handle('b');
  await recent.remember(a, 100);
  await recent.remember(b, 200);
  assert.deepEqual((await recent.list()).map((r) => r.name), ['b', 'a']);

  // Another handle for a folder that is in the list moves it up and keeps its id.
  const moved = await recent.remember(handle('a-again'), 300);
  assert.equal(moved.id, 'id1', 'the id of the folder stays');
  assert.deepEqual((await recent.list()).map((r) => r.name), ['a-again', 'b']);

  // A handle that is not the same entry is another folder, also under the same name.
  await recent.remember(handle('b'), 350);
  assert.deepEqual((await recent.list()).map((r) => r.name), ['b', 'a-again', 'b']);
  await recent.forget((await recent.list())[0].id);

  for (let i = 0; i < 8; i++) await recent.remember(handle(`f${i}`), 1000 + i);
  const names = (await recent.list()).map((r) => r.name);
  assert.equal(names.length, MAX_RECENT);
  assert.equal(names[0], 'f7');

  await recent.forget((await recent.list())[0].id);
  assert.equal((await recent.list()).length, MAX_RECENT - 1);
});

test('what is stored is checked: an entry that is no folder is dropped, a failing store is an empty list', async () => {
  const kv = memoryKv();
  const good = handle('good\u0001name');
  kv.map.set('recent', [
    null,
    3,
    { id: 'x' },
    { id: '', handle: good, lastUsed: 1 },
    { id: 'a', handle: { kind: 'file', name: 'f' }, lastUsed: 1 },
    { id: 'b', handle: { kind: 'directory', name: 'no functions' }, lastUsed: 1 },
    { id: 'ok', handle: good, lastUsed: 5 },
    { id: 'ok', handle: good, lastUsed: 9 },
    { id: 'nan', handle: handle('n'), lastUsed: Number.NaN },
  ]);
  const recent = new RecentFolders(kv);
  const list = await recent.list();
  assert.deepEqual(list.map((r) => [r.id, r.name, r.lastUsed]), [['ok', 'good name', 5], ['nan', 'n', 0]]);
  kv.map.set('recent', 'not a list');
  assert.deepEqual(await recent.list(), []);
  const broken = new RecentFolders({ get: async () => { throw new Error('idb closed'); }, put: async () => {} });
  assert.deepEqual(await broken.list(), []);
});

function entryOver({ win, recent = new RecentFolders(memoryKv()), open, now = () => 7, forgotten } = {}) {
  const states = [];
  const entry = new Entry({ win, recent, open: open ?? (async () => ({ files: 3, skipped: [] })), now, forgotten });
  entry.subscribe((s) => states.push(s.step));
  return { entry, states, recent };
}

test('a window that cannot choose a folder says why, and never offers the picker', async () => {
  const { entry } = entryOver({ win: {} });
  await entry.start();
  assert.deepEqual(entry.state, { step: 'unsupported', reason: 'missing' });
  const insecure = entryOver({ win: { showDirectoryPicker() {}, isSecureContext: false } });
  await insecure.entry.start();
  assert.deepEqual(insecure.entry.state, { step: 'unsupported', reason: 'insecure' });
});

test('the start page lists the folders used before with the access each has now', async () => {
  const recent = new RecentFolders(memoryKv());
  await recent.remember(handle('kept', { perm: 'granted' }), 3);
  await recent.remember(handle('asks', { perm: 'prompt' }), 2);
  await recent.remember(handle('moved', { perm: domError('NotFoundError') }), 1);
  const { entry } = entryOver({ win: SECURE(async () => handle('x')), recent });
  await entry.start();
  assert.equal(entry.state.step, 'choose');
  assert.deepEqual(entry.state.recent.map((r) => [r.name, r.access]), [['kept', 'granted'], ['asks', 'prompt'], ['moved', 'gone']]);
  assert.equal(entry.state.notice, null);
});

test('choosing a folder opens it and remembers it', async () => {
  const opened = [];
  const picked = handle('vault');
  const { entry, states, recent } = entryOver({
    win: SECURE(async () => picked),
    open: async (h) => (opened.push(h.name), { files: 12, skipped: [{ path: 'big.md', reason: 'too-large' }] }),
    now: () => 4242,
  });
  await entry.start();
  await entry.pick();
  assert.deepEqual(opened, ['vault']);
  const [remembered] = await recent.list();
  assert.deepEqual(entry.state, { step: 'open', name: 'vault', files: 12, skipped: [{ path: 'big.md', reason: 'too-large' }], folder: remembered.id, readOnly: false });
  assert.deepEqual(states, ['choose', 'opening', 'open']);
  const list = await recent.list();
  assert.deepEqual(list.map((r) => [r.name, r.lastUsed]), [['vault', 4242]]);
});

test('a refused or cancelled picker returns to the start page with the reason', async () => {
  for (const [error, code] of [['AbortError', 'cancelled'], ['SecurityError', 'blocked'], ['NotAllowedError', 'blocked'], ['Odd', 'failed']]) {
    const { entry } = entryOver({ win: SECURE(async () => { throw domError(error, 'because'); }) });
    await entry.start();
    await entry.pick();
    assert.equal(entry.state.step, 'choose', error);
    assert.equal(entry.state.notice.code, code, error);
  }
});

test('a folder that cannot be read returns to the start page, and nothing is remembered', async () => {
  const cases = [
    [new VaultLimitError('maxFiles', 'more than 5 files'), 'limit', /more than 5 files/],
    [domError('NotFoundError'), 'gone', undefined],
    [domError('NotAllowedError'), 'denied', undefined],
    [new Error('disk\nfull'), 'failed', /disk full/],
  ];
  for (const [error, code, detail] of cases) {
    const recent = new RecentFolders(memoryKv());
    const { entry } = entryOver({ win: SECURE(async () => handle('v')), recent, open: async () => { throw error; } });
    await entry.start();
    await entry.pick();
    assert.equal(entry.state.step, 'choose', code);
    assert.equal(entry.state.notice.code, code);
    if (detail) assert.match(entry.state.notice.detail, detail);
    assert.deepEqual(await recent.list(), [], 'a folder that did not open is not remembered');
  }
});

test('a folder used before: a kept permission opens at once, a dropped one is asked for first', async () => {
  const log = [];
  const recent = new RecentFolders(memoryKv(), { newId: (() => { let n = 0; return () => `r${++n}`; })() });
  await recent.remember(handle('kept', { perm: 'granted', log }), 3);
  await recent.remember(handle('asks', { perm: 'prompt', log }), 2);
  const opened = [];
  const { entry } = entryOver({ win: SECURE(async () => handle('x')), recent, open: async (h) => (log.push(`open ${h.name}`), opened.push(h.name), { files: 1, skipped: [] }) });
  await entry.start();
  log.length = 0;

  await entry.openRecent('r1');
  assert.deepEqual(log, ['query kept', 'open kept'], 'no question when the permission is there');

  await entry.start();
  log.length = 0;
  await entry.openRecent('r2');
  assert.deepEqual(log, ['query asks', 'request asks', 'open asks'], 'the question comes before the reading, right after the click');
  assert.equal(entry.state.step, 'open');
});

test('a permission that is refused, or a folder that is gone, never reaches the reader', async () => {
  const recent = new RecentFolders(memoryKv(), { newId: (() => { let n = 0; return () => `r${++n}`; })() });
  await recent.remember(handle('denied', { perm: 'prompt', onRequest: () => 'denied' }), 1);
  await recent.remember(handle('gone', { perm: domError('NotFoundError') }), 2);
  let opened = 0;
  const { entry } = entryOver({ win: SECURE(async () => handle('x')), recent, open: async () => (opened++, { files: 0, skipped: [] }) });
  await entry.start();
  await entry.openRecent('r1');
  assert.equal(entry.state.notice.code, 'denied');
  await entry.openRecent('r2');
  assert.equal(entry.state.notice.code, 'gone');
  await entry.openRecent('nope');
  assert.equal(entry.state.step, 'choose');
  assert.equal(opened, 0);
});

test('forgetting a folder removes it from the list; a listener is told, and stops when it unsubscribes', async () => {
  const recent = new RecentFolders(memoryKv(), { newId: () => 'only' });
  await recent.remember(handle('a'), 1);
  const { entry } = entryOver({ win: SECURE(async () => handle('x')), recent });
  const seen = [];
  const off = entry.subscribe((s) => seen.push(s.step));
  await entry.start();
  assert.equal(entry.state.recent.length, 1);
  await entry.forget('only');
  assert.equal(entry.state.recent.length, 0);
  off();
  await entry.start();
  assert.deepEqual(seen, ['choose', 'choose'], 'nothing after unsubscribe');
});

test('forgetting a folder tells the page, so that it drops what it kept for that folder', async () => {
  const recent = new RecentFolders(memoryKv(), { newId: (() => { let n = 0; return () => `r${++n}`; })() });
  await recent.remember(handle('a'), 1);
  await recent.remember(handle('b'), 2);
  const told = [];
  const { entry } = entryOver({ win: SECURE(async () => handle('x')), recent, forgotten: async (id) => void told.push(id) });
  await entry.start();
  await entry.forget('r1');
  assert.deepEqual(told, ['r1']);
  assert.deepEqual((await recent.list()).map((r) => r.id), ['r2']);
});

test('a page that cannot drop what it kept does not keep the folder in the list', async () => {
  const recent = new RecentFolders(memoryKv(), { newId: () => 'only' });
  await recent.remember(handle('a'), 1);
  const { entry } = entryOver({
    win: SECURE(async () => handle('x')),
    recent,
    forgotten: async () => {
      throw new Error('quota');
    },
  });
  await entry.start();
  await entry.forget('only');
  assert.deepEqual(await recent.list(), []);
  assert.equal(entry.state.step, 'choose');
});

test('mountFolder reads the folder and hands the files to the engine', async () => {
  const mounted = [];
  const client = { mount: async (root, files) => (mounted.push([root, [...files.keys()]]), files.size) };
  const h = handle('v', { tree: { 'a.md': 'A', 'notes.txt': 'no', 'b.md': 'B' } });
  assert.deepEqual(await mountFolder(client, '/vault', h), { files: 2, skipped: [] });
  assert.deepEqual(mounted, [['/vault', ['a.md', 'b.md']]]);
});

// -- IndexedDB --------------------------------------------------------------------------------------------------------

/** Just enough of IndexedDB for a store with put and get: requests answer on a later turn, like the real ones. */
function fakeIdb({ failOpen = 0, abortWrites = false } = {}) {
  const stores = new Map();
  let opens = 0;
  const later = (fn) => queueMicrotask(() => queueMicrotask(fn));
  return {
    opens: () => opens,
    open(name) {
      opens++;
      const request = { result: null, error: null };
      later(() => {
        if (opens <= failOpen) {
          request.error = new Error('open failed');
          request.onerror?.();
          return;
        }
        const db = {
          createObjectStore: (store) => stores.set(store, new Map()),
          transaction(store) {
            const tx = { error: null };
            return Object.assign(tx, {
              objectStore: () => ({
                put(value, key) {
                  const req = { result: key };
                  later(() => {
                    if (abortWrites) {
                      tx.error = new Error('quota');
                      tx.onabort?.();
                    } else {
                      stores.get(store).set(key, structuredClone(value));
                      tx.oncomplete?.();
                    }
                  });
                  return req;
                },
                get(key) {
                  const req = { result: undefined };
                  later(() => {
                    req.result = stores.get(store).get(key);
                    tx.oncomplete?.();
                  });
                  return req;
                },
              }),
            });
          },
        };
        request.result = db;
        if (!stores.size) {
          // the first open of the database: the upgrade comes before success
          Object.defineProperty(request, 'result', { value: db });
          request.onupgradeneeded?.();
        }
        request.onsuccess?.();
      });
      return request;
    },
  };
}

test('the IndexedDB store keeps a value under a key', async () => {
  const kv = idbKeyValue(fakeIdb(), 'db', 'handles');
  assert.equal(await kv.get('recent'), undefined);
  await kv.put('recent', [{ id: 'a', n: 1 }]);
  assert.deepEqual(await kv.get('recent'), [{ id: 'a', n: 1 }]);
});

test('a failed open is tried again, an aborted write is an error', async () => {
  const idb = fakeIdb({ failOpen: 1 });
  const kv = idbKeyValue(idb);
  await assert.rejects(kv.get('k'), /open failed/);
  assert.equal(await kv.get('k'), undefined, 'the second try opens again');
  assert.equal(idb.opens(), 2);
  const quota = idbKeyValue(fakeIdb({ abortWrites: true }));
  await assert.rejects(quota.put('k', 1), /quota/);
});

test('a folder that cannot be remembered is opened all the same', async () => {
  const failing = new RecentFolders({ get: async () => [], put: async () => { throw domError('DataCloneError', 'could not be cloned'); } });
  const { entry } = entryOver({ win: SECURE(async () => handle('vault')), recent: failing });
  await entry.start();
  await entry.pick();
  assert.deepEqual(entry.state, { step: 'open', name: 'vault', files: 3, skipped: [], folder: null, readOnly: false }, 'no id: nothing is kept for it');
});

test('the same folder chosen again keeps its id, another folder has another', async () => {
  const recent = new RecentFolders(memoryKv(), { newId: (() => { let n = 0; return () => `r${++n}`; })() });
  const same = handle('vault');
  const picks = [same, same, handle('other')];
  const { entry } = entryOver({ win: SECURE(async () => picks.shift()), recent });
  const ids = [];
  for (let i = 0; i < 3; i++) {
    await entry.start();
    await entry.pick();
    ids.push(entry.state.folder);
  }
  assert.deepEqual(ids, ['r1', 'r1', 'r2']);
});

// -- a browser without the picker: the folder is read through an input, never written, never kept ---------------------

/** A document whose folder input answers with the files the test gives. */
function inputDocument(files) {
  const listeners = {};
  const input = {
    webkitdirectory: false,
    files,
    click() {
      queueMicrotask(() => (files.length === 0 && listeners.cancel ? listeners.cancel() : listeners.change()));
    },
    addEventListener(type, listener) {
      listeners[type] = listener;
    },
    remove() {},
  };
  return { createElement: () => input, body: { appendChild() {} } };
}

const picked = (path, text = 'x') => {
  const bytes = new TextEncoder().encode(text);
  return { name: path.split('/').at(-1), size: bytes.length, lastModified: 1, webkitRelativePath: path, arrayBuffer: async () => bytes.buffer.slice(0) };
};

test('without a picker but with a folder input the start page is the read only one, with no list', async () => {
  const { entry } = entryOver({ win: { document: inputDocument([picked('vault/a.md')]) } });
  await entry.start();
  assert.deepEqual(entry.state, { step: 'choose', recent: [], notice: null, readOnly: true });
  // neither a picker nor an input: still the old refusal
  const none = entryOver({ win: { document: { createElement: () => ({}) } } });
  await none.entry.start();
  assert.deepEqual(none.entry.state, { step: 'unsupported', reason: 'missing' });
});

test('a folder chosen through the input is opened read only and is not remembered', async () => {
  const opened = [];
  const { entry, states, recent } = entryOver({
    win: { document: inputDocument([picked('vault/A/a.md'), picked('vault/A/b.md')]) },
    open: async (h, readOnly) => (opened.push([h.name, readOnly]), { files: 2, skipped: [] }),
  });
  await entry.start();
  await entry.pick();
  assert.deepEqual(opened, [['vault', true]]);
  assert.deepEqual(entry.state, { step: 'open', name: 'vault', files: 2, skipped: [], folder: null, readOnly: true });
  assert.deepEqual(states, ['choose', 'opening', 'open']);
  assert.deepEqual(await recent.list(), [], 'there is no handle to keep');
});

test('an empty folder is told as empty, and a second click while the dialog is open opens no second one', async () => {
  const empty = entryOver({ win: { document: inputDocument([]) } });
  await empty.entry.start();
  await empty.entry.pick();
  // inputDocument answers an empty list with `cancel`; a `change` with no file is the empty folder
  const doc = inputDocument([]);
  const input = doc.createElement();
  const listeners = {};
  let made = 0;
  const win = {
    document: {
      createElement: () => (made++, { ...input, files: [], addEventListener: (t, l) => (listeners[t] = l), click() {}, remove() {} }),
      body: { appendChild() {} },
    },
  };
  const { entry } = entryOver({ win });
  await entry.start();
  const first = entry.pick();
  await entry.pick();
  assert.equal(made, 2, 'one input for the support check, one for the dialog: the second click made none');
  listeners.change();
  await first;
  assert.equal(entry.state.step, 'choose');
  assert.equal(entry.state.notice.code, 'empty');
});

test('a closed dialog of the input returns to the start page with the notice; the picker still opens read write', async () => {
  const { entry } = entryOver({ win: { document: inputDocument([]) } });
  await entry.start();
  await entry.pick();
  assert.equal(entry.state.step, 'choose');
  assert.equal(entry.state.notice.code, 'cancelled');
  assert.equal(entry.state.readOnly, true);

  const opened = [];
  const withPicker = entryOver({
    win: { showDirectoryPicker: async () => handle('v'), isSecureContext: true, document: inputDocument([picked('vault/a.md')]) },
    open: async (h, readOnly) => (opened.push(readOnly), { files: 1, skipped: [] }),
  });
  await withPicker.entry.start();
  assert.equal(withPicker.entry.state.readOnly, false, 'a browser with the picker never takes the input');
  await withPicker.entry.pick();
  assert.deepEqual(opened, [false]);
});
