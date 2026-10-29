// The parts a page carries and the worker started from them. The packer (web/pack.mjs) writes them; this reads them
// back the way the page does, so the two cannot drift apart.
//
//   node --experimental-strip-types --test web/embedded.test.mjs        (from ui/)

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { gzipSync } from 'node:zlib';
import { base64ByAtob, base64Bytes, loadParts, startBlobWorker, unpack } from '../src/web/embedded.ts';
import { assemble, PART_IDS } from './pack.mjs';

const pack = (data) => gzipSync(Buffer.from(data)).toString('base64').replace(/.{1,76}/g, '$&\n');
const bundleText = JSON.stringify({ engine: { commit: 'a'.repeat(40), lib_commit: 'b'.repeat(40) }, modules: { x: 'return 1' } });

test('gzip and base64 come back as the bytes, also with line breaks and multi-byte text', async () => {
  const bytes = await unpack(pack('héllo ☃ wörld'));
  assert.equal(new TextDecoder().decode(bytes), 'héllo ☃ wörld');
  assert.equal((await unpack(pack(new Uint8Array([0, 1, 2, 255])))).join(','), '0,1,2,255');
  await assert.rejects(unpack('not gzip at all'), /./);
});

test('Uint8Array.fromBase64 and the way over atob give the same bytes, line breaks and all', (t) => {
  // Chrome has it since 140; a Node whose V8 lacks it (no version is pinned) compares the way over atob alone.
  const native = typeof Uint8Array.fromBase64 === 'function' ? Uint8Array.fromBase64 : null;
  if (!native) t.diagnostic('this Node has no Uint8Array.fromBase64: only the way over atob is compared');
  let seed = 7;
  const random = (n) => Uint8Array.from({ length: n }, () => (seed = (seed * 1103515245 + 12345) >>> 0) >>> 24);
  for (const n of [0, 1, 2, 3, 4, 119, 120, 121, 4096, 300_001]) {
    const bytes = random(n);
    // As the packer writes a part (lines of 120) and as other tools do (76, CRLF).
    for (const text of [
      Buffer.from(bytes).toString('base64'),
      Buffer.from(bytes).toString('base64').replace(/.{1,120}/g, '$&\n'),
      Buffer.from(bytes).toString('base64').replace(/.{1,76}/g, '$&\r\n'),
    ]) {
      if (native) {
        const fast = base64Bytes(text, native);
        assert.ok(fast instanceof Uint8Array);
        assert.deepEqual(fast, bytes, `fast, ${n} bytes`);
      }
      const slow = base64Bytes(text, null);
      assert.ok(slow instanceof Uint8Array);
      assert.deepEqual(slow, bytes, `fallback, ${n} bytes`);
      assert.deepEqual(base64ByAtob(text), bytes);
      assert.deepEqual(base64Bytes(text), bytes, 'the default gives the same bytes');
    }
  }
  for (const bad of ['a', 'ab!c', '@@@@']) {
    if (native) assert.throws(() => base64Bytes(bad, native), `fast refuses ${bad}`);
    assert.throws(() => base64Bytes(bad, null), `fallback refuses ${bad}`);
  }
});

/**
 * The module loaded anew with `Uint8Array.fromBase64` set to `value` (undefined: as a browser without it), so its
 * default is looked up again; `fromBase64` is put back afterwards.
 */
async function freshWith(value) {
  const real = Object.getOwnPropertyDescriptor(Uint8Array, 'fromBase64');
  if (value === undefined) delete Uint8Array.fromBase64;
  else Object.defineProperty(Uint8Array, 'fromBase64', { value, writable: true, configurable: true });
  try {
    return await import(`../src/web/embedded.ts?fromBase64=${value === undefined ? 'none' : 'spy'}`);
  } finally {
    if (real) Object.defineProperty(Uint8Array, 'fromBase64', real);
    else delete Uint8Array.fromBase64;
  }
}

