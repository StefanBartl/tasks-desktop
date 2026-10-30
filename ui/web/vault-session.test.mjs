// The vault session of the web variant over a stand-in for the worker: the order in which reads and writes run, and
// what the session does when a step goes wrong. (With the real engine: ops.test.mjs.)
//
//   node --experimental-strip-types --test web/vault-session.test.mjs        (from ui/)

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { guardUnload, localDay, VaultSession } from '../src/web/vault-session.ts';
import { watchVault } from '../src/web/watch.ts';
import { fakeDisk } from './fake-folder.mjs';

const enc = (s) => new TextEncoder().encode(s);
const NONE = { added: [], modified: [], removed: [], removedDirs: [] };
const OK = JSON.stringify({ kind: 'tasks.result', ok: true, results: [] });
const REQUEST = JSON.stringify({ client_op_id: 'x', ops: [{ op: 'set', id: 'A/a', patch: { prio: 1 } }] });

/** A worker client whose answers the test decides. `gate` holds the engine call until the test lets it go. */
function client(options = {}) {
  const log = [];
  const state = {
    log,
    answer: { text: OK, code: null },
    pending: { changes: NONE, files: new Map() },
    failMount: false,
    failAccept: false,
    failCall: false,
    gate: null,
  };
  return Object.assign(state, {
    async mount(root, files) {
      log.push(`mount ${files.size}`);
      if (state.failMount) throw new Error('mount failed');
      return files.size;
    },
    async call(method, request, opts) {
      log.push(`call ${method} ${opts.today}`);
      if (state.gate) await state.gate;
      if (state.failCall) throw new Error('engine gone');
      return state.answer;
    },
    async pendingFiles() {
      log.push('pending');
      return state.pending;
    },
    async accept(changes) {
      log.push('accept');
      if (state.failAccept) throw new Error('accept failed');
      void changes;
    },
    ...options,
  });
}

async function open(tree = { 'A/a.md': 'task a', 'A/b.md': 'task b' }, options = {}, extra = {}) {
  const disk = fakeDisk(tree);
  const c = client(options);
  const signatures = [];
  const session = new VaultSession({
    client: c,
    handle: disk.root,
    root: '/vault',
    today: () => '2026-10-29',
    onSignature: (s) => signatures.push(s),
    ...extra,
  });
  await session.load();
  c.log.length = 0;
  return { disk, c, session, signatures };
}

/** A watcher on the session the way the page wires it: it starts at what the session knows, and is told what the session reads. */
function watching(session) {
  const seen = { told: 0 };
  const watcher = watchVault(session.knownSignature(), {
    signature: () => session.signature(),
    onChange: () => void seen.told++,
    setTimer: () => 0,
    clearTimer: () => {},
    onFocus: () => () => {},
  });
  return { watcher, seen };
}

test('the date the engine stamps is the local day, written with two digits', () => {
  assert.equal(localDay(new Date(2026, 0, 5, 23, 59)), '2026-01-05');
  assert.equal(localDay(new Date(2026, 11, 31, 0, 0)), '2026-12-31');
});

test('loading reads the folder into the VM and the session is not stale', async () => {
  const disk = fakeDisk({ 'A/a.md': 'x', 'notes.txt': 'not read' });
  const c = client();
  const session = new VaultSession({ client: c, handle: disk.root, root: '/vault', today: () => '2026-10-29' });
  assert.equal(session.isStale, true, 'before the first read the page knows nothing');
  const mounted = await session.load();
  assert.equal(mounted.files, 1);
  assert.equal(session.isStale, false);
  assert.deepEqual([...session.known().keys()], ['A/a.md']);
});

test('a write is dated with the local day of the page and a request that changed no file touches nothing', async () => {
  const { disk, c, session } = await open();
  const before = disk.snapshot();
  const outcome = await session.ops(REQUEST);
  assert.deepEqual(outcome, { kind: 'done', text: OK });
  assert.deepEqual(c.log, ['call ops 2026-10-29', 'pending']);
  assert.equal(disk.snapshot(), before);
});

