// Writing in the web variant, end to end without a browser: the real engine in the worker, the page's client, hub and
// vault session, and a fake picked folder that the writes land in (web/fake-folder.mjs). What is checked is the state of
// the fake disk, because that is what the person's git sees.
//
//   node --experimental-strip-types --test web/ops.test.mjs        (from ui/; needs wasmoon and the engine checkouts)

import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { test as base } from 'node:test';
import { fileURLToPath } from 'node:url';
import { LuaFactory } from 'wasmoon';
import { createBrowserHub, WorkerClient } from '../src/web/client.ts';
import { VaultSession } from '../src/web/vault-session.ts';
import { vaultSignature } from '../src/web/vault-files.ts';
import { watchFolder } from 'appkit-web/watch';
import { startWorker } from '../src/web/worker.ts';
import { bundle, readLock } from './engine-bundle.mjs';
import { fakeDisk } from './fake-folder.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const fixture = resolve(here, '..', '..', 'e2e', 'fixture', 'vault');
const SHIM = readFileSync(resolve(here, '..', 'src', 'web', 'vim-shim.lua'), 'utf8');
const ROOT = '/vault';
const TODAY = '2026-10-29';

const test = (name, fn) => base(name, { timeout: 60_000 }, fn);

/** The fixture vault as { path: text }. */
function fixtureTree() {
  const tree = {};
  const walk = (d) => {
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      if (statSync(p).isDirectory()) walk(p);
      else tree[relative(fixture, p).replaceAll('\\', '/')] = readFileSync(p, 'utf8');
    }
  };
  walk(fixture);
  return tree;
}

function pair() {
  const port = { onmessage: null, postMessage: (m) => queueMicrotask(() => scope.onmessage({ data: structuredClone(m) })) };
  const scope = {
    fetch: async () => new Response(''),
    onmessage: null,
    postMessage: (m) => queueMicrotask(() => port.onmessage?.({ data: structuredClone(m) })),
  };
  startWorker(scope, { factory: () => new LuaFactory() });
  return port;
}

let started;
/** One started engine for all tests (a VM starts in about a second); every test mounts its own vault over it. */
function engine() {
  started ??= (async () => {
    const client = new WorkerClient(pair());
    await client.init({ wasm: new ArrayBuffer(0), bundle: bundle(), shim: SHIM });
    return client;
  })();
  return started;
}

/** A fresh disk with the vault (plus `extra`), a session over it, and the hub of the page on top. */
async function page(extra = {}, options = {}) {
  const client = await engine();
  const disk = fakeDisk({ ...fixtureTree(), ...extra }, options);
  const signatures = [];
  const session = new VaultSession({ client, handle: disk.root, root: ROOT, today: () => TODAY, onSignature: (s) => signatures.push(s) });
  await session.load();
  const lock = readLock();
  const hub = createBrowserHub(client, {
    root: ROOT,
    version: '0.0.0-test',
    build: null,
    pinned: { engine: lock.commit, lib: lock.lib_commit },
    ops: (request) => session.ops(request),
    idle: () => session.idle(),
  });
  const send = async (request) => {
    const response = await hub.fetch('/api/tasks/ops', { method: 'POST', body: JSON.stringify(request) });
    return { status: response.status, body: await response.json() };
  };
  const get = async (path) => (await hub.fetch(`/api/tasks/${path}`)).json();
  return { client, disk, session, hub, send, get, signatures };
}

const ops = (...list) => ({ client_op_id: 'test', ops: list });
const changedPaths = (before, after) =>
  [...new Set([...Object.keys(before), ...Object.keys(after)])].filter((p) => before[p] !== after[p]).sort();

