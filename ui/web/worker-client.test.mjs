// The page's client, the worker and the hub together, on the synthetic vault of the browser tests: the real engine in
// wasmoon, the worker started in-process, messages copied the way a worker's are. No browser, no Neovim.
//
//   node --experimental-strip-types --test web/worker-client.test.mjs        (from ui/; needs wasmoon and the engine checkouts)

import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { test as base } from 'node:test';
import { fileURLToPath } from 'node:url';
import { LuaFactory } from 'wasmoon';
import { createBrowserHub, WorkerClient } from '../src/web/client.ts';
import { WebEngine } from '../src/web/engine.ts';
import { startWorker } from '../src/web/worker.ts';
import { bundle, readLock } from './engine-bundle.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const fixture = resolve(here, '..', '..', 'e2e', 'fixture', 'vault');
const SHIM = readFileSync(resolve(here, '..', 'src', 'web', 'vim-shim.lua'), 'utf8');
const ROOT = '/vault';

// An answer that never comes (a wrong id, a lost message) must fail the test, not hang the run.
const test = (name, fn) => base(name, { timeout: 30_000 }, fn);

/** The fixture vault as the folder reader hands it over: relative path -> bytes. */
function vaultFiles() {
  const files = new Map();
  const walk = (d) => {
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      if (statSync(p).isDirectory()) walk(p);
      else files.set(relative(fixture, p).replaceAll('\\', '/'), new Uint8Array(readFileSync(p)));
    }
  };
  walk(fixture);
  return files;
}

/** A worker in this process: a port for the client and a scope for `startWorker`, every message copied. */
function pair() {
  const port = { onmessage: null, postMessage: (m) => queueMicrotask(() => scope.onmessage({ data: structuredClone(m) })) };
  const scope = {
    fetch: async () => new Response(''),
    onmessage: null,
    postMessage: (m) => queueMicrotask(() => port.onmessage?.({ data: structuredClone(m) })),
  };
  startWorker(scope, { factory: () => new LuaFactory() });
  return port;
}

const INIT = () => ({ wasm: new ArrayBuffer(0), bundle: bundle(), shim: SHIM });
const mask = (text) => text.replace(/"generated_at":"[^"]*"/g, '"generated_at":"*"');

let started;
/** One client with a started engine and the fixture mounted: every test shares it (a VM starts in about a second). */
function ready() {
  started ??= (async () => {
    const client = new WorkerClient(pair());
    await client.init(INIT());
    await client.mount(ROOT, vaultFiles());
    return client;
  })();
  return started;
}

test('the worker answers a call over the mounted vault as the engine itself does', async () => {
  const client = await ready();
  const direct = await WebEngine.create({ factory: new LuaFactory(), bundle: bundle(), shim: SHIM });
  direct.mount(Object.fromEntries([...vaultFiles()].map(([p, b]) => [`${ROOT}/${p}`, b])));
  for (const method of ['hello', 'areas', 'snapshot', 'list', 'links', 'groupings']) {
    const viaWorker = await client.call(method, null, { root: ROOT });
    const here = direct.call(method, null, { root: ROOT });
    assert.equal(viaWorker.code, null, method);
    assert.equal(mask(viaWorker.text), mask(here.text), method);
  }
  direct.close();
});

test('a refusal of the engine is a result with a code, an unknown method too', async () => {
  const client = await ready();
  const r = await client.call('no_such_method', null, { root: ROOT });
  assert.notEqual(r.code, null);
  assert.equal(JSON.parse(r.text).kind, 'tasks.error');
});

test('answers find their own question when several are in flight', async () => {
  const client = await ready();
  const methods = ['links', 'areas', 'groupings', 'views', 'lists', 'hello'];
  const kinds = await Promise.all(methods.map(async (m) => JSON.parse((await client.call(m, null, { root: ROOT })).text).kind));
  assert.deepEqual(kinds, ['tasks.links', 'tasks.areas', 'tasks.groupings', 'tasks.views', 'tasks.lists', 'tasks.hello']);
});