test('the engine and the folder are written in the order: change, list, write, accept, signature', async () => {
  const { disk, c, session, signatures } = await open();
  c.pending = { changes: { ...NONE, modified: ['A/a.md'] }, files: new Map([['A/a.md', enc('task a, changed')]]) };
  const outcome = await session.ops(REQUEST);
  assert.equal(outcome.kind, 'done');
  assert.equal(disk.read('A/a.md'), 'task a, changed');
  assert.deepEqual(c.log, ['call ops 2026-10-29', 'pending', 'accept']);
  assert.equal(signatures.length, 1);
  assert.equal(signatures[0], await session.signature());
});

test('a re-read from the watcher waits for a write that is under way, and a read waits for both', async () => {
  const { disk, c, session } = await open();
  let release;
  c.gate = new Promise((resolve) => (release = resolve));
  c.pending = { changes: { ...NONE, modified: ['A/a.md'] }, files: new Map([['A/a.md', enc('changed')]]) };
  const write = session.ops(REQUEST);
  const reload = session.reload();
  let idle = false;
  const waiting = session.idle().then(() => (idle = true));
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(c.log, ['call ops 2026-10-29'], 'the re-read has not started: it would replace the VM under the write');
  assert.equal(idle, false);
  release();
  await write;
  await reload;
  await waiting;
  assert.deepEqual(c.log, ['call ops 2026-10-29', 'pending', 'accept', 'mount 2'], 'the re-read came last, and read the written state');
  assert.equal(disk.read('A/a.md'), 'changed');
  assert.equal(idle, true);
});

test('idle is immediate when nothing runs, and a failed step does not block the queue', async () => {
  const { c, session } = await open();
  await session.idle();
  c.failMount = true;
  await assert.rejects(session.reload(), /mount failed/);
  c.failMount = false;
  await session.idle();
  await session.reload();
  assert.equal(session.isStale, false);
});

test('a conflict found while writing replaces the VM by the folder, and nothing is written', async () => {
  const { disk, c, session, signatures } = await open();
  c.pending = { changes: { ...NONE, modified: ['A/a.md'] }, files: new Map([['A/a.md', enc('mine')]]) };
  disk.write('A/a.md', 'theirs');
  const outcome = await session.ops(REQUEST);
  assert.equal(outcome.kind, 'conflict');
  assert.equal(disk.read('A/a.md'), 'theirs');
  assert.deepEqual(c.log, ['call ops 2026-10-29', 'pending', 'mount 2'], 'no accept, a re-read instead');
  assert.deepEqual(signatures, [await session.signature()], 'the watcher is told what the folder looks like now: it was just read');
  // and the next write is judged on what was read then
  c.log.length = 0;
  c.pending = { changes: { ...NONE, modified: ['A/a.md'] }, files: new Map([['A/a.md', enc('mine on theirs')]]) };
  assert.equal((await session.ops(REQUEST)).kind, 'done');
  assert.equal(disk.read('A/a.md'), 'mine on theirs');
});

test('when the re-read after a conflict fails too, the session says so and is stale until a read works', async () => {
  const { disk, c, session } = await open();
  c.pending = { changes: { ...NONE, modified: ['A/a.md'] }, files: new Map([['A/a.md', enc('mine')]]) };
  disk.write('A/a.md', 'theirs');
  c.failMount = true;
  const outcome = await session.ops(REQUEST);
  assert.equal(outcome.kind, 'conflict');
  assert.match(outcome.message, /could not be read again/);
  assert.equal(session.isStale, true);

  // the next write reads first: a read that fails fails the write, and nothing is written
  const failing = await session.ops(REQUEST);
  assert.equal(failing.kind, 'failed');
  assert.equal(failing.code, 'io');
  assert.equal(disk.read('A/a.md'), 'theirs');

  c.failMount = false;
  c.log.length = 0;
  const healed = await session.ops(REQUEST);
  assert.equal(healed.kind, 'done');
  assert.equal(c.log[0], 'mount 2', 'it read the folder before it asked the engine');
  assert.equal(session.isStale, false);
});