test('a new task is written to the folder, with the generated index, and shows in the list and the search', async () => {
  const p = await page();
  const before = p.disk.files();
  const stream = await p.hub.fetch('/api/tasks/events');
  const reader = stream.body.getReader();
  await reader.read(); // hello
  assert.equal((await p.get('search?q=zebrafish')).total, 0, 'the texts are read once, before the write');

  const { status, body } = await p.send(ops({ op: 'new', area: 'lib.nvim', title: 'Written by the web', body: 'A distinctive zebrafish text.' }));
  assert.equal(status, 200, JSON.stringify(body));
  assert.equal(body.kind, 'tasks.result');
  assert.equal(body.ok, true);
  assert.equal(body.results[0].id, 'lib.nvim/written-by-the-web');
  assert.deepEqual(changedPaths(before, p.disk.files()), ['lib.nvim/ROADMAP/TASKS.md', 'lib.nvim/ROADMAP/tasks/written-by-the-web.md']);
  const text = p.disk.read('lib.nvim/ROADMAP/tasks/written-by-the-web.md');
  assert.match(text, /^---\ntitle: Written by the web\n/);
  assert.match(text, /created: 2026-10-29\n/);
  assert.match(p.disk.read('lib.nvim/ROADMAP/TASKS.md'), /written-by-the-web/);

  const snapshot = await p.get('snapshot');
  assert.ok(snapshot.tasks.some((t) => t.id === 'lib.nvim/written-by-the-web'), 'the list shows it at once');
  const found = await p.get('search?q=zebrafish');
  assert.ok(found.hits.some((h) => h.id === 'lib.nvim/written-by-the-web'), 'the texts of the search were dropped');
  const event = new TextDecoder().decode((await reader.read()).value);
  assert.match(event, /event: resync/, 'the open streams hear of the change');
  await reader.cancel();
});

test('a field is set: one task file changes, nothing else but the index', async () => {
  const p = await page();
  const before = p.disk.files();
  const { status, body } = await p.send(ops({ op: 'set', id: 'lib.nvim/alpha', patch: { prio: 3 } }));
  assert.equal(status, 200, JSON.stringify(body));
  assert.equal(body.ok, true, JSON.stringify(body));
  assert.deepEqual(changedPaths(before, p.disk.files()), ['lib.nvim/ROADMAP/TASKS.md', 'lib.nvim/ROADMAP/tasks/alpha.md']);
  assert.match(p.disk.read('lib.nvim/ROADMAP/tasks/alpha.md'), /\nprio: 3\n/);
  assert.match(p.disk.read('lib.nvim/ROADMAP/tasks/alpha.md'), /updated: 2026-10-29\n/);
  const task = await p.get('task?id=lib.nvim/alpha');
  assert.equal(task.task.prio, 3);
});

test('a task is finished: its file moves to the Backlog, the Backlog index is updated, the old file is gone', async () => {
  const p = await page();
  const before = p.disk.files();
  const preview = await p.get('done_preview?id=lib.nvim/alpha');
  const { status, body } = await p.send(ops({ op: 'done', id: 'lib.nvim/alpha', confirm: preview.confirm }));
  assert.equal(status, 200, JSON.stringify(body));
  assert.equal(body.ok, true, JSON.stringify(body));
  assert.equal(body.results[0].to, 'lib.nvim/Backlog/FEATURES/2026-10-29_alpha.md');
  assert.deepEqual(changedPaths(before, p.disk.files()), [
    'lib.nvim/Backlog/FEATURES/2026-10-29_alpha.md',
    'lib.nvim/Backlog/README.md',
    'lib.nvim/ROADMAP/TASKS.md',
    'lib.nvim/ROADMAP/tasks/alpha.md',
  ]);
  assert.equal(p.disk.read('lib.nvim/ROADMAP/tasks/alpha.md'), undefined);
  assert.match(p.disk.read('lib.nvim/Backlog/FEATURES/2026-10-29_alpha.md'), /\nstatus: done\n/);
  assert.match(p.disk.read('lib.nvim/Backlog/README.md'), /2026-10-29_alpha\.md/);
  const snapshot = await p.get('snapshot');
  assert.equal(snapshot.tasks.find((t) => t.id === 'lib.nvim/alpha'), undefined, 'no longer an open task');
});

test('a task moves to another area', async () => {
  const p = await page();
  const { status, body } = await p.send(ops({ op: 'move_area', id: 'lib.nvim/gamma', to_area: 'nvim-config' }));
  assert.equal(status, 200, JSON.stringify(body));
  assert.equal(body.results[0].new_id, 'nvim-config/gamma');
  assert.equal(p.disk.read('lib.nvim/ROADMAP/tasks/gamma.md'), undefined);
  assert.match(p.disk.read('nvim-config/ROADMAP/tasks/gamma.md'), /title:/);
});

