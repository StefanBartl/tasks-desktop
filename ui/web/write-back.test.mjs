// The write-back of the web variant against a fake folder: what is written, and above all what is NOT written when the
// folder is not what the page read. No browser, no engine, no install.
//
//   node --experimental-strip-types --test web/write-back.test.mjs        (from ui/)

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readVaultFolder } from '../src/web/vault-files.ts';
import { makeBaseline, refusalOfPath, sha256Hex, writeBack } from '../src/web/write-back.ts';
import { fakeDisk } from './fake-folder.mjs';

const enc = (s) => new TextEncoder().encode(s);

const VAULT = {
  'A/ROADMAP/tasks/a.md': 'task a',
  'A/ROADMAP/tasks/b.md': 'task b',
  'A/ROADMAP/tasks/c.md': 'task c',
  'A/Backlog/README.md': 'backlog',
  'areas.json': '{}',
};

/** A disk with the vault on it, read the way the page reads it, and the baseline from that. */
async function opened(tree = VAULT, options = {}) {
  const disk = fakeDisk(tree, options);
  const vault = await readVaultFolder(disk.root);
  return { disk, baseline: await makeBaseline(vault), vault };
}

const changes = (part = {}) => ({ added: [], modified: [], removed: [], removedDirs: [], ...part });
const filesOf = (record) => new Map(Object.entries(record).map(([p, t]) => [p, enc(t)]));
const mutating = (log) => log.filter((entry) => /^(make|create|write|close|remove|move) /.test(entry));

test('a change is written: new file in a new folder, changed file, removed file; the baseline moves on', async () => {
  const { disk, baseline } = await opened();
  const before = baseline.get('A/ROADMAP/tasks/a.md');
  const result = await writeBack({
    root: disk.root,
    baseline,
    changes: changes({ added: ['A/Backlog/FEATURES/done.md'], modified: ['A/ROADMAP/tasks/a.md'], removed: ['A/ROADMAP/tasks/b.md'] }),
    files: filesOf({ 'A/Backlog/FEATURES/done.md': 'finished', 'A/ROADMAP/tasks/a.md': 'task a, changed' }),
  });
  assert.equal(result.status, 'written', JSON.stringify(result));
  assert.deepEqual(result.written, ['A/Backlog/FEATURES/done.md', 'A/ROADMAP/tasks/a.md']);
  assert.deepEqual(result.removed, ['A/ROADMAP/tasks/b.md']);
  assert.equal(disk.read('A/Backlog/FEATURES/done.md'), 'finished');
  assert.equal(disk.read('A/ROADMAP/tasks/a.md'), 'task a, changed');
  assert.equal(disk.read('A/ROADMAP/tasks/b.md'), undefined);
  assert.equal(disk.read('A/ROADMAP/tasks/c.md'), 'task c', 'a file the change does not name is not touched');
  // the baseline is what is on disk now
  assert.equal(baseline.has('A/ROADMAP/tasks/b.md'), false);
  const a = baseline.get('A/ROADMAP/tasks/a.md');
  assert.equal(a.digest, await sha256Hex(enc('task a, changed')));
  assert.notEqual(a.digest, before.digest);
  assert.notEqual(a.lastModified, before.lastModified, 'the time of the write is the new state');
  assert.equal(baseline.get('A/Backlog/FEATURES/done.md').size, 8);
});

test('a second write on the same file works with the baseline the first one left', async () => {
  const { disk, baseline } = await opened();
  const base = { root: disk.root, baseline };
  const first = await writeBack({ ...base, changes: changes({ modified: ['A/ROADMAP/tasks/a.md'] }), files: filesOf({ 'A/ROADMAP/tasks/a.md': 'one' }) });
  assert.equal(first.status, 'written');
  const second = await writeBack({ ...base, changes: changes({ modified: ['A/ROADMAP/tasks/a.md'] }), files: filesOf({ 'A/ROADMAP/tasks/a.md': 'two' }) });
  assert.equal(second.status, 'written', 'the page\'s own write is no foreign change');
  assert.equal(disk.read('A/ROADMAP/tasks/a.md'), 'two');
});

