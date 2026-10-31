// The folder chosen through an `<input webkitdirectory>` (Firefox, Safari), as the reader of the vault takes it: the
// folder appkit-web/folder-input makes of the browser's list is read like any other (the input itself is tested in the
// kit).
//
//   node --experimental-strip-types --test web/folder-input.test.mjs        (from ui/)

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { folderOfFiles } from 'appkit-web/folder-input';
import { readVaultFolder } from '../src/web/vault-files.ts';

const enc = new TextEncoder();

/** A `File` as the browser lists it for a chosen folder `top`: the path below it in `webkitRelativePath`. */
function file(path, text = 'x', lastModified = 1000) {
  const bytes = enc.encode(text);
  return {
    name: path.split('/').at(-1),
    size: bytes.byteLength,
    lastModified,
    webkitRelativePath: path,
    arrayBuffer: async () => bytes.buffer.slice(0),
  };
}

test('the files of a chosen folder are read like any folder: tree, names, bytes, times', async () => {
  const folder = folderOfFiles([
    file('vault/A/b.md', 'task b', 20),
    file('vault/A/a.md', 'task a', 10),
    file('vault/areas.json', '{}'),
    file('vault/.git/config', 'hidden'),
    file('vault/notes.txt', 'not a task'),
    file('vault/A/deep/c.md', 'task c'),
  ]);
  assert.equal(folder.name, 'vault');
  assert.equal(folder.count, 6);
  const read = await readVaultFolder(folder);
  assert.deepEqual([...read.files.keys()].sort(), ['A/a.md', 'A/b.md', 'A/deep/c.md', 'areas.json']);
  assert.equal(new TextDecoder().decode(read.files.get('A/a.md')), 'task a');
  assert.deepEqual(read.stamps.get('A/b.md'), { size: 6, lastModified: 20 });
  assert.deepEqual(read.skipped, []);
});

test('a name that is no plain name is skipped by the reader, as in a picked folder', async () => {
  const folder = folderOfFiles([file('vault/ok.md'), file('vault/A/back\\slash.md')]);
  const read = await readVaultFolder(folder);
  assert.deepEqual([...read.files.keys()], ['ok.md']);
  assert.deepEqual(read.skipped, [{ path: 'A/back\\slash.md', reason: 'name' }]);
});

test('a list the browser gave without a folder in the paths, or from two folders, is refused', () => {
  assert.throws(() => folderOfFiles([file('loose.md')]), /did not tell where/);
  assert.throws(() => folderOfFiles([file('one/a.md'), file('two/b.md')]), /one folder/);
  // an empty folder lists nothing: an empty vault, not a failure of this module
  assert.equal(folderOfFiles([]).count, 0);
});
