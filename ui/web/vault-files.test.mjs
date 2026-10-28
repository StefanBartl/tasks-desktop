// The folder reader and the change list of the web variant, with a fake picked folder and a small in-memory file
// system standing in for the VM's: no browser, no wasmoon, no install.
//
//   node --experimental-strip-types --test web/        (from ui/)

import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  DEFAULT_LIMITS,
  readVaultFolder,
  safeName,
  VaultLimitError,
  VaultMount,
  wantedDir,
  wantedFile,
} from '../src/web/vault-files.ts';

const enc = (s) => new TextEncoder().encode(s);
const dec = (b) => new TextDecoder().decode(b);

/** A picked folder: a tree of { name: string | tree }; `sizes` overrides what getFile() announces. */
function folder(tree, name = 'vault', sizes = {}, prefix = '') {
  return {
    kind: 'directory',
    name,
    async *values() {
      for (const [n, v] of Object.entries(tree)) {
        if (typeof v === 'string' || v instanceof Uint8Array) {
          const bytes = typeof v === 'string' ? enc(v) : v;
          const path = prefix + n;
          yield {
            kind: 'file',
            name: n,
            async getFile() {
              if (sizes[path] === 'throw') throw new Error('gone');
              return { size: sizes[path] ?? bytes.byteLength, arrayBuffer: async () => bytes.buffer.slice(0) };
            },
          };
        } else {
          yield folder(v, n, sizes, `${prefix}${n}/`);
        }
      }
    },
  };
}

/** The slice of Emscripten's FS the mount uses, over a Map. */
function memfs() {
  const dirs = new Set(['/']);
  const files = new Map();
  const err = (m) => Object.assign(new Error(m), { errno: 44 });
  const parent = (p) => p.slice(0, p.lastIndexOf('/')) || '/';
  return {
    dirs,
    files,
    stat(p) {
      if (dirs.has(p)) return { mode: 0o040755, size: 0, mtime: new Date() };
      if (files.has(p)) return { mode: 0o100644, size: files.get(p).byteLength, mtime: new Date() };
      throw err(`ENOENT ${p}`);
    },
    readdir(p) {
      if (!dirs.has(p)) throw err(`ENOTDIR ${p}`);
      const base = p === '/' ? '/' : `${p}/`;
      const names = new Set(['.', '..']);
      for (const d of dirs) if (d !== p && d.startsWith(base) && !d.slice(base.length).includes('/')) names.add(d.slice(base.length));
      for (const f of files.keys()) if (f.startsWith(base) && !f.slice(base.length).includes('/')) names.add(f.slice(base.length));
      return [...names];
    },
    mkdir(p) {
      if (dirs.has(p) || files.has(p)) throw err(`EEXIST ${p}`);
      if (!dirs.has(parent(p))) throw err(`ENOENT ${parent(p)}`);
      dirs.add(p);
    },
    rmdir(p) {
      dirs.delete(p);
    },
    unlink(p) {
      files.delete(p);
    },
    writeFile(p, data) {
      if (!dirs.has(parent(p))) throw err(`ENOENT ${parent(p)}`);
      files.set(p, typeof data === 'string' ? enc(data) : data.slice());
    },
    readFile(p, opts) {
      if (!files.has(p)) throw err(`ENOENT ${p}`);
      return opts?.encoding === 'utf8' ? dec(files.get(p)) : files.get(p).slice();
    },
  };
}

test('which names become paths', () => {
  for (const ok of ['a.md', 'Ä ö.md', 'with space.md', '.hidden']) assert.equal(safeName(ok), true, ok);
  for (const bad of ['', '.', '..', 'a/b', 'a\\b', 'a\0b', 'x'.repeat(256), 3, null, undefined]) {
    assert.equal(safeName(bad), false, String(bad));
  }
});

test('which files and folders are read', () => {
  assert.equal(wantedFile('t.md', false), true);
  assert.equal(wantedFile('T.MD', false), true);
  assert.equal(wantedFile('notes.txt', false), false);
  assert.equal(wantedFile('areas.json', true), true);
  assert.equal(wantedFile('areas.json', false), false, 'the named files count at the root only');
  assert.equal(wantedFile('vault.json', true), true);
  assert.equal(wantedDir('.git'), false);
  assert.equal(wantedDir('.obsidian'), false);
  assert.equal(wantedDir('node_modules'), false);
  assert.equal(wantedDir('ROADMAP'), true);
});

test('a folder is read into relative paths, in a fixed order, without what is not a task file', async () => {
  const dir = folder({
    'areas.json': '{}',
    'readme.txt': 'no',
    '.git': { 'HEAD.md': 'no' },
    node_modules: { 'x.md': 'no' },
    zeta: { ROADMAP: { tasks: { 'b.md': 'B', 'a.md': 'A' } }, 'areas.json': 'not at the root' },
    alpha: { 'z.md': 'Z' },
  });
  const got = await readVaultFolder(dir);
  assert.deepEqual([...got.files.keys()], ['alpha/z.md', 'areas.json', 'zeta/ROADMAP/tasks/a.md', 'zeta/ROADMAP/tasks/b.md']);
  assert.equal(dec(got.files.get('zeta/ROADMAP/tasks/a.md')), 'A');
  assert.equal(got.totalBytes, 1 + 2 + 1 + 1);
  assert.deepEqual(got.skipped, []);
});