test('a file that was changed on disk is a conflict: nothing is written, not even the files that were fine', async () => {
  const { disk, baseline } = await opened();
  disk.write('A/ROADMAP/tasks/a.md', 'edited in an editor');
  const snapshot = disk.snapshot();
  const logged = disk.log.length;
  const result = await writeBack({
    root: disk.root,
    baseline,
    changes: changes({ added: ['A/new.md'], modified: ['A/ROADMAP/tasks/a.md', 'A/ROADMAP/tasks/c.md'], removed: ['A/ROADMAP/tasks/b.md'] }),
    files: filesOf({ 'A/new.md': 'n', 'A/ROADMAP/tasks/a.md': 'mine', 'A/ROADMAP/tasks/c.md': 'mine too' }),
  });
  assert.equal(result.status, 'conflict');
  assert.deepEqual(result.conflicts, [{ path: 'A/ROADMAP/tasks/a.md', reason: 'changed' }]);
  assert.equal(disk.snapshot(), snapshot, 'the disk is as it was, the editor\'s text included');
  assert.deepEqual(mutating(disk.log.slice(logged)), [], 'no write, no creation, no removal was even tried');
  assert.equal(baseline.get('A/ROADMAP/tasks/a.md').size, 6, 'the baseline is the state that was read');
});

test('the same text with a newer time is a conflict too, and so is the same time with other text of the same size', async () => {
  const { disk, baseline } = await opened();
  disk.touch('A/ROADMAP/tasks/a.md');
  const touched = await writeBack({ root: disk.root, baseline, changes: changes({ modified: ['A/ROADMAP/tasks/a.md'] }), files: filesOf({ 'A/ROADMAP/tasks/a.md': 'x' }) });
  assert.deepEqual(touched.conflicts, [{ path: 'A/ROADMAP/tasks/a.md', reason: 'changed' }]);

  // the time kept, the bytes changed (a program that sets the time back): the digest is what tells
  const { disk: d2, baseline: b2 } = await opened();
  const was = b2.get('A/ROADMAP/tasks/b.md');
  d2.write('A/ROADMAP/tasks/b.md', 'task X');
  const node = d2.root.__node.children.get('A').children.get('ROADMAP').children.get('tasks').children.get('b.md');
  node.time = was.lastModified;
  const same = await writeBack({ root: d2.root, baseline: b2, changes: changes({ modified: ['A/ROADMAP/tasks/b.md'] }), files: filesOf({ 'A/ROADMAP/tasks/b.md': 'x' }) });
  assert.deepEqual(same.conflicts, [{ path: 'A/ROADMAP/tasks/b.md', reason: 'changed' }]);
  assert.equal(d2.read('A/ROADMAP/tasks/b.md'), 'task X');
});

test('a file that is gone from the disk is a conflict, to change it and to remove it', async () => {
  const { disk, baseline } = await opened();
  disk.remove('A/ROADMAP/tasks/a.md');
  disk.remove('A/ROADMAP/tasks/b.md');
  const snapshot = disk.snapshot();
  const result = await writeBack({
    root: disk.root,
    baseline,
    changes: changes({ modified: ['A/ROADMAP/tasks/a.md'], removed: ['A/ROADMAP/tasks/b.md'] }),
    files: filesOf({ 'A/ROADMAP/tasks/a.md': 'x' }),
  });
  assert.equal(result.status, 'conflict');
  assert.deepEqual(result.conflicts, [
    { path: 'A/ROADMAP/tasks/a.md', reason: 'removed' },
    { path: 'A/ROADMAP/tasks/b.md', reason: 'removed' },
  ]);
  assert.equal(disk.snapshot(), snapshot);
});

test('a file that was changed on disk is not removed', async () => {
  const { disk, baseline } = await opened();
  disk.write('A/ROADMAP/tasks/b.md', 'precious edit');
  const result = await writeBack({ root: disk.root, baseline, changes: changes({ removed: ['A/ROADMAP/tasks/b.md'] }), files: new Map() });
  assert.equal(result.status, 'conflict');
  assert.equal(disk.read('A/ROADMAP/tasks/b.md'), 'precious edit');
});