test('a refusal of the whole request keeps the VM when nothing changed, and replaces it when something did', async () => {
  const { c, session } = await open();
  c.answer = { text: JSON.stringify({ kind: 'tasks.error', code: 'invalid_argument', message: 'no' }), code: 'invalid_argument' };
  const clean = await session.ops(REQUEST);
  assert.equal(clean.kind, 'refused');
  assert.deepEqual(c.log, ['call ops 2026-10-29', 'pending']);

  c.log.length = 0;
  c.pending = { changes: { ...NONE, added: ['A/new.md'] }, files: new Map([['A/new.md', enc('half')]]) };
  const dirty = await session.ops(REQUEST);
  assert.equal(dirty.kind, 'refused');
  assert.deepEqual(c.log, ['call ops 2026-10-29', 'pending', 'mount 2'], 'whatever the engine did before it refused is not the folder');
});

test('a dry run that changed the VM is an error: nothing is written and the VM is replaced', async () => {
  const { disk, c, session } = await open();
  const before = disk.snapshot();
  c.pending = { changes: { ...NONE, added: ['A/new.md'] }, files: new Map([['A/new.md', enc('x')]]) };
  const outcome = await session.ops(JSON.stringify({ dry_run: true, ops: [{ op: 'new', area: 'A', title: 'T' }] }));
  assert.equal(outcome.kind, 'failed');
  assert.equal(disk.snapshot(), before);
  assert.equal(c.log.at(-1), 'mount 2');
});

test('an engine call that throws replaces the VM by the folder and fails the write', async () => {
  const { c, session } = await open();
  c.failCall = true;
  const outcome = await session.ops(REQUEST);
  assert.equal(outcome.kind, 'failed');
  assert.equal(c.log.at(-1), 'mount 2');
});

test('a VM that cannot be told about a successful write is replaced by the folder; the write stands', async () => {
  const { disk, c, session } = await open();
  c.pending = { changes: { ...NONE, modified: ['A/a.md'] }, files: new Map([['A/a.md', enc('changed')]]) };
  c.failAccept = true;
  const outcome = await session.ops(REQUEST);
  assert.equal(outcome.kind, 'done');
  assert.equal(disk.read('A/a.md'), 'changed');
  assert.equal(c.log.at(-1), 'mount 2');
});

test('a failure in the middle of the write is told by what could be undone, and the VM is replaced', async () => {
  const { disk, c, session } = await open();
  c.pending = { changes: { ...NONE, modified: ['A/a.md', 'A/b.md'] }, files: new Map([['A/a.md', enc('a2')], ['A/b.md', enc('b2')]]) };
  disk.failOn = (op, path) => op === 'close' && path === 'A/b.md';
  const undone = await session.ops(REQUEST);
  assert.equal(undone.kind, 'failed');
  assert.equal(undone.code, 'io');
  assert.equal(disk.read('A/a.md'), 'task a');

  // taking back fails too
  c.pending = { changes: { ...NONE, modified: ['A/a.md', 'A/b.md'] }, files: new Map([['A/a.md', enc('a2')], ['A/b.md', enc('b2')]]) };
  disk.failOn = (op, path) => (op === 'close' && path === 'A/b.md') || (op === 'close' && path === 'A/a.md' && disk.read('A/a.md') === 'a2');
  const stuck = await session.ops(REQUEST);
  assert.equal(stuck.kind, 'failed');
  assert.equal(stuck.code, 'rollback_incomplete');
  assert.equal(c.log.at(-1), 'mount 2');
});

test('a change this page does not write (a path outside what it reads) is forbidden and replaces the VM', async () => {
  const { disk, c, session } = await open();
  const before = disk.snapshot();
  c.pending = { changes: { ...NONE, added: ['.git/hooks/pre-commit.md'] }, files: new Map([['.git/hooks/pre-commit.md', enc('x')]]) };
  const outcome = await session.ops(REQUEST);
  assert.equal(outcome.kind, 'failed');
  assert.equal(outcome.code, 'forbidden');
  assert.equal(disk.snapshot(), before);
  assert.equal(c.log.at(-1), 'mount 2');
});