test('a folder task is finished: the folder moves into the Backlog and the old one is gone from the disk', async () => {
  const body = '---\ntitle: Folder task\nstatus: open\nkind: feature\ncreated: 2026-01-01\nupdated: 2026-01-01\n---\n\nBody\n';
  const p = await page({ 'lib.nvim/ROADMAP/tasks/fold/fold.md': body, 'lib.nvim/ROADMAP/tasks/fold/notes/more.md': 'more notes\n' });
  const preview = await p.get('done_preview?id=lib.nvim/fold');
  const done = await p.send(ops({ op: 'done', id: 'lib.nvim/fold', confirm: preview.confirm }));
  assert.equal(done.status, 200, JSON.stringify(done.body));
  assert.equal(done.body.ok, true, JSON.stringify(done.body));
  const files = p.disk.files();
  assert.ok(files['lib.nvim/Backlog/FEATURES/2026-10-29_fold/2026-10-29_fold.md'], Object.keys(files).join(', '));
  assert.equal(files['lib.nvim/Backlog/FEATURES/2026-10-29_fold/notes/more.md'], 'more notes\n');
  assert.equal(files['lib.nvim/ROADMAP/tasks/fold/fold.md'], undefined);
  assert.deepEqual(p.disk.folders().filter((f) => f.startsWith('lib.nvim/ROADMAP/tasks/fold')), [], 'the emptied folder is gone');
});

test('a folder task with an asset is not moved by halves: refused, nothing written, the page reads the disk again', async () => {
  const body = '---\ntitle: Folder task\nstatus: open\nkind: feature\ncreated: 2026-01-01\nupdated: 2026-01-01\n---\n\n![shot](assets/shot.png)\n';
  const p = await page({ 'lib.nvim/ROADMAP/tasks/fold/fold.md': body, 'lib.nvim/ROADMAP/tasks/fold/assets/shot.png': 'PNG' });
  const before = p.disk.snapshot();
  const preview = await p.get('done_preview?id=lib.nvim/fold');
  const done = await p.send(ops({ op: 'done', id: 'lib.nvim/fold', confirm: preview.confirm }));
  assert.equal(done.status, 403, JSON.stringify(done.body));
  assert.equal(done.body.error.code, 'forbidden');
  assert.match(done.body.error.message, /assets\/shot\.png/);
  assert.equal(p.disk.snapshot(), before, 'nothing was written');
  const snapshot = await p.get('snapshot');
  const task = snapshot.tasks.find((t) => t.id === 'lib.nvim/fold');
  assert.equal(task?.status, 'open', 'the page shows the disk again: the task is still open');
});

test('a file changed on disk since it was read is a conflict: 409, nothing written, the page shows the disk, a retry works', async () => {
  const p = await page();
  const original = p.disk.read('lib.nvim/ROADMAP/tasks/alpha.md');
  const foreign = original.replace('status: open', 'status: doing');
  p.disk.write('lib.nvim/ROADMAP/tasks/alpha.md', foreign);
  const before = p.disk.snapshot();
  const logged = p.disk.log.length;

  const { status, body } = await p.send(ops({ op: 'set', id: 'lib.nvim/alpha', patch: { prio: 3 } }));
  assert.equal(status, 409, JSON.stringify(body));
  assert.equal(body.error.code, 'conflict');
  assert.match(body.error.message, /lib\.nvim\/ROADMAP\/tasks\/alpha\.md/);
  assert.equal(p.disk.snapshot(), before, 'the editor\'s version is on disk, untouched');
  assert.deepEqual(p.disk.log.slice(logged).filter((e) => /^(make|create|write|close|remove|move) /.test(e)), []);

  const snapshot = await p.get('snapshot');
  assert.equal(snapshot.tasks.find((t) => t.id === 'lib.nvim/alpha').status, 'doing', 'the list shows what is on disk');

  const retry = await p.send(ops({ op: 'set', id: 'lib.nvim/alpha', patch: { prio: 3 } }));
  assert.equal(retry.status, 200, JSON.stringify(retry.body));
  const text = p.disk.read('lib.nvim/ROADMAP/tasks/alpha.md');
  assert.match(text, /status: doing/, 'the foreign edit is kept');
  assert.match(text, /prio: 3/, 'and the change is on top of it');
});