test('a new file on disk where the engine made one is a conflict, a folder in its place too', async () => {
  const { disk, baseline } = await opened();
  disk.write('A/ROADMAP/tasks/fresh.md', 'someone else made this');
  disk.mkdir('A/ROADMAP/tasks/sub.md');
  const snapshot = disk.snapshot();
  const result = await writeBack({
    root: disk.root,
    baseline,
    changes: changes({ added: ['A/ROADMAP/tasks/fresh.md', 'A/ROADMAP/tasks/sub.md', 'A/ok.md'] }),
    files: filesOf({ 'A/ROADMAP/tasks/fresh.md': 'mine', 'A/ROADMAP/tasks/sub.md': 'mine', 'A/ok.md': 'ok' }),
  });
  assert.equal(result.status, 'conflict');
  assert.deepEqual(result.conflicts.map((c) => `${c.path} ${c.reason}`), ['A/ROADMAP/tasks/fresh.md exists', 'A/ROADMAP/tasks/sub.md exists']);
  assert.equal(disk.snapshot(), snapshot);

  // a file where the engine needs a folder
  const { disk: d2, baseline: b2 } = await opened();
  d2.write('B', 'a file named like the area');
  const blocked = await writeBack({ root: d2.root, baseline: b2, changes: changes({ added: ['B/new.md'] }), files: filesOf({ 'B/new.md': 'x' }) });
  assert.equal(blocked.status, 'conflict');
  assert.equal(d2.read('B'), 'a file named like the area');
});

test('a failure in the middle takes back what was done: the disk is as before and the baseline is unchanged', async () => {
  const { disk, baseline } = await opened();
  const snapshot = disk.snapshot();
  const before = structuredClone([...baseline]);
  // the third write fails: new file, then a changed file, then the next changed file
  disk.failOn = (op, path) => op === 'close' && path === 'A/ROADMAP/tasks/c.md';
  const result = await writeBack({
    root: disk.root,
    baseline,
    changes: changes({ added: ['A/new/deep/x.md'], modified: ['A/ROADMAP/tasks/a.md', 'A/ROADMAP/tasks/c.md'], removed: ['A/ROADMAP/tasks/b.md'] }),
    files: filesOf({ 'A/new/deep/x.md': 'x', 'A/ROADMAP/tasks/a.md': 'a2', 'A/ROADMAP/tasks/c.md': 'c2' }),
  });
  assert.equal(result.status, 'failed');
  assert.equal(result.undone, true, result.message);
  assert.match(result.message, /A\/ROADMAP\/tasks\/c\.md/);
  disk.failOn = null;
  assert.equal(disk.read('A/ROADMAP/tasks/a.md'), 'task a', 'the changed file has its old bytes');
  assert.equal(disk.read('A/ROADMAP/tasks/b.md'), 'task b', 'nothing was removed (removals come last)');
  assert.equal(disk.read('A/ROADMAP/tasks/c.md'), 'task c');
  assert.equal(disk.read('A/new/deep/x.md'), undefined, 'the new file is gone again');
  assert.deepEqual(disk.folders().filter((f) => f.startsWith('A/new')), [], 'and so are the folders made for it');
  assert.deepEqual([...baseline], before, 'the baseline was not touched');
  assert.equal(disk.snapshot(), snapshot, 'files and folders are exactly as they were');
});

test('a failure after a removal gives the removed file back', async () => {
  const { disk, baseline } = await opened();
  // the removal of b works, the removal of c fails
  disk.failOn = (op, path) => op === 'remove' && path === 'A/ROADMAP/tasks/c.md';
  const result = await writeBack({ root: disk.root, baseline, changes: changes({ removed: ['A/ROADMAP/tasks/b.md', 'A/ROADMAP/tasks/c.md'] }), files: new Map() });
  assert.equal(result.status, 'failed');
  assert.equal(result.undone, true);
  disk.failOn = null;
  assert.equal(disk.read('A/ROADMAP/tasks/b.md'), 'task b');
  assert.equal(disk.read('A/ROADMAP/tasks/c.md'), 'task c');
});

