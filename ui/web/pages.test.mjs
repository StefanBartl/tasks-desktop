// The single-file pages of the web variant: the checks of their builds, and the probe's own script, run in a vm with
// small stand-ins for the browser (DOM, IndexedDB, workers, fetch with or without a CSP report, a picked folder).
//
//   node --experimental-strip-types --test web/        (from ui/)

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { verify } from '../probe/build.mjs';
import { bundleJson, classic } from './engine-page.mjs';

const here = dirname(fileURLToPath(import.meta.url));
// The least policy the check takes: nothing may load, connect, set a base or send a form.
const CSP = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; connect-src 'none'; base-uri 'none'; form-action 'none'">`;

test('the build refuses a page that loads anything, on any element', () => {
  assert.deepEqual(verify(`<html>${CSP}<body><script>1</script></body></html>`), []);
  for (const bad of [
    '<script src="x.js"></script>',
    '<a href="https://example.com/">x</a>',
    '<object data="x.swf"></object>',
    '<base href="/">',
    '<form action="/send"></form>',
    '<img srcset="a.png 1x">',
    '<video poster="p.png"></video>',
    '<meta http-equiv="refresh" content="0;url=/x">',
  ]) {
    assert.notDeepEqual(verify(`<html>${CSP}<body>${bad}</body></html>`), [], bad);
  }
  assert.notDeepEqual(verify('<html><body></body></html>'), [], 'no CSP');
  assert.notDeepEqual(verify(`<html>${CSP}<body>wss://x.example/</body></html>`), [], 'a URL in the text');
  assert.notDeepEqual(verify(`<html>${CSP}<body>__LEFT_OVER__</body></html>`), [], 'a placeholder');
});

test('a module becomes a classic script, also with an import over several lines', () => {
  const js = classic(
    [
      "import { a,",
      "  b } from './x.ts';",
      "import type { T } from 'y';",
      "import 'side-effect';",
      'export const n: number = 1;',
      'export function f(x: T): void {}',
      'export default class C {}',
      'export { n as m };',
    ].join('\n'),
  );
  assert.ok(!/\b(import|export)\b/.test(js), js);
  assert.match(js, /const n\s*=\s*1;/);
  assert.match(js, /function f\(x\s*\)/);
  assert.throws(() => classic("export * from './x.ts';"), /left/);
});

test('the page carries the pins and the sources of the bundle, not its report', () => {
  const b = { engine: { commit: 'c', lib_commit: 'l' }, modules: { m: 'return 1' }, report: [{ mod: 'm' }], missing: ['x'] };
  assert.deepEqual(JSON.parse(bundleJson(b)), { engine: b.engine, modules: b.modules });
});

// ── the probe's script in a vm ───────────────────────────────────────────────────

function probeScript() {
  const html = readFileSync(join(here, '..', 'probe', 'probe.src.html'), 'utf8');
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)];
  return scripts[scripts.length - 1][1];
}

function element(id) {
  return {
    id,
    textContent: '',
    className: '',
    listeners: {},
    cells: [{}, {}, {}],
    set innerHTML(_) {},
    addEventListener(type, fn) {
      this.listeners[type] = fn;
    },
  };
}