test('a foreign change to a file the write did not touch is still news for the watcher afterwards', async () => {
  const { disk, c, session, signatures } = await open();
  const { watcher, seen } = watching(session);
  assert.equal(await watcher.check(), false, 'nothing changed yet');
  // an editor saves b; the watcher has not looked; then the page writes a
  disk.write('A/b.md', 'task b, edited elsewhere');
  c.pending = { changes: { ...NONE, modified: ['A/a.md'] }, files: new Map([['A/a.md', enc('task a, changed')]]) };
  assert.equal((await session.ops(REQUEST)).kind, 'done');
  watcher.accept(signatures.at(-1));
  assert.equal(await watcher.check(), true, 'the page shows an old b: it reads the folder again');
  assert.equal(seen.told, 1);
  assert.equal(disk.read('A/b.md'), 'task b, edited elsewhere', 'the foreign text was not touched');
});

test('what the watcher is told after a write is the folder with the written files as the page wrote them', async () => {
  const { disk, c, session, signatures } = await open();
  c.pending = { changes: { ...NONE, added: ['A/new.md'], modified: ['A/a.md'], removed: ['A/b.md'] }, files: new Map([['A/new.md', enc('n')], ['A/a.md', enc('a2')]]) };
  assert.equal((await session.ops(REQUEST)).kind, 'done');
  assert.equal(signatures.length, 1);
  assert.equal(signatures[0], await session.signature(), 'a folder nobody else touched: the same as a look now');
  assert.equal(signatures[0], session.knownSignature());
  assert.deepEqual(Object.keys(disk.files()).sort(), ['A/a.md', 'A/new.md']);
});

test('a change that lands while the folder is first read is news for the watcher', async () => {
  const disk = fakeDisk({ 'A/a.md': 'task a', 'A/b.md': 'task b' });
  const c = client();
  // the folder is read, and just before the engine gets it an editor saves b
  c.mount = async (root, files) => {
    disk.write('A/b.md', 'task b, edited while reading');
    return files.size;
  };
  const session = new VaultSession({ client: c, handle: disk.root, root: '/vault', today: () => '2026-10-29' });
  await session.load();
  const { watcher, seen } = watching(session);
  assert.equal(await watcher.check(), true);
  assert.equal(seen.told, 1);
});

test('a change that lands while the folder is read again after a conflict is news for the watcher', async () => {
  const { disk, c, session } = await open();
  const { watcher, seen } = watching(session);
  c.pending = { changes: { ...NONE, modified: ['A/a.md'] }, files: new Map([['A/a.md', enc('mine')]]) };
  disk.write('A/a.md', 'theirs');
  // the re-read after the conflict: an editor saves b meanwhile
  c.mount = async (root, files) => {
    disk.write('A/b.md', 'task b, edited while reading');
    return files.size;
  };
  const outcome = await session.ops(REQUEST);
  assert.equal(outcome.kind, 'conflict');
  watcher.accept(session.knownSignature());
  assert.equal(await watcher.check(), true, 'the b of the page is older than the b on the disk');
  assert.equal(seen.told, 1);
});

test('the signature handed over after a re-read is the one taken before it', async () => {
  const { disk, c, session, signatures } = await open();
  c.pending = { changes: { ...NONE, modified: ['A/a.md'] }, files: new Map([['A/a.md', enc('mine')]]) };
  disk.write('A/a.md', 'theirs');
  c.mount = async (root, files) => {
    disk.write('A/b.md', 'task b, edited while reading');
    return files.size;
  };
  await session.ops(REQUEST);
  assert.equal(signatures.length, 1);
  assert.notEqual(signatures[0], await session.signature(), 'not the folder as it is after the read');
});