test('what cannot be taken back is told by name, and the baseline still is not claimed to be true', async () => {
  const { disk, baseline } = await opened();
  // a is written, then c fails; taking a back fails too
  disk.failOn = (op, path) => (op === 'close' && path === 'A/ROADMAP/tasks/c.md') || (op === 'close' && path === 'A/ROADMAP/tasks/a.md' && disk.read('A/ROADMAP/tasks/a.md') === 'a2');
  const result = await writeBack({
    root: disk.root,
    baseline,
    changes: changes({ modified: ['A/ROADMAP/tasks/a.md', 'A/ROADMAP/tasks/c.md'] }),
    files: filesOf({ 'A/ROADMAP/tasks/a.md': 'a2', 'A/ROADMAP/tasks/c.md': 'c2' }),
  });
  assert.equal(result.status, 'failed');
  assert.equal(result.undone, false);
  assert.deepEqual(result.leftover, ['A/ROADMAP/tasks/a.md']);
  assert.match(result.message, /not taken back: A\/ROADMAP\/tasks\/a\.md/);
  assert.equal(baseline.get('A/ROADMAP/tasks/a.md').size, 6, 'the old entry stays; the caller reads the folder again');
});

test('a file that changes between the check and its turn is not overwritten, and what was written before it is taken back', async () => {
  const { disk, baseline } = await opened();
  // while the new file is being created, an editor saves c
  disk.failOn = (op, path) => {
    if (op === 'create' && path === 'A/0-first.md') disk.write('A/ROADMAP/tasks/c.md', 'edited meanwhile');
    return false;
  };
  const result = await writeBack({
    root: disk.root,
    baseline,
    changes: changes({ added: ['A/0-first.md'], modified: ['A/ROADMAP/tasks/c.md'] }),
    files: filesOf({ 'A/0-first.md': 'first', 'A/ROADMAP/tasks/c.md': 'mine' }),
  });
  disk.failOn = null;
  assert.equal(result.status, 'conflict', 'a foreign change found late is a conflict, as one found by the check: the person retries');
  assert.deepEqual(result.conflicts, [{ path: 'A/ROADMAP/tasks/c.md', reason: 'changed' }]);
  assert.match(result.message, /changed while writing, everything was taken back: A\/ROADMAP\/tasks\/c\.md \(changed\)/);
  assert.equal(disk.read('A/ROADMAP/tasks/c.md'), 'edited meanwhile', "the editor's text survives");
  assert.equal(disk.read('A/0-first.md'), undefined);
});

// While the first new file is made, an editor saves a file the change still has to touch, with a text of the same size
// (the size alone does not tell) or another size, and the time moves on either way.
for (const [label, foreign] of [
  ['another size', 'edited meanwhile'],
  ['the same size', 'task X'],
]) {
  const cases = [
    ['changed', { modified: ['A/ROADMAP/tasks/c.md'] }, {}],
    ['removed', { removed: ['A/ROADMAP/tasks/c.md'] }, {}],
    ['moved', { added: ['A/Backlog/TASKS/c.md'], removed: ['A/ROADMAP/tasks/c.md'] }, { 'A/Backlog/TASKS/c.md': 'task c' }],
  ];
  for (const [kind, part, extra] of cases) {
    test(`a file that is ${kind} by the change and saved by an editor with ${label} right before its turn survives, and nothing stays written`, async () => {
      const victim = 'A/ROADMAP/tasks/c.md';
      const { disk, baseline } = await opened();
      disk.failOn = (op, path) => {
        if (op === 'create' && path === 'A/0-first.md') disk.write(victim, foreign);
        return false;
      };
      const result = await writeBack({
        root: disk.root,
        baseline,
        changes: changes({ ...part, added: ['A/0-first.md', ...(part.added ?? [])] }),
        files: filesOf({ 'A/0-first.md': 'first', [victim]: 'mine', ...extra }),
      });
      disk.failOn = null;
      assert.equal(result.status, 'conflict', JSON.stringify(result));
      assert.deepEqual(result.conflicts, [{ path: victim, reason: 'changed' }]);
      assert.deepEqual(disk.files(), { ...VAULT, [victim]: foreign }, "only the editor's change is on the disk");
      assert.equal(disk.log.some((entry) => entry.startsWith('make A/Backlog/TASKS/c.md')), false, 'no copy of the changed file was made');
    });
  }
}