test('the hub of the page serves the routes over the worker', async () => {
  const client = await ready();
  const lock = readLock();
  const hub = createBrowserHub(client, { root: ROOT, version: '0.0.0-test', build: null, pinned: { engine: lock.commit, lib: lock.lib_commit } });
  const snap = await hub.fetch('/api/tasks/snapshot');
  assert.equal(snap.status, 200);
  const doc = await snap.json();
  assert.ok(doc.tasks.length > 0, 'the fixture has tasks');
  const id = doc.tasks[0].id;
  const task = await hub.fetch(`/api/tasks/task?id=${id}`);
  assert.equal(task.status, 200);
  assert.equal((await task.json()).kind, 'tasks.task');
  const tag = snap.headers.get('etag');
  assert.ok(tag, 'the snapshot carries its tag');
  assert.equal((await hub.fetch('/api/tasks/snapshot', { headers: { 'If-None-Match': tag } })).status, 304);
  assert.equal((await hub.fetch('/api/tasks/task?id=nope')).status, 400);
  assert.equal((await hub.fetch('/api/tasks/task?id=lib.nvim/does-not-exist')).status, 404);
  const about = await (await hub.fetch('/api/tasks/about')).json();
  assert.equal(about.mode, 'web');
  assert.equal(about.pinned.engine, lock.commit);
  const areas = await (await hub.fetch('/api/tasks/areas')).json();
  assert.equal(areas.kind, 'hub.areas');
  assert.deepEqual(areas.unclassified, areas.areas.map((a) => a.name), 'without a class file every area is unclassified');
});

test('nothing changed after the mount, and a second mount replaces the vault', async () => {
  const client = await ready();
  assert.deepEqual(await client.changes(), { added: [], modified: [], removed: [] });
  const before = JSON.parse((await client.call('list', null, { root: ROOT })).text).items.length;
  assert.ok(before > 1);

  const only = new Map([...vaultFiles()].slice(0, 1));
  await client.mount(ROOT, only);
  const after = JSON.parse((await client.call('list', null, { root: ROOT })).text).items.length;
  assert.ok(after < before, `the old files are gone from the VM (${before} -> ${after})`);
  await client.mount(ROOT, vaultFiles());
  assert.equal(JSON.parse((await client.call('list', null, { root: ROOT })).text).items.length, before);
});

test('a path that leaves the vault, or a root outside the VM, is refused and mounts nothing', async () => {
  const client = await ready();
  for (const bad of ['../outside.md', 'a/../b.md', '/abs.md', 'a//b.md', 'a\\b.md', '']) {
    await assert.rejects(client.mount(ROOT, { [bad]: new Uint8Array(1) }), /not a plain path/, JSON.stringify(bad));
  }
  await assert.rejects(client.mount('vault', new Map()), /absolute folder/);
  await assert.rejects(client.mount('/', new Map()), /absolute folder/);
  // the vault that was there is still there
  assert.ok(JSON.parse((await client.call('list', null, { root: ROOT })).text).items.length > 1);
});

test('before init every question is refused by name, and a closed client asks nothing', async () => {
  const early = new WorkerClient(pair());
  await assert.rejects(early.call('hello', null, { root: ROOT }), /not started/);
  await assert.rejects(early.mount(ROOT, new Map()), /not started/);
  await assert.rejects(early.changes(), /not started/);
  early.close();
  await assert.rejects(early.call('hello', null, { root: ROOT }), /closed/);
});

test('close rejects what is still waiting', async () => {
  const silent = new WorkerClient({ onmessage: null, postMessage() {} });
  const waiting = silent.call('hello', null, { root: ROOT });
  silent.close();
  await assert.rejects(waiting, /closed/);
});

test('a second init is refused by the worker and the first engine keeps answering', async () => {
  const client = await ready();
  await assert.rejects(client.init(INIT()), /already started/);
  assert.equal((await client.call('hello', null, { root: ROOT })).code, null);
});