test('a request of several changes writes all of them or none', async () => {
  const p = await page();
  p.disk.write('lib.nvim/ROADMAP/tasks/beta.md', p.disk.read('lib.nvim/ROADMAP/tasks/beta.md').replace('status: open', 'status: doing'));
  const before = p.disk.snapshot();
  const { status } = await p.send(
    ops({ op: 'set', id: 'lib.nvim/alpha', patch: { prio: 3 } }, { op: 'set', id: 'lib.nvim/beta', patch: { prio: 3 } }),
  );
  assert.equal(status, 409);
  assert.equal(p.disk.snapshot(), before, 'alpha was not written either');
});

test('a file removed from the disk, and a new file that appeared there, are conflicts too', async () => {
  const p = await page();
  p.disk.remove('lib.nvim/ROADMAP/tasks/alpha.md');
  const gone = await p.send(ops({ op: 'set', id: 'lib.nvim/alpha', patch: { prio: 3 } }));
  assert.equal(gone.status, 409, JSON.stringify(gone.body));
  assert.match(gone.body.error.message, /removed/);
  assert.equal((await p.get('snapshot')).tasks.find((t) => t.id === 'lib.nvim/alpha'), undefined, 'the list follows the disk');

  const q = await page();
  // the engine would make this file; someone made it on the disk first
  q.disk.write('lib.nvim/ROADMAP/tasks/written-by-the-web.md', 'a file of someone else');
  const before = q.disk.snapshot();
  const clash = await q.send(ops({ op: 'new', area: 'lib.nvim', title: 'Written by the web', body: 'A distinctive zebrafish text.' }));
  assert.equal(clash.status, 409, JSON.stringify(clash.body));
  assert.match(clash.body.error.message, /exists/);
  assert.equal(q.disk.snapshot(), before);
});

test('a dry run asks the engine and writes nothing', async () => {
  const p = await page();
  const before = p.disk.snapshot();
  const logged = p.disk.log.length;
  const { status, body } = await p.send({ client_op_id: 'dry', dry_run: true, ops: [{ op: 'new', area: 'lib.nvim', title: 'Only a question' }] });
  assert.equal(status, 200, JSON.stringify(body));
  assert.equal(body.dry_run, true);
  assert.equal(body.results[0].outcome, 'would_create');
  assert.equal(p.disk.snapshot(), before);
  assert.deepEqual(p.disk.log.slice(logged).filter((e) => /^(make|create|write|close|remove|move) /.test(e)), []);
  assert.equal((await p.get('snapshot')).tasks.some((t) => t.title === 'Only a question'), false);
});

test('the engine refusing a change (a wrong id, a stale if_match) is its answer, and the disk is not touched', async () => {
  const p = await page();
  const before = p.disk.snapshot();
  const missing = await p.send(ops({ op: 'set', id: 'lib.nvim/no-such-task', patch: { prio: 2 } }));
  assert.equal(missing.status, 200);
  assert.equal(missing.body.ok, false);
  assert.equal(missing.body.results[0].error.code, 'not_found');

  const first = await p.send(ops({ op: 'set', id: 'lib.nvim/alpha', patch: { prio: 3 } }));
  const stale = first.body.results[0].etag_before;
  assert.ok(stale);
  const afterFirst = p.disk.snapshot();
  const second = await p.send(ops({ op: 'set', id: 'lib.nvim/alpha', patch: { prio: 2 }, if_match: stale }));
  assert.equal(second.status, 200);
  assert.equal(second.body.results[0].error.code, 'conflict', 'the engine\'s own if_match conflict');
  assert.equal(p.disk.snapshot(), afterFirst, 'and it wrote nothing');
  assert.notEqual(before, afterFirst);

  const whole = await p.send({ client_op_id: 'x', ops: [{ op: 'set', id: 'lib.nvim/alpha', patch: {} }], schema: 99 });
  assert.equal(whole.status, 400, 'a request the engine refuses as a whole');
  assert.equal(whole.body.error.code, 'unsupported_schema');
  assert.equal(p.disk.snapshot(), afterFirst);
});