test('a file that is replaced by a folder right before its turn is a conflict too', async () => {
  const { disk, baseline } = await opened();
  disk.failOn = (op, path) => {
    if (op === 'create' && path === 'A/0-first.md') {
      disk.remove('A/ROADMAP/tasks/c.md');
      disk.mkdir('A/ROADMAP/tasks/c.md');
    }
    return false;
  };
  const result = await writeBack({
    root: disk.root,
    baseline,
    changes: changes({ added: ['A/0-first.md'], modified: ['A/ROADMAP/tasks/c.md'] }),
    files: filesOf({ 'A/0-first.md': 'first', 'A/ROADMAP/tasks/c.md': 'mine' }),
  });
  disk.failOn = null;
  assert.equal(result.status, 'conflict', JSON.stringify(result));
  assert.equal(disk.read('A/0-first.md'), undefined);
  assert.ok(disk.folders().includes('A/ROADMAP/tasks/c.md'));
});

// The check saw nothing at the place of a new file; before it is made, someone makes a file (or a folder) there.
for (const [label, make] of [
  ['file', (disk, path) => disk.write(path, 'someone else made this')],
  ['folder', (disk, path) => disk.mkdir(path)],
]) {
  test(`a new file is not made over a ${label} that appeared after the check, and the file made before it is taken back`, async () => {
    const { disk, baseline } = await opened();
    disk.failOn = (op, path) => {
      if (op === 'create' && path === 'A/0-first.md') make(disk, 'A/z-second.md');
      return false;
    };
    const result = await writeBack({
      root: disk.root,
      baseline,
      changes: changes({ added: ['A/0-first.md', 'A/z-second.md'] }),
      files: filesOf({ 'A/0-first.md': 'first', 'A/z-second.md': 'mine' }),
    });
    disk.failOn = null;
    assert.equal(result.status, 'conflict', JSON.stringify(result));
    assert.deepEqual(result.conflicts, [{ path: 'A/z-second.md', reason: 'exists' }]);
    assert.equal(disk.read('A/0-first.md'), undefined);
    if (label === 'file') assert.equal(disk.read('A/z-second.md'), 'someone else made this', 'the foreign file is neither replaced nor removed');
    else assert.ok(disk.folders().includes('A/z-second.md'));
  });
}

test('the name a file is moved to is looked at once more right before the move', async () => {
  const { disk, baseline } = await opened();
  disk.failOn = (op, path) => {
    if (op === 'create' && path === 'A/0-first.md') disk.write('A/Backlog/TASKS/b.md', 'someone else made this');
    return false;
  };
  const result = await writeBack({
    root: disk.root,
    baseline,
    changes: changes({ added: ['A/0-first.md', 'A/Backlog/TASKS/b.md'], removed: ['A/ROADMAP/tasks/b.md'] }),
    files: filesOf({ 'A/0-first.md': 'first', 'A/Backlog/TASKS/b.md': 'task b' }),
  });
  disk.failOn = null;
  assert.equal(result.status, 'conflict', JSON.stringify(result));
  assert.equal(disk.read('A/Backlog/TASKS/b.md'), 'someone else made this');
  assert.equal(disk.read('A/ROADMAP/tasks/b.md'), 'task b');
});

test('when the move fails and someone made the target meanwhile, the copy is not made over it', async () => {
  const { disk, baseline } = await opened();
  disk.failOn = (op) => {
    if (op !== 'move') return false;
    disk.write('A/Backlog/TASKS/b.md', 'someone else made this');
    return true;
  };
  const result = await writeBack({
    root: disk.root,
    baseline,
    changes: changes({ added: ['A/Backlog/TASKS/b.md'], removed: ['A/ROADMAP/tasks/b.md'] }),
    files: filesOf({ 'A/Backlog/TASKS/b.md': 'task b' }),
  });
  disk.failOn = null;
  assert.equal(result.status, 'conflict', JSON.stringify(result));
  assert.deepEqual(result.conflicts, [{ path: 'A/Backlog/TASKS/b.md', reason: 'exists' }]);
  assert.equal(disk.read('A/Backlog/TASKS/b.md'), 'someone else made this');
  assert.equal(disk.read('A/ROADMAP/tasks/b.md'), 'task b');
});

