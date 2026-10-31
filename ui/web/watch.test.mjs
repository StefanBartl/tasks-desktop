// How the web variant notices that the folder changed: the signature of a folder (what the watcher of appkit-web/watch
// compares; its own tests are in the kit). Fake folders, no browser.
//
//   node --experimental-strip-types --test web/watch.test.mjs        (from ui/)

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { vaultSignature } from '../src/web/vault-files.ts';

const enc = (s) => new TextEncoder().encode(s);

/** A folder: { name: string | tree }; a file is its text and its time. */
function folder(tree, name = 'v') {
  return {
    kind: 'directory',
    name,
    async *values() {
      for (const [n, v] of Object.entries(tree)) {
        if (typeof v === 'object' && !('text' in v)) yield folder(v, n);
        else {
          const { text, time } = typeof v === 'string' ? { text: v, time: 1 } : v;
          yield {
            kind: 'file',
            name: n,
            getFile: async () => ({ size: enc(text).byteLength, lastModified: time, arrayBuffer: async () => enc(text).buffer }),
          };
        }
      }
    },
  };
}

test('the signature is the same for the same files and differs when a file, its size or its time does', async () => {
  const base = { 'a.md': { text: 'one', time: 5 }, A: { tasks: { 'b.md': { text: 'two', time: 6 } } } };
  const sig = await vaultSignature(folder(base));
  assert.equal(await vaultSignature(folder(base)), sig);
  assert.notEqual(await vaultSignature(folder({ ...base, 'a.md': { text: 'one', time: 9 } })), sig, 'a later time');
  assert.notEqual(await vaultSignature(folder({ ...base, 'a.md': { text: 'one!', time: 5 } })), sig, 'another size');
  assert.notEqual(await vaultSignature(folder({ ...base, 'c.md': 'x' })), sig, 'a new file');
  const { 'a.md': _gone, ...without } = base;
  assert.notEqual(await vaultSignature(folder(without)), sig, 'a file removed');
});

test('what the reader would not take does not count, and the order of listing does not matter', async () => {
  const base = { 'a.md': 'x', 'b.md': 'y' };
  const sig = await vaultSignature(folder(base));
  assert.equal(await vaultSignature(folder({ ...base, 'notes.txt': 'no', '.git': { 'HEAD.md': 'no' }, node_modules: { 'z.md': 'no' } })), sig);
  assert.equal(await vaultSignature(folder({ 'b.md': 'y', 'a.md': 'x' })), sig, 'the same files in another order');
});

test('a file that cannot be read still shows in the signature, and a bad name never does', async () => {
  const broken = { kind: 'directory', name: 'v', async *values() {
    yield { kind: 'file', name: 'a.md', getFile: async () => { throw new Error('locked'); } };
    yield { kind: 'file', name: '../x.md', getFile: async () => ({ size: 1 }) };
  } };
  const withFile = await vaultSignature(broken);
  const empty = await vaultSignature(folder({}));
  assert.notEqual(withFile, empty);
  assert.match(withFile, /^1:/, 'one line: the bad name was left out');
});