/** A browser for the probe: `opts.csp` 'report' or 'silent', `opts.worker` 'answer' or 'silent'. */
function probe(opts) {
  const ids = new Map(['rows', 'out', 'pick', 'regrant', 'copy', 'filler'].map((id) => [id, element(id)]));
  ids.get('filler').textContent = 'AAAA';
  ids.get('rows').appendChild = (row) => ids.set(row.id, row);
  const docListeners = new Set();
  const stats = { opens: 0, terminated: 0, revoked: [] };
  const store = new Map();
  const db = {
    transaction() {
      const tx = {
        objectStore: () => ({
          put: (v, k) => (store.set(k, v), {}),
          get: (k) => ({ result: store.get(k) }),
        }),
      };
      setTimeout(() => tx.oncomplete?.(), 0);
      return tx;
    },
  };
  class Worker {
    constructor() {
      this.onmessage = null;
    }
    postMessage() {
      if (opts.worker === 'answer') setTimeout(() => this.onmessage?.({ data: { ok: true, sum: 5 } }), 0);
    }
    terminate() {
      stats.terminated++;
    }
  }
  const ctx = {
    document: {
      getElementById: (id) => ids.get(id) ?? null,
      createElement: () => element(''),
      addEventListener: (type, fn) => type === 'securitypolicyviolation' && docListeners.add(fn),
      removeEventListener: (type, fn) => docListeners.delete(fn),
    },
    window: { isSecureContext: true, showDirectoryPicker() {} },
    location: { protocol: 'file:', origin: 'null' },
    navigator: {
      userAgent: 'vm',
      storage: { persisted: async () => false, persist: async () => false, estimate: async () => ({ usage: 1, quota: 2 }) },
    },
    indexedDB: {
      open() {
        stats.opens++;
        const req = {};
        setTimeout(() => {
          req.result = db;
          req.onsuccess?.();
        }, 0);
        return req;
      },
    },
    localStorage: { getItem: (k) => store.get(`ls:${k}`) ?? null, setItem: (k, v) => store.set(`ls:${k}`, v) },
    fetch: async () => {
      if (opts.csp === 'report') for (const fn of [...docListeners]) fn({ violatedDirective: 'connect-src' });
      throw new TypeError('Failed to fetch');
    },
    URL: { createObjectURL: () => 'blob:probe', revokeObjectURL: (u) => stats.revoked.push(u) },
    Worker,
    Blob,
    atob,
    crypto: globalThis.crypto,
    performance,
    setTimeout,
    clearTimeout,
    console,
  };
  vm.createContext(ctx);
  vm.runInContext(probeScript(), ctx);
  const results = () => vm.runInContext('results', ctx);
  const done = async () => {
    for (let i = 0; i < 400 && !results().has('time'); i++) await new Promise((r) => setTimeout(r, 25));
    return results();
  };
  return { ctx, stats, results, done };
}

test('the probe says OK for the CSP only when the browser reports the refusal', async () => {
  const quiet = await probe({ csp: 'silent', worker: 'answer' }).done();
  assert.equal(quiet.get('csp').state, 'fail', quiet.get('csp').detail);
  const strict = await probe({ csp: 'report', worker: 'answer' }).done();
  assert.equal(strict.get('csp').state, 'ok', strict.get('csp').detail);
});

test('the probe keeps one IndexedDB connection', async () => {
  const p = probe({ csp: 'report', worker: 'answer' });
  await p.done();
  assert.equal(p.stats.opens, 1);
});

test('the probe leaves a file of its own name alone', async () => {
  const p = probe({ csp: 'report', worker: 'answer' });
  await p.done();
  const files = new Map([['tasks-web-probe.txt', 'someone else wrote this']]);
  const removed = [];
  const notFound = () => Object.assign(new Error('not found'), { name: 'NotFoundError' });
  const handle = (name) => ({
    kind: 'file',
    createWritable: async () => ({ write: async (t) => files.set(name, t), close: async () => {} }),
    getFile: async () => ({ text: async () => files.get(name) }),
    move: async (to) => (files.set(to, files.get(name)), files.delete(name)),
  });
  const dir = {
    name: 'picked',
    queryPermission: async () => 'granted',
    entries: async function* () {
      for (const name of files.keys()) yield [name, { kind: 'file' }];
    },
    getFileHandle: async (name, o) => {
      if (!files.has(name) && !o?.create) throw notFound();
      if (!files.has(name)) files.set(name, '');
      return handle(name);
    },
    removeEntry: async (name) => (removed.push(name), files.delete(name)),
  };
  await p.ctx.folderChecks(dir, 'test');
  const write = p.results().get('write');
  assert.equal(write.state, 'fail', write.detail);
  assert.equal(files.get('tasks-web-probe.txt'), 'someone else wrote this');
  assert.deepEqual(removed, []);
});

test('a worker that never answers is ended and its URL given back', async () => {
  const p = probe({ csp: 'report', worker: 'answer' });
  await p.done();
  const before = { terminated: p.stats.terminated, revoked: p.stats.revoked.length };
  assert.equal(before.terminated, 2, 'the two startup workers ended after their answer');
  p.ctx.Worker.prototype.postMessage = () => {};
  await assert.rejects(p.ctx.blobWorker('classic'), /timed out/);
  assert.equal(p.stats.terminated, before.terminated + 1);
  assert.equal(p.stats.revoked.length, before.revoked + 1);
});