test('a write that fails in the middle is taken back, the failure is told, and the page reads the disk again', async () => {
  const p = await page();
  const before = p.disk.snapshot();
  // the task file is written, then the index: its write fails
  p.disk.failOn = (op, path) => op === 'close' && path === 'lib.nvim/ROADMAP/TASKS.md';
  const { status, body } = await p.send(ops({ op: 'new', area: 'lib.nvim', title: 'Half written' }));
  p.disk.failOn = null;
  assert.equal(status, 502, JSON.stringify(body));
  assert.equal(body.error.code, 'io');
  assert.equal(p.disk.snapshot(), before, 'the new file was taken back');
  assert.equal((await p.get('snapshot')).tasks.some((t) => t.title === 'Half written'), false, 'and the page does not show it');
  // the session is whole again: the same request now works
  const again = await p.send(ops({ op: 'new', area: 'lib.nvim', title: 'Half written' }));
  assert.equal(again.status, 200, JSON.stringify(again.body));
  assert.ok(p.disk.read('lib.nvim/ROADMAP/tasks/half-written.md'));
});

test('what cannot be taken back is told as rollback_incomplete', async () => {
  const p = await page();
  // the index is written first (its name sorts first), then the new file fails; taking the index back fails as well
  p.disk.failOn = (op, path) => (op === 'close' && path.endsWith('half-written.md')) || (op === 'remove' && path.endsWith('TASKS.md'));
  const { status, body } = await p.send(ops({ op: 'new', area: 'lib.nvim', title: 'Half written' }));
  p.disk.failOn = null;
  assert.equal(status, 502, JSON.stringify(body));
  assert.equal(body.error.code, 'rollback_incomplete');
  assert.match(body.error.message, /TASKS\.md/, 'the file that stayed is named');
  assert.equal(p.disk.read('lib.nvim/ROADMAP/tasks/half-written.md'), undefined, 'the task file itself was taken back');
  assert.match(p.disk.read('lib.nvim/ROADMAP/TASKS.md'), /half-written/, 'the index stayed on the disk');
  // the page shows the disk as it is, not the state the engine wanted
  assert.equal((await p.get('snapshot')).tasks.some((t) => t.id === 'lib.nvim/half-written'), false);
});

test('after a write the watcher does not take the page\'s own files for a foreign change; a foreign one it does', async () => {
  const p = await page();
  let told = 0;
  const watcher = watchFolder(await p.session.signature(), {
    signature: () => vaultSignature(p.disk.root),
    onChange: () => void told++,
    setTimer: () => 0,
    clearTimer: () => {},
    onFocus: () => () => {},
  });
  const written = await p.send(ops({ op: 'set', id: 'lib.nvim/alpha', patch: { prio: 3 } }));
  assert.equal(written.status, 200);
  assert.equal(p.signatures.length, 1, 'the session hands the signature of the folder after its write over');
  assert.equal(p.signatures[0], await vaultSignature(p.disk.root));
  watcher.accept(p.signatures[0]);
  assert.equal(await watcher.check(), false, 'no change: the folder is as the page left it');
  p.disk.write('lib.nvim/ROADMAP/tasks/beta.md', 'edited elsewhere');
  assert.equal(await watcher.check(), true);
  assert.equal(told, 1);
  watcher.stop();
});

test('a foreign change to a file the write did not touch is still found by the watcher after the write', async () => {
  const p = await page();
  let told = 0;
  const watcher = watchFolder(p.session.knownSignature(), {
    signature: () => p.session.signature(),
    onChange: () => void told++,
    setTimer: () => 0,
    clearTimer: () => {},
    onFocus: () => () => {},
  });
  // an editor (or a git pull) changes beta; the watcher has not looked yet; then the page writes alpha
  const beta = 'lib.nvim/ROADMAP/tasks/beta.md';
  p.disk.write(beta, p.disk.read(beta).replace('status: open', 'status: doing'));
  const written = await p.send(ops({ op: 'set', id: 'lib.nvim/alpha', patch: { prio: 3 } }));
  assert.equal(written.status, 200, JSON.stringify(written.body));
  watcher.accept(p.signatures.at(-1));
  assert.equal(await watcher.check(), true, 'the page shows the old beta: the watcher must read the folder again');
  assert.equal(told, 1);
  watcher.stop();
});

