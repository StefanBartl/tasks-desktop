// The port of the hub of the browser tests: the default, and the one the CI moves it to.
//
//   node --experimental-strip-types --test web/e2e-port.test.mjs        (from ui/)

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULT_E2E_PORT, e2ePort } from '../e2e/port.ts';

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