test('taking back a changed file leaves it alone when an editor saved it after our write', async () => {
  const { disk, baseline } = await opened();
  // a is written; then the write of c fails, and while it does an editor saves a
  disk.failOn = (op, path) => {
    if (op === 'close' && path === 'A/ROADMAP/tasks/c.md') {
      disk.write('A/ROADMAP/tasks/a.md', 'editor text');
      return true;
    }
    return false;
  };
  const result = await writeBack({
    root: disk.root,
    baseline,
    changes: changes({ modified: ['A/ROADMAP/tasks/a.md', 'A/ROADMAP/tasks/c.md'] }),
    files: filesOf({ 'A/ROADMAP/tasks/a.md': 'a2', 'A/ROADMAP/tasks/c.md': 'c2' }),
  });
  disk.failOn = null;
  assert.equal(result.status, 'failed');
  assert.equal(result.undone, false);
  assert.deepEqual(result.leftover, ['A/ROADMAP/tasks/a.md']);
  assert.equal(disk.read('A/ROADMAP/tasks/a.md'), 'editor text', "the old bytes were not given back over the editor's");
  assert.equal(disk.read('A/ROADMAP/tasks/c.md'), 'task c');
});

test('the read-back after the write finds a file that does not hold what was written and does not claim success', async () => {
  const { disk, baseline } = await opened();
  let written = false;
  disk.failOn = (op, path) => {
    if (op === 'close' && path === 'A/ROADMAP/tasks/a.md') written = true;
    // the first look at a.md after its write is the read-back: someone else wrote in between
    if (op === 'getFile' && path === 'A/ROADMAP/tasks/a.md' && written) {
      written = false;
      disk.write('A/ROADMAP/tasks/a.md', 'foreign');
    }
    return false;
  };
  const result = await writeBack({ root: disk.root, baseline, changes: changes({ modified: ['A/ROADMAP/tasks/a.md'] }), files: filesOf({ 'A/ROADMAP/tasks/a.md': 'mine' }) });
  disk.failOn = null;
  assert.equal(result.status, 'failed');
  assert.equal(result.undone, false);
  assert.deepEqual(result.leftover, ['A/ROADMAP/tasks/a.md']);
  assert.equal(disk.read('A/ROADMAP/tasks/a.md'), 'foreign', 'the foreign write is not given back');
  assert.equal(baseline.get('A/ROADMAP/tasks/a.md').size, 6);
});

test('a foreign write of the same size between our write and the read-back is not taken for ours', async () => {
  const { disk, baseline } = await opened();
  let written = false;
  disk.failOn = (op, path) => {
    if (op === 'close' && path === 'A/ROADMAP/tasks/a.md') written = true;
    if (op === 'getFile' && path === 'A/ROADMAP/tasks/a.md' && written) {
      written = false;
      disk.write('A/ROADMAP/tasks/a.md', 'MINE');
    }
    return false;
  };
  const result = await writeBack({ root: disk.root, baseline, changes: changes({ modified: ['A/ROADMAP/tasks/a.md'] }), files: filesOf({ 'A/ROADMAP/tasks/a.md': 'mine' }) });
  disk.failOn = null;
  assert.equal(result.status, 'failed');
  assert.deepEqual(result.leftover, ['A/ROADMAP/tasks/a.md']);
  assert.equal(disk.read('A/ROADMAP/tasks/a.md'), 'MINE');
  assert.equal(baseline.get('A/ROADMAP/tasks/a.md').size, 6, 'the baseline does not claim the file holds what we wrote');
});

test('hostile or unplain paths are refused before anything is written', async () => {
  const bad = [
    '../escape.md',
    'a/../../escape.md',
    '/abs.md',
    'a//b.md',
    'a\\b.md',
    'a/\0b.md',
    '.git/hooks/x.md',
    'A/.hidden/x.md',
    'node_modules/x.md',
    'notes.txt',
    'A/script.sh',
    'sub/areas.json',
    '',
    '..',
    'A/' + 'x'.repeat(300) + '.md',
  ];
  for (const path of bad) {
    const { disk, baseline } = await opened();
    const snapshot = disk.snapshot();
    const logged = disk.log.length;
    for (const kind of ['added', 'modified', 'removed']) {
      const result = await writeBack({ root: disk.root, baseline, changes: changes({ [kind]: [path] }), files: filesOf({ [path]: 'x' }) });
      assert.equal(result.status, 'refused', `${kind} ${JSON.stringify(path)}`);
    }
    assert.equal(disk.snapshot(), snapshot, JSON.stringify(path));
    assert.deepEqual(mutating(disk.log.slice(logged)), [], JSON.stringify(path));
  }
  // and the reasons are the same function the tests above rely on
  assert.equal(refusalOfPath('A/ROADMAP/tasks/x.md'), null);
  assert.equal(refusalOfPath('areas.json'), null);
  assert.match(refusalOfPath('A/.git/x.md'), /not a place/);
  assert.match(refusalOfPath('a/../b.md'), /not a plain path/);
});