test('by default the bytes come from Uint8Array.fromBase64 where the browser has it, and over atob where it has none', async () => {
  const used = [];
  const spy = (text) => {
    used.push(text);
    return new Uint8Array([42]);
  };
  const withIt = await freshWith(spy);
  assert.deepEqual([...withIt.base64Bytes('AAEC')], [42], 'the default is the browser\'s fromBase64');
  assert.deepEqual(used, ['AAEC']);
  const without = await freshWith(undefined);
  assert.deepEqual([...without.base64Bytes('AAEC')], [0, 1, 2], 'without it the default is the way over atob');
  assert.deepEqual(used, ['AAEC']);
});

test('the fast path is taken where there is one, and the fallback where there is none', () => {
  const used = [];
  const fake = (text) => {
    used.push(text);
    return new Uint8Array([42]);
  };
  assert.deepEqual([...base64Bytes('AAEC', fake)], [42]);
  assert.deepEqual(used, ['AAEC']);
  assert.deepEqual([...base64Bytes('AAEC', null)], [0, 1, 2]);
});

test('unpacking puts the bytes into no Blob (one copy less, and in Chrome no reading back from its blob store)', async () => {
  const real = globalThis.Blob;
  globalThis.Blob = class {
    constructor() {
      throw new Error('a Blob was made');
    }
  };
  try {
    assert.equal(new TextDecoder().decode(await unpack(pack('no blob'))), 'no blob');
  } finally {
    globalThis.Blob = real;
  }
});

test('a page made by the packer gives its parts back', async () => {
  const wasm = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]);
  const html = assemble({
    css: '',
    js: '',
    parts: { worker: Buffer.from('self.x = 1'), wasm, bundle: Buffer.from(bundleText), shim: Buffer.from('-- shim') },
    build: 'test',
  });
  const read = (id) => html.match(new RegExp(`<script id="${id}" type="application/octet-stream">([^<]*)</script>`))?.[1] ?? null;
  const parts = await loadParts(read);
  assert.equal(parts.worker, 'self.x = 1');
  assert.deepEqual([...new Uint8Array(parts.wasm)], [...wasm]);
  assert.equal(parts.bundle.engine.commit, 'a'.repeat(40));
  assert.deepEqual(parts.bundle.modules, { x: 'return 1' });
  assert.equal(parts.shim, '-- shim');
});

test('a part that is missing or empty is named, and a bundle that is none is refused', async () => {
  const good = { worker: pack('w'), wasm: pack('x'), bundle: pack(bundleText), shim: pack('s') };
  for (const id of PART_IDS) {
    await assert.rejects(loadParts((x) => (x === id ? null : good[x])), new RegExp(`part "${id}"`), `${id} missing`);
    await assert.rejects(loadParts((x) => (x === id ? '  \n ' : good[x])), new RegExp(`part "${id}"`), `${id} empty`);
  }
  for (const bad of ['[]', '{"modules":{}}', '{"engine":{"commit":3},"modules":{}}', '"text"', 'null']) {
    await assert.rejects(loadParts((x) => (x === 'bundle' ? pack(bad) : good[x])), /not an engine bundle/, bad);
  }
  await assert.rejects(loadParts((x) => (x === 'bundle' ? pack('{not json') : good[x])), SyntaxError);
});

test('the worker is classic, from a blob, and its address is kept for the browser to fetch', () => {
  const made = [];
  const host = {
    Blob: class {
      constructor(parts, options) {
        made.push(['blob', parts.join(''), options.type]);
      }
    },
    URL: { createObjectURL: () => 'blob:null/1', revokeObjectURL: () => made.push(['revoke']) },
    Worker: class {
      constructor(url, options) {
        made.push(['worker', url, options.type]);
      }
    },
  };
  const worker = startBlobWorker('self.postMessage(1)', host);
  assert.ok(worker);
  assert.deepEqual(made, [
    ['blob', 'self.postMessage(1)', 'text/javascript'],
    ['worker', 'blob:null/1', 'classic'],
  ]);
});
