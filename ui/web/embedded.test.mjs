// The parts a page carries and the worker started from them. The packer (web/pack.mjs) writes them; this reads them
// back the way the page does, so the two cannot drift apart.
//
//   node --experimental-strip-types --test web/embedded.test.mjs        (from ui/)

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { gzipSync } from 'node:zlib';
import { loadParts, startBlobWorker, unpack } from '../src/web/embedded.ts';
import { assemble, PART_IDS } from './pack.mjs';

const pack = (data) => gzipSync(Buffer.from(data)).toString('base64').replace(/.{1,76}/g, '$&\n');
const bundleText = JSON.stringify({ engine: { commit: 'a'.repeat(40), lib_commit: 'b'.repeat(40) }, modules: { x: 'return 1' } });

test('gzip and base64 come back as the bytes, also with line breaks and multi-byte text', async () => {
  const bytes = await unpack(pack('héllo ☃ wörld'));
  assert.equal(new TextDecoder().decode(bytes), 'héllo ☃ wörld');
  assert.equal((await unpack(pack(new Uint8Array([0, 1, 2, 255])))).join(','), '0,1,2,255');
  await assert.rejects(unpack('not gzip at all'), /./);
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