test('a hostile name never becomes a path', async () => {
  const dir = {
    kind: 'directory',
    name: 'v',
    async *values() {
      for (const name of ['..', 'a/b.md', 'c\\d.md', 'e\0.md', '']) {
        yield { kind: 'file', name, getFile: async () => ({ size: 1, arrayBuffer: async () => enc('x').buffer }) };
      }
      yield { kind: 'directory', name: '../up', values: async function* () {} };
      yield { kind: 'file', name: 'fine.md', getFile: async () => ({ size: 1, arrayBuffer: async () => enc('x').buffer }) };
    },
  };
  const got = await readVaultFolder(dir);
  assert.deepEqual([...got.files.keys()], ['fine.md']);
  assert.equal(got.skipped.length, 6);
  assert.ok(got.skipped.every((s) => s.reason === 'name'));
});

test('a file over the cap is skipped and reported, by the announced size and by the bytes in hand', async () => {
  const big = new Uint8Array(11);
  const dir = folder({ 'small.md': 'ok', 'big.md': big, 'liar.md': 'x' }, 'v', { 'liar.md': 5 });
  const got = await readVaultFolder(dir, { maxFileBytes: 10 });
  assert.deepEqual([...got.files.keys()], ['liar.md', 'small.md']);
  assert.deepEqual(got.skipped, [{ path: 'big.md', reason: 'too-large' }]);

  const liar = folder({ 'liar.md': big }, 'v', { 'liar.md': 1 });
  const got2 = await readVaultFolder(liar, { maxFileBytes: 10 });
  assert.deepEqual(got2.skipped, [{ path: 'liar.md', reason: 'too-large' }], 'the announced size was a lie');
});

test('a file that cannot be read is skipped and reported', async () => {
  const dir = folder({ 'a.md': 'x', 'b.md': 'y' }, 'v', { 'a.md': 'throw' });
  const got = await readVaultFolder(dir);
  assert.deepEqual([...got.files.keys()], ['b.md']);
  assert.deepEqual(got.skipped, [{ path: 'a.md', reason: 'unreadable' }]);
});

test('a folder over a budget is refused as a whole', async () => {
  const many = folder({ 'a.md': '1', 'b.md': '2', 'c.md': '3' });
  await assert.rejects(readVaultFolder(many, { maxFiles: 2 }), (e) => e instanceof VaultLimitError && e.limit === 'maxFiles');
  const heavy = folder({ 'a.md': '123456', 'b.md': '123456' });
  await assert.rejects(readVaultFolder(heavy, { maxTotalBytes: 10 }), (e) => e.limit === 'maxTotalBytes');
  const deep = folder({ a: { b: { c: { 'x.md': 'x' } } } });
  await assert.rejects(readVaultFolder(deep, { maxDepth: 2 }), (e) => e.limit === 'maxDepth');
  assert.ok((await readVaultFolder(deep, { maxDepth: 3 })).files.has('a/b/c/x.md'));
  assert.ok(DEFAULT_LIMITS.maxFiles > 0 && DEFAULT_LIMITS.maxDepth > 0);
});

test('a loaded vault shows no changes, and then exactly what the engine added, changed and removed', () => {
  const fs = memfs();
  const m = new VaultMount(fs, '/vault');
  m.load(new Map([['A/ROADMAP/tasks/a.md', enc('one')], ['A/ROADMAP/tasks/b.md', enc('two')], ['areas.json', enc('{}')]]));
  assert.equal(dec(fs.readFile('/vault/A/ROADMAP/tasks/a.md')), 'one', 'the files are in the VM');
  assert.deepEqual(m.changes(), { added: [], modified: [], removed: [] });

  fs.mkdir('/vault/A/Backlog');
  fs.writeFile('/vault/A/Backlog/done.md', 'new');
  fs.writeFile('/vault/A/ROADMAP/tasks/a.md', 'one!');
  fs.unlink('/vault/A/ROADMAP/tasks/b.md');
  assert.deepEqual(m.changes(), {
    added: ['A/Backlog/done.md'],
    modified: ['A/ROADMAP/tasks/a.md'],
    removed: ['A/ROADMAP/tasks/b.md'],
  });
  assert.equal(dec(m.read('A/ROADMAP/tasks/a.md')), 'one!');
  assert.equal(m.read('A/ROADMAP/tasks/b.md'), undefined);
  assert.equal(m.read('A/ROADMAP'), undefined, 'a folder is not a file to write back');

  m.accept();
  assert.deepEqual(m.changes(), { added: [], modified: [], removed: [] }, 'after the write-back there is nothing left');
});

test('a write of the same bytes is no change, a write of other bytes of the same size is', () => {
  const fs = memfs();
  const m = new VaultMount(fs, '/vault');
  m.load(new Map([['a.md', enc('abc')]]));
  fs.writeFile('/vault/a.md', 'abc');
  assert.deepEqual(m.changes().modified, []);
  fs.writeFile('/vault/a.md', 'abd');
  assert.deepEqual(m.changes().modified, ['a.md']);
});

test('the loaded state is a copy: changing the caller\'s array later is no engine change', () => {
  const fs = memfs();
  const m = new VaultMount(fs, '/vault');
  const bytes = enc('abc');
  m.load(new Map([['a.md', bytes]]));
  bytes[0] = 0;
  assert.deepEqual(m.changes(), { added: [], modified: [], removed: [] });
});

test('loading again replaces the vault, and a root outside the VM is refused', () => {
  const fs = memfs();
  const m = new VaultMount(fs, '/vault');
  m.load(new Map([['old/x.md', enc('x')]]));
  m.load(new Map([['new/y.md', enc('y')]]));
  assert.equal(m.read('old/x.md'), undefined, 'the old vault is gone from the VM');
  assert.equal(dec(m.read('new/y.md')), 'y');
  assert.deepEqual(m.changes(), { added: [], modified: [], removed: [] });
  for (const bad of ['vault', '/', '/vault/']) assert.throws(() => new VaultMount(fs, bad), /absolute folder/, bad);
});
