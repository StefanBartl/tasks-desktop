// The port of the hub of the browser tests: a free one for each run, a given one kept, the default for a stray process.
// The results folder of a run: its own, the ones of ended runs removed, the last run kept for `--last-failed`.
//
//   node --experimental-strip-types --test web/e2e-port.test.mjs        (from ui/)

import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { createServer } from 'node:net';
import {
  DEFAULT_E2E_PORT,
  RESULTS,
  e2ePort,
  ensureE2ePort,
  lastRunFile,
  processAlive,
  pruneRuns,
  runOutputDir,
} from '../e2e/port.ts';
import { testDir } from './tmp.mjs';

test('the port is the default without TASKS_E2E_PORT and the given one with it', () => {
  assert.equal(e2ePort({}), DEFAULT_E2E_PORT);
  assert.equal(e2ePort({ TASKS_E2E_PORT: '' }), DEFAULT_E2E_PORT);
  assert.equal(e2ePort({ TASKS_E2E_PORT: '17699' }), 17699);
});

test('a port that is none is an error, not a silent default', () => {
  for (const bad of ['abc', '80', '70000', '17699 ', '-1', '1e4']) {
    assert.throws(() => e2ePort({ TASKS_E2E_PORT: bad }), /TASKS_E2E_PORT/, bad);
  }
});

test('a run without TASKS_E2E_PORT takes a free port and writes it for the workers; a given one is kept', async () => {
  const env = {};
  const port = await ensureE2ePort(env);
  assert.equal(env.TASKS_E2E_PORT, String(port));
  assert.ok(port >= 1024 && port <= 65535);
  // Free: it can be listened on.
  await new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => server.close(resolve));
  });
  // Two runs side by side take two ports.
  const other = {};
  const second = await ensureE2ePort(other);
  assert.equal(other.TASKS_E2E_PORT, String(second));
  const kept = { TASKS_E2E_PORT: '17699' };
  assert.equal(await ensureE2ePort(kept), 17699);
  assert.equal(kept.TASKS_E2E_PORT, '17699');
  await assert.rejects(() => ensureE2ePort({ TASKS_E2E_PORT: 'abc' }), /TASKS_E2E_PORT/);
});

/** A results root with the folders `names` in it, each with a file (a trace). */
function results(t, names) {
  const root = testDir(t, 'results');
  for (const name of names) {
    mkdirSync(join(root, name));
    writeFileSync(join(root, name, 'trace.zip'), 'x');
  }
  return root;
}

test('a run has a results folder of its own, the same for the runner and its workers', (t) => {
  const root = results(t, []);
  const none = () => false;
  const env = {};
  assert.equal(runOutputDir(env, 4242, root, none), 'test-results/run-4242');
  // A worker (another process) reads the name the runner set.
  assert.equal(runOutputDir(env, 9999, root, none), 'test-results/run-4242');
  assert.equal(runOutputDir({}, 9999, root, none), 'test-results/run-9999');
});

test('the runner removes the folders of runs that ended, not its own, not a running one, nothing else', (t) => {
  const root = results(t, ['run-11', 'run-22', 'run-33', 'run-x', 'other', '.last-run-hub.json']);
  const running = new Set([22]);
  runOutputDir({}, 33, root, (pid) => running.has(pid));
  assert.deepEqual(readdirSync(root).sort(), ['.last-run-hub.json', 'other', 'run-22', 'run-33', 'run-x']);
});

test('a worker removes nothing: the run was named before it', (t) => {
  const root = results(t, ['run-11']);
  runOutputDir({ TASKS_E2E_RUN: '33' }, 44, root, () => false);
  assert.ok(existsSync(join(root, 'run-11')));
});

test('a root that is not there, and a folder that cannot be removed, do not stop the run', (t) => {
  assert.deepEqual(pruneRuns(join(testDir(t, 'gone'), 'nothing'), 1, () => false), []);
  const root = results(t, ['run-11', 'run-12', 'run-13']);
  // run-12 has a file still open: removing it fails as rmSync does with EBUSY; it stays, and the others go.
  const removed = pruneRuns(
    root,
    1,
    () => false,
    (path) => {
      if (path.endsWith('run-12')) throw Object.assign(new Error('busy'), { code: 'EBUSY' });
      rmSync(path, { recursive: true, force: true });
    },
  );
  assert.deepEqual(removed.sort(), ['run-11', 'run-13']);
  assert.deepEqual(readdirSync(root), ['run-12']);
});

test('the check of a process: this one runs, one that ended does not', () => {
  assert.equal(processAlive(process.pid), true);
  // A pid far above what Windows and Linux hand out.
  assert.equal(processAlive(2 ** 30), false);
});

test('--last-failed reads one file per suite under test-results/; a given one is kept', () => {
  const env = {};
  assert.equal(lastRunFile(env, 'hub'), join(RESULTS, '.last-run-hub.json'));
  assert.equal(env.PLAYWRIGHT_LAST_RUN_OUTPUT_FILE, join(RESULTS, '.last-run-hub.json'));
  assert.equal(lastRunFile({ PLAYWRIGHT_LAST_RUN_OUTPUT_FILE: '/x/last.json' }, 'web'), '/x/last.json');
});
