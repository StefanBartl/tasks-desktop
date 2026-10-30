// The port of the hub of the browser tests: a free one for each run, a given one kept, the default for a stray process.
//
//   node --experimental-strip-types --test web/e2e-port.test.mjs        (from ui/)

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:net';
import { DEFAULT_E2E_PORT, e2ePort, ensureE2ePort, runOutputDir } from '../e2e/port.ts';

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

test('a run has a results folder of its own, the same for the runner and its workers', () => {
  const env = {};
  assert.equal(runOutputDir(env, 4242), 'test-results/run-4242');
  // A worker (another process) reads the name the runner set.
  assert.equal(runOutputDir(env, 9999), 'test-results/run-4242');
  assert.equal(runOutputDir({}, 9999), 'test-results/run-9999');
});