test('a path named twice, a file never read and a missing byte list are refused', async () => {
  const { disk, baseline } = await opened();
  const snapshot = disk.snapshot();
  const twice = await writeBack({ root: disk.root, baseline, changes: changes({ modified: ['A/ROADMAP/tasks/a.md'], removed: ['A/ROADMAP/tasks/a.md'] }), files: filesOf({ 'A/ROADMAP/tasks/a.md': 'x' }) });
  assert.equal(twice.status, 'refused');
  const unread = await writeBack({ root: disk.root, baseline, changes: changes({ modified: ['A/never-read.md'] }), files: filesOf({ 'A/never-read.md': 'x' }) });
  assert.equal(unread.status, 'refused');
  const nobytes = await writeBack({ root: disk.root, baseline, changes: changes({ modified: ['A/ROADMAP/tasks/a.md'] }), files: new Map() });
  assert.equal(nobytes.status, 'refused');
  assert.equal(disk.snapshot(), snapshot);
  // these are faults of the list of changes, not places the person may not write
  assert.deepEqual([twice.internal, unread.internal, nobytes.internal], [true, true, true]);
  const outside = await writeBack({ root: disk.root, baseline, changes: changes({ added: ['.git/x.md'] }), files: filesOf({ '.git/x.md': 'x' }) });
  assert.equal(outside.status, 'refused');
  assert.notEqual(outside.internal, true);
});

test('a file the engine renamed is moved when the browser can, and copied and deleted when it cannot', async () => {
  for (const noMove of [false, true]) {
    const { disk, baseline } = await opened(VAULT, { noMove });
    const result = await writeBack({
      root: disk.root,
      baseline,
      changes: changes({ added: ['A/Backlog/TASKS/b.md'], removed: ['A/ROADMAP/tasks/b.md'] }),
      files: filesOf({ 'A/Backlog/TASKS/b.md': 'task b' }),
    });
    assert.equal(result.status, 'written', JSON.stringify(result));
    assert.equal(disk.read('A/ROADMAP/tasks/b.md'), undefined);
    assert.equal(disk.read('A/Backlog/TASKS/b.md'), 'task b');
    assert.equal(disk.log.some((entry) => entry.startsWith('move ')), !noMove, noMove ? 'no move without the method' : 'moved');
    assert.equal(baseline.has('A/ROADMAP/tasks/b.md'), false);
    assert.equal(baseline.get('A/Backlog/TASKS/b.md').digest, await sha256Hex(enc('task b')));
  }
});

test('a move that fails falls back to copy and delete; a failure after a move puts the file back', async () => {
  const { disk, baseline } = await opened();
  disk.failOn = (op) => op === 'move';
  const fell = await writeBack({
    root: disk.root,
    baseline,
    changes: changes({ added: ['A/Backlog/TASKS/b.md'], removed: ['A/ROADMAP/tasks/b.md'] }),
    files: filesOf({ 'A/Backlog/TASKS/b.md': 'task b' }),
  });
  assert.equal(fell.status, 'written', JSON.stringify(fell));
  assert.equal(disk.read('A/Backlog/TASKS/b.md'), 'task b');
  assert.equal(disk.read('A/ROADMAP/tasks/b.md'), undefined);

  const { disk: d2, baseline: b2 } = await opened();
  // b is moved; then the change of c fails
  d2.failOn = (op, path) => op === 'close' && path === 'A/ROADMAP/tasks/c.md';
  const failed = await writeBack({
    root: d2.root,
    baseline: b2,
    changes: changes({ added: ['A/Backlog/TASKS/b.md'], modified: ['A/ROADMAP/tasks/c.md'], removed: ['A/ROADMAP/tasks/b.md'] }),
    files: filesOf({ 'A/Backlog/TASKS/b.md': 'task b', 'A/ROADMAP/tasks/c.md': 'c2' }),
  });
  d2.failOn = null;
  assert.equal(failed.status, 'failed');
  assert.equal(failed.undone, true);
  assert.equal(d2.read('A/ROADMAP/tasks/b.md'), 'task b', 'the moved file is back');
  assert.equal(d2.read('A/Backlog/TASKS/b.md'), undefined);
  assert.equal(d2.read('A/ROADMAP/tasks/c.md'), 'task c');
});