test('when the list of changes cannot be read after the engine changed the VM, the VM is replaced by the folder', async () => {
  const { disk, c, session } = await open();
  const before = disk.snapshot();
  c.pendingFiles = async () => {
    c.log.push('pending');
    throw new Error('worker gone');
  };
  const outcome = await session.ops(REQUEST);
  assert.equal(outcome.kind, 'failed');
  assert.equal(outcome.code, 'io');
  assert.deepEqual(c.log, ['call ops 2026-10-29', 'pending', 'mount 2'], 'whatever the engine changed in the VM is not in the folder');
  assert.equal(disk.snapshot(), before);
});

test('a file the reader skipped stops writes: nothing is asked of the engine, nothing is written, and it can be read once it is small', async () => {
  const { disk, c, session } = await open({ 'A/a.md': 'task a', 'A/big.md': 'x'.repeat(40) }, {}, { limits: { maxFileBytes: 20 } });
  assert.deepEqual(session.skippedFiles(), [{ path: 'A/big.md', reason: 'too-large' }]);
  const before = disk.snapshot();
  c.pending = { changes: { ...NONE, modified: ['A/a.md'] }, files: new Map([['A/a.md', enc('changed')]]) };
  const refused = await session.ops(REQUEST);
  assert.equal(refused.kind, 'failed');
  assert.equal(refused.code, 'forbidden');
  assert.match(refused.message, /A\/big\.md \(too-large\)/);
  assert.deepEqual(c.log, [], 'the engine was not asked');
  assert.equal(disk.snapshot(), before);

  // a dry run writes nothing and may be asked
  const wanted = c.pending;
  c.pending = { changes: NONE, files: new Map() };
  const dry = await session.ops(JSON.stringify({ dry_run: true, ops: [{ op: 'set', id: 'A/a', patch: { prio: 1 } }] }));
  assert.equal(dry.kind, 'done');
  assert.ok(c.log.includes('call ops 2026-10-29'));
  c.pending = wanted;

  // the file shrinks (an editor), the page reads the folder again, and writes are on
  disk.write('A/big.md', 'small');
  await session.reload();
  assert.deepEqual(session.skippedFiles(), []);
  assert.equal((await session.ops(REQUEST)).kind, 'done');
  assert.equal(disk.read('A/a.md'), 'changed');
});

test('a file the folder would not let the reader open also stops writes', async () => {
  const { disk, c, session } = await open();
  disk.failOn = (op, path) => op === 'getFile' && path === 'A/b.md';
  await session.reload();
  disk.failOn = null;
  assert.deepEqual(session.skippedFiles(), [{ path: 'A/b.md', reason: 'unreadable' }]);
  c.pending = { changes: { ...NONE, modified: ['A/a.md'] }, files: new Map([['A/a.md', enc('changed')]]) };
  const refused = await session.ops(REQUEST);
  assert.equal(refused.kind, 'failed');
  assert.equal(disk.read('A/a.md'), 'task a');
});

test('a foreign change found by the last look before a file is written is a conflict, and the VM is replaced', async () => {
  const { disk, c, session } = await open();
  c.pending = { changes: { ...NONE, added: ['A/0-new.md'], modified: ['A/a.md'] }, files: new Map([['A/0-new.md', enc('n')], ['A/a.md', enc('mine')]]) };
  // while the new file is made, an editor saves a
  disk.failOn = (op, path) => {
    if (op === 'create' && path === 'A/0-new.md') disk.write('A/a.md', 'theirs');
    return false;
  };
  const outcome = await session.ops(REQUEST);
  disk.failOn = null;
  assert.equal(outcome.kind, 'conflict');
  assert.equal(disk.read('A/a.md'), 'theirs');
  assert.equal(disk.read('A/0-new.md'), undefined);
  assert.equal(c.log.at(-1), 'mount 2');
});

test('a list of changes that is not consistent is an internal fault, not a place the person may not write', async () => {
  const { c, session } = await open();
  c.pending = { changes: { ...NONE, modified: ['A/never-read.md'] }, files: new Map([['A/never-read.md', enc('x')]]) };
  const outcome = await session.ops(REQUEST);
  assert.equal(outcome.kind, 'failed');
  assert.equal(outcome.code, 'internal');
  assert.equal(c.log.at(-1), 'mount 2');
});

