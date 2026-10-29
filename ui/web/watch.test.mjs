// How the web variant notices that the folder changed: the signature of a folder, and the watcher that looks on focus
// and on a timer. Fake folders and a fake clock, no browser.
//
//   node --experimental-strip-types --test web/watch.test.mjs        (from ui/)

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { vaultSignature } from '../src/web/vault-files.ts';
import { watchVault, WATCH_MS } from '../src/web/watch.ts';

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

/** A clock and a window the test drives. */
function world(signatures) {
  const calls = { changed: 0, errors: [] };
  const timers = [];
  const focus = [];
  let i = 0;
  const watcher = watchVault(signatures[0], {
    signature: async () => {
      const s = signatures[Math.min(++i, signatures.length - 1)];
      if (s instanceof Error) throw s;
      return s;
    },
    onChange: async () => void calls.changed++,
    onError: (e) => calls.errors.push(e.message),
    setTimer: (fn, ms) => (timers.push({ fn, ms, live: true }), timers.length - 1),
    clearTimer: (h) => void (timers[h].live = false),
    onFocus: (fn) => (focus.push(fn), () => focus.splice(focus.indexOf(fn), 1)),
  });
  return { calls, timers, focus, watcher };
}

test('a change is found on the timer and on focus, once, and nothing is told when nothing changed', async () => {
  const w = world(['s1', 's1', 's2', 's2', 's3']);
  assert.equal(w.timers[0].ms, WATCH_MS);
  const settle = () => new Promise((r) => setImmediate(r));
  w.timers[0].fn(); // the timer looks: s1, the same as read
  await settle();
  assert.equal(w.calls.changed, 0, 'no change, nothing told');
  w.focus[0](); // the window gets the focus: s2, another
  await settle();
  assert.equal(w.calls.changed, 1);
  w.timers[0].fn(); // s2 again: the change was told once
  await settle();
  assert.equal(w.calls.changed, 1, 'the same signature again is no change');
  w.focus[0](); // s3
  await settle();
  assert.equal(w.calls.changed, 2);
});

test('looks do not pile up, a failed look is reported and the watcher goes on', async () => {
  let release;
  let looks = 0;
  const timers = [];
  const w = watchVault('s0', {
    signature: () => (++looks, new Promise((r) => (release = () => r('s1')))),
    onChange: async () => {},
    setTimer: (fn) => (timers.push(fn), 0),
    clearTimer() {},
    onFocus: () => () => {},
  });
  const first = w.check();
  assert.equal(await w.check(), false, 'a second look while one is under way does nothing');
  assert.equal(looks, 1);
  release();
  assert.equal(await first, true);

  const failing = world(['s0', new Error('permission taken back'), 's1']);
  assert.equal(await failing.watcher.check(), false);
  assert.deepEqual(failing.calls.errors, ['permission taken back']);
  assert.equal(await failing.watcher.check(), true, 'the next look works');
});

test('after stop nothing is looked at; accept sets the state to compare against', async () => {
  const w = world(['s0', 's1', 's2']);
  w.watcher.accept('s1');
  assert.equal(await w.watcher.check(), false, 's1 is what was read now');
  w.watcher.stop();
  assert.equal(w.timers[0].live, false, 'the timer is gone');
  assert.equal(w.focus.length, 0, 'the focus listener is gone');
  assert.equal(await w.watcher.check(), false);
  assert.equal(w.calls.changed, 0);
});