test('a file saved by an editor between the check and its turn is a conflict too: 409, nothing stays written', async () => {
  const p = await page();
  const alpha = 'lib.nvim/ROADMAP/tasks/alpha.md';
  const foreign = p.disk.read(alpha).replace('status: open', 'status: doing');
  // the index is made first; while it is, an editor saves alpha, which the write still has to change
  p.disk.failOn = (op, path) => {
    if (op === 'create' && path === 'lib.nvim/ROADMAP/TASKS.md') p.disk.write(alpha, foreign);
    return false;
  };
  const { status, body } = await p.send(ops({ op: 'set', id: 'lib.nvim/alpha', patch: { prio: 3 } }));
  p.disk.failOn = null;
  assert.equal(status, 409, JSON.stringify(body));
  assert.equal(body.error.code, 'conflict');
  assert.equal(p.disk.read(alpha), foreign, "the editor's text survives");
  assert.equal(p.disk.read('lib.nvim/ROADMAP/TASKS.md'), undefined, 'what was written before was taken back');
  const retry = await p.send(ops({ op: 'set', id: 'lib.nvim/alpha', patch: { prio: 3 } }));
  assert.equal(retry.status, 200, JSON.stringify(retry.body));
  assert.match(p.disk.read(alpha), /status: doing/);
});

test('writes follow one another: the second sees the first, and the baseline is the disk after each', async () => {
  const p = await page();
  const results = [];
  for (const prio of [1, 2, 3]) {
    results.push(await p.send(ops({ op: 'set', id: 'lib.nvim/alpha', patch: { prio } })));
  }
  assert.deepEqual(results.map((r) => r.status), [200, 200, 200]);
  assert.match(p.disk.read('lib.nvim/ROADMAP/tasks/alpha.md'), /\nprio: 3\n/);
  const pending = await p.client.pendingFiles();
  assert.deepEqual(pending.changes, { added: [], modified: [], removed: [], removedDirs: [] }, 'the VM has nothing left to write');
});

test('requests sent together are written one after the other, none lost', async () => {
  const p = await page();
  const sent = await Promise.all([
    p.send(ops({ op: 'new', area: 'lib.nvim', title: 'Parallel one' })),
    p.send(ops({ op: 'new', area: 'lib.nvim', title: 'Parallel two' })),
    p.send(ops({ op: 'set', id: 'lib.nvim/alpha', patch: { prio: 3 } })),
  ]);
  assert.deepEqual(sent.map((r) => r.status), [200, 200, 200]);
  const files = p.disk.files();
  assert.ok(files['lib.nvim/ROADMAP/tasks/parallel-one.md']);
  assert.ok(files['lib.nvim/ROADMAP/tasks/parallel-two.md']);
  assert.match(files['lib.nvim/ROADMAP/TASKS.md'], /parallel-one/);
  assert.match(files['lib.nvim/ROADMAP/TASKS.md'], /parallel-two/, 'the index holds both');
});

test('a read while a write is under way waits for it and sees the finished state', async () => {
  const p = await page();
  const write = p.send(ops({ op: 'new', area: 'lib.nvim', title: 'Seen after' }));
  const read = p.get('snapshot');
  const [done, snapshot] = await Promise.all([write, read]);
  assert.equal(done.status, 200);
  assert.ok(snapshot.tasks.some((t) => t.id === 'lib.nvim/seen-after'), 'the read came after the write, not between its steps');
});

test('an attach and requests that are plainly not requests are refused before the engine or the folder is asked', async () => {
  const p = await page();
  const before = p.disk.snapshot();
  const logged = p.disk.log.length;
  assert.equal((await p.send(ops({ op: 'attach', id: 'lib.nvim/alpha', from: 'clipboard' }))).status, 400);
  assert.equal((await p.send({ ops: [] })).status, 400);
  assert.equal((await p.send({ ops: [{ op: 'no_such_op' }] })).status, 400);
  assert.equal((await p.send({ ops: [{ op: 'set', id: 'x/y', patch: {} }], extra: 1 })).status, 400);
  assert.equal(p.disk.snapshot(), before);
  assert.equal(p.disk.log.length, logged, 'the folder was not even looked at');
});