test('the session says it is writing from the request until the answer, also when the write fails', async () => {
  const { c, session } = await open();
  assert.equal(session.isWriting, false);
  const releases = [];
  c.call = (method, request, opts) =>
    new Promise((resolve, reject) => {
      releases.push(() => reject(new Error('engine gone')));
    });
  const first = session.ops(REQUEST);
  const second = session.ops(REQUEST);
  assert.equal(session.isWriting, true, 'also while the request waits for its turn');
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(releases.length, 1, 'the second request has not reached the engine');
  releases[0]();
  await first;
  assert.equal(session.isWriting, true, 'the second request is still there');
  await new Promise((resolve) => setTimeout(resolve, 10));
  releases[1]();
  await second;
  assert.equal(session.isWriting, false);
  // a read alone is no write
  const reading = session.reload();
  assert.equal(session.isWriting, false);
  await reading;
});

test('closing the page is asked about while a write is under way and not otherwise', () => {
  const listeners = [];
  guardUnload({ addEventListener: (type, listener) => listeners.push([type, listener]) }, (() => {
    let calls = 0;
    return () => ++calls % 2 === 0;
  })());
  assert.deepEqual(listeners.map(([type]) => type), ['beforeunload']);
  const event = () => ({ prevented: 0, returnValue: undefined, preventDefault() { this.prevented++; } });
  const idle = event();
  listeners[0][1](idle);
  assert.equal(idle.prevented, 0, 'idle: the page closes without a question');
  assert.equal(idle.returnValue, undefined);
  const writing = event();
  listeners[0][1](writing);
  assert.equal(writing.prevented, 1, 'writing: the browser asks');
  assert.equal(writing.returnValue, '');
});

// -- the data classes ------------------------------------------------------------------------------------------------

const CLASSES = (a, b) => JSON.stringify({ schema: 1, areas: { A: { class: a }, B: { class: b } } });

test('the classes are those of the areas.json in the folder, read with it', async () => {
  const classes = [];
  const disk = fakeDisk({ 'A/a.md': 'x', 'areas.json': CLASSES('public', 'private') });
  const session = new VaultSession({ client: client(), handle: disk.root, root: '/vault', today: () => '2026-10-29', onClasses: (c) => classes.push(c.signature) });
  assert.equal(session.classOf('A'), 'unclassified', 'before the first read nothing is released');
  assert.equal(session.classesProblem, null);
  await session.load();
  assert.equal(session.classOf('A'), 'public');
  assert.equal(session.classOf('B'), 'private');
  assert.equal(session.classOf('C'), 'unclassified', 'an area the file does not name');
  assert.equal(classes.length, 1, 'the page is told once, when the decisions come');
});

test('a folder without areas.json classifies nothing and tells nothing', async () => {
  const classes = [];
  const { session } = await open({ 'A/a.md': 'x' }, {}, { onClasses: (c) => classes.push(c) });
  assert.equal(session.classOf('A'), 'unclassified');
  assert.equal(session.classesProblem, null);
  assert.deepEqual(classes, [], 'no file was no classes before either');
});

test('a re-read takes the changed classes over and tells the page; an unchanged file tells nothing', async () => {
  const told = [];
  const { disk, session } = await open({ 'A/a.md': 'x', 'areas.json': CLASSES('public', 'public') }, {}, { onClasses: (c) => told.push(c.shown('B')) });
  assert.equal(session.classOf('B'), 'public');
  told.length = 0; // the first read told the page what the folder says
  await session.reload();
  assert.deepEqual(told, [], 'the same decisions: nothing to tell');
  // The same decisions written another way are the same decisions.
  disk.write('areas.json', ` ${CLASSES('public', 'public')}\n`);
  await session.reload();
  assert.deepEqual(told, []);
  disk.write('areas.json', CLASSES('public', 'private'));
  await session.reload();
  assert.equal(session.classOf('B'), 'private');
  assert.deepEqual(told, ['private']);
});