test('a folder the engine moved away is removed when it is empty, and refused while it holds files this page never saw', async () => {
  const tree = {
    'A/ROADMAP/tasks/fold/fold.md': 'folder task',
    'A/ROADMAP/tasks/fold/notes/more.md': 'more',
    'A/ROADMAP/tasks/other.md': 'other',
  };
  const done = changes({
    added: ['A/Backlog/fold/fold.md', 'A/Backlog/fold/notes/more.md'],
    removed: ['A/ROADMAP/tasks/fold/fold.md', 'A/ROADMAP/tasks/fold/notes/more.md'],
    removedDirs: ['A/ROADMAP/tasks/fold', 'A/ROADMAP/tasks/fold/notes'],
  });
  const files = filesOf({ 'A/Backlog/fold/fold.md': 'folder task, done', 'A/Backlog/fold/notes/more.md': 'more' });

  const { disk, baseline } = await opened(tree);
  const ok = await writeBack({ root: disk.root, baseline, changes: done, files });
  assert.equal(ok.status, 'written', JSON.stringify(ok));
  assert.deepEqual(disk.folders().filter((f) => f.startsWith('A/ROADMAP/tasks/fold')), [], 'the empty folder is gone');
  assert.equal(disk.read('A/Backlog/fold/notes/more.md'), 'more');
  assert.equal(disk.read('A/ROADMAP/tasks/other.md'), 'other');

  // the folder holds an image the page never read: moving the .md files alone would strand it
  const { disk: d2, baseline: b2 } = await opened(tree);
  d2.write('A/ROADMAP/tasks/fold/assets/shot.png', 'PNG-bytes');
  const snapshot = d2.snapshot();
  const refused = await writeBack({ root: d2.root, baseline: b2, changes: done, files });
  assert.equal(refused.status, 'refused');
  assert.match(refused.message, /assets\/shot\.png/);
  assert.equal(d2.snapshot(), snapshot, 'nothing was written');

  // a hidden file does not hold the folder back, and the folder stays because it is not empty
  const { disk: d3, baseline: b3 } = await opened(tree);
  d3.write('A/ROADMAP/tasks/fold/.gitkeep', '');
  const kept = await writeBack({ root: d3.root, baseline: b3, changes: done, files });
  assert.equal(kept.status, 'written');
  assert.equal(d3.read('A/ROADMAP/tasks/fold/.gitkeep'), '');
  assert.equal(d3.read('A/ROADMAP/tasks/fold/fold.md'), undefined);
});

test('a folder that is only emptied by the change, not removed by the engine, stays', async () => {
  const { disk, baseline } = await opened();
  const result = await writeBack({
    root: disk.root,
    baseline,
    changes: changes({ removed: ['A/ROADMAP/tasks/a.md', 'A/ROADMAP/tasks/b.md', 'A/ROADMAP/tasks/c.md'] }),
    files: new Map(),
  });
  assert.equal(result.status, 'written');
  assert.ok(disk.folders().includes('A/ROADMAP/tasks'));
});

test('an empty change list writes nothing and succeeds', async () => {
  const { disk, baseline } = await opened();
  const snapshot = disk.snapshot();
  const result = await writeBack({ root: disk.root, baseline, changes: changes(), files: new Map() });
  assert.deepEqual(result, { status: 'written', written: [], removed: [] });
  assert.equal(disk.snapshot(), snapshot);
});

test('a handle that throws is a failed result, never an exception', async () => {
  const { disk, baseline } = await opened();
  disk.failOn = (op) => op === 'getFile';
  const result = await writeBack({ root: disk.root, baseline, changes: changes({ modified: ['A/ROADMAP/tasks/a.md'] }), files: filesOf({ 'A/ROADMAP/tasks/a.md': 'x' }) });
  assert.equal(result.status, 'failed');
  assert.equal(result.undone, true, 'before the first write there is nothing to take back');
  assert.deepEqual(mutating(disk.log), []);
});
