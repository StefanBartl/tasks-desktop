// The folder chosen through an `<input webkitdirectory>` (Firefox, Safari): the flat list of files the browser hands
// over becomes a folder the reader walks, the input is asked for in a click and answers with a choice or a cancel.
//
//   node --experimental-strip-types --test web/folder-input.test.mjs        (from ui/)

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { folderOfFiles, inputFolderSupport, pickFolderByInput } from '../src/web/folder-input.ts';
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

/** A document whose input the test drives: `fire('change')` / `fire('cancel')` after the click. */
function documentWith({ files = null, support = true, failClick = false } = {}) {
  const made = { clicks: 0, removed: 0, appended: 0, input: null };
  const listeners = {};
  const input = {
    type: '',
    files,
    click() {
      made.clicks++;
      if (failClick) throw new Error('blocked');
    },
    remove() {
      made.removed++;
    },
    addEventListener(type, listener) {
      listeners[type] = listener;
    },
  };
  if (support) input.webkitdirectory = false;
  made.input = input;
  made.fire = (type) => listeners[type]();
  return {
    made,
    doc: {
      createElement: () => input,
      body: { appendChild: () => void made.appended++ },
    },
  };
}

test('the support is whether an input knows webkitdirectory', () => {
  assert.equal(inputFolderSupport(documentWith().doc), true);
  assert.equal(inputFolderSupport(documentWith({ support: false }).doc), false);
  assert.equal(inputFolderSupport(undefined), false);
  assert.equal(inputFolderSupport({ createElement: () => { throw new Error('no'); } }), false);
});

test('asking for a folder opens the dialog once, takes the choice and cleans up', async () => {
  const { doc, made } = documentWith({ files: [file('vault/A/a.md')] });
  const asking = pickFolderByInput(doc);
  assert.equal(made.clicks, 1);
  assert.equal(made.input.type, 'file');
  assert.equal(made.input.webkitdirectory, true);
  assert.equal(made.appended, 1);
  made.fire('change');
  const result = await asking;
  assert.equal(result.kind, 'picked');
  assert.equal(result.folder.name, 'vault');
  assert.equal(made.removed, 1);
});

test('a closed dialog, an empty choice and a failing click are told apart', async () => {
  const closed = documentWith();
  const a = pickFolderByInput(closed.doc);
  closed.made.fire('cancel');
  assert.deepEqual(await a, { kind: 'cancelled' });

  // a choice that lists no file is an empty folder, not a cancel
  const empty = documentWith({ files: [] });
  const b = pickFolderByInput(empty.doc);
  empty.made.fire('change');
  assert.deepEqual(await b, { kind: 'empty' });

  const refused = documentWith({ failClick: true });
  const c = await pickFolderByInput(refused.doc);
  assert.equal(c.kind, 'failed');
  assert.match(c.message, /blocked/);
  assert.equal(refused.made.removed, 1);

  // files without their place in the folder (Safari on iOS): told apart, so the page can say it in the person's words
  const odd = documentWith({ files: [file('no-folder.md'), { ...file('x.md'), webkitRelativePath: '' }] });
  const d = pickFolderByInput(odd.doc);
  odd.made.fire('change');
  assert.deepEqual(await d, { kind: 'no_paths' });
  const twoFolders = documentWith({ files: [file('one/a.md'), file('two/b.md')] });
  const e = pickFolderByInput(twoFolders.doc);
  twoFolders.made.fire('change');
  assert.equal((await e).kind, 'failed');
});