test('a file that is not valid releases nothing, says why, and is told when it is mended', async () => {
  const told = [];
  const { disk, session } = await open({ 'A/a.md': 'x', 'areas.json': CLASSES('public', 'public') }, {}, { onClasses: (c) => told.push(c.problem) });
  told.length = 0;
  disk.write('areas.json', '{"schema":1,"areas":{"A":{"class":"public","class":"private"}}}');
  await session.reload();
  assert.equal(session.classOf('A'), 'unclassified', 'the second class is not the file\'s last word: the file is refused');
  assert.match(session.classesProblem, /duplicate field class/);
  assert.equal(told.length, 1);
  assert.equal(typeof told[0], 'string');
  disk.write('areas.json', CLASSES('internal', 'public'));
  await session.reload();
  assert.equal(session.classOf('A'), 'internal');
  assert.equal(session.classesProblem, null);
  assert.equal(told.length, 2);
});

test('an areas.json the reader had to leave out (too large) releases nothing', async () => {
  const { session } = await open({ 'A/a.md': 'x', 'areas.json': CLASSES('public', 'public') }, {}, { limits: { maxFileBytes: 20 } });
  assert.equal(session.classOf('A'), 'unclassified');
  assert.match(session.classesProblem, /too-large/);
});

test('a read that fails leaves the page with no classes, and the next read that works brings them back', async () => {
  const told = [];
  const { disk, c, session } = await open({ 'A/a.md': 'x', 'areas.json': CLASSES('public', 'public') }, {}, { onClasses: (x) => told.push(x.problem ?? x.size) });
  assert.equal(session.classOf('A'), 'public');
  told.length = 0;
  c.failMount = true;
  disk.write('areas.json', CLASSES('private', 'private'));
  await assert.rejects(session.reload(), /mount failed/);
  assert.equal(session.classOf('A'), 'unclassified', 'what could not be read releases nothing, not even what it said before');
  assert.equal(told.length, 1);
  c.failMount = false;
  await session.reload();
  assert.equal(session.classOf('A'), 'private');
  assert.equal(told.length, 2);
});

test('a conflict that makes the session read the folder again brings the new classes with it', async () => {
  const told = [];
  const { disk, c, session } = await open({ 'A/a.md': 'task a', 'areas.json': CLASSES('public', 'public') }, {}, { onClasses: () => told.push('classes') });
  assert.equal(session.classOf('A'), 'public');
  told.length = 0;
  c.pending = { changes: { ...NONE, modified: ['A/a.md'] }, files: new Map([['A/a.md', enc('mine')]]) };
  // Someone changed the task and the classes while the engine worked.
  disk.write('A/a.md', 'theirs');
  disk.write('areas.json', CLASSES('private', 'public'));
  const outcome = await session.ops(REQUEST);
  assert.equal(outcome.kind, 'conflict');
  assert.equal(session.classOf('A'), 'private', 'the page does not go on with the classes of before');
  assert.deepEqual(told, ['classes']);
});

test('a page that fails in its reaction to new classes does not undo the read', async () => {
  const { disk, session } = await open({ 'A/a.md': 'x', 'areas.json': CLASSES('public', 'public') }, {}, {
    onClasses: () => {
      throw new Error('the page broke');
    },
  });
  disk.write('areas.json', CLASSES('private', 'public'));
  await session.reload();
  assert.equal(session.isStale, false);
  assert.equal(session.classOf('A'), 'private');
});

test('a session of a folder read through an input never asks the engine and never touches the folder', async () => {
  const { c, session, disk } = await open(undefined, {}, { readOnly: true });
  const outcome = await session.ops(REQUEST);
  assert.equal(outcome.kind, 'failed');
  assert.equal(outcome.code, 'forbidden');
  assert.match(outcome.message, /reading only/);
  assert.deepEqual(c.log, [], 'the engine was not called');
  assert.deepEqual(disk.files(), { 'A/a.md': 'task a', 'A/b.md': 'task b' });
});
