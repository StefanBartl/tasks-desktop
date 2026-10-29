// The cleanup of the hub's browser tests (e2e/hub.ts, e2e/global.ts), without a real hub: a setup that fails, and the end of
// a run, leave nothing in the temp dir. These are the paths the browser tests themselves never take (a hub that does not
// start, an exchange that is refused) and the one nobody looks at (the state file at the end of a run).
//
// Node loads the two files as TypeScript (type stripping, as in `web:test`); they name each other with the extension for it.

import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { RUN_ROOT_NAME, portTaken, startHub } from '../e2e/hub.ts';
import { runSetup } from '../e2e/global.ts';
import { removeTree, tempDir, tempRoot, testDir } from './tmp.mjs';

/** A hub that does nothing: it makes its folder like the real one, and `stop` removes it. `calls` says what happened. */
function fakeSteps({ token = async () => 'the-token', start } = {}) {
  const calls = { started: 0, stopped: 0 };
  return {
    calls,
    steps: {
      token,
      start:
        start ??
        (async () => {
          calls.started++;
          const root = tempDir('hub', tempRoot(RUN_ROOT_NAME));
          return {
            child: null,
            config: join(root, 'config'),
            vault: join(root, 'vault'),
            root,
            stop: async () => {
              calls.stopped++;
              removeTree(root);
            },
          };
        }),
    },
  };
}

/** The folder of the run: the one the state file is in. */
const runRoot = () => dirname(process.env['TASKS_DESKTOP_E2E_STATE'] ?? '');

test('the end of a run removes the hub, its folder and the state file with the root of the run', async () => {
  const { calls, steps } = fakeSteps();
  const teardown = await runSetup(steps);
  const state = process.env['TASKS_DESKTOP_E2E_STATE'];
  const root = runRoot();
  assert.equal(JSON.parse(readFileSync(state, 'utf8')).token, 'the-token', 'the setup wrote the state file');
  assert.ok(existsSync(root));
  await teardown();
  assert.equal(calls.stopped, 1, 'the hub was stopped');
  assert.equal(existsSync(state), false, 'the state file is gone');
  assert.equal(existsSync(root), false, `${root} is still there`);
});

test('a setup that fails after the hub started stops the hub and removes everything', async () => {
  const { calls, steps } = fakeSteps({
    token: async () => {
      throw new Error('exchange refused: 429');
    },
  });
  await assert.rejects(runSetup(steps), /exchange refused/, 'the first error is the one that is thrown');
  assert.equal(calls.started, 1);
  assert.equal(calls.stopped, 1, 'the hub that started was stopped (Playwright calls no teardown of a failed setup)');
  assert.equal(existsSync(runRoot()), false, `${runRoot()} is still there`);
});

test('a setup whose hub does not start removes the root it made', async () => {
  const { steps } = fakeSteps({
    start: async () => {
      throw new Error('port 17698 is in use');
    },
  });
  await assert.rejects(runSetup(steps), /port 17698/);
  assert.equal(existsSync(runRoot()), false, `${runRoot()} is still there`);
});

test('a hub that never gets ready is stopped and its folder removed', async (t) => {
  if (await portTaken()) return t.skip('something answers on the port of the hub: stop it to run this');
  const dir = testDir(t, 'fake-hub');
  const program = join(dir, 'fake-hub.mjs');
  // answers nothing, and ends by itself if nobody stops it (so a missing stop does not leave it running for long)
  writeFileSync(program, 'setTimeout(() => process.exit(0), 5000);\n');
  await assert.rejects(startHub({ exe: process.execPath, args: [program], readyTimeout: 600 }));
  assert.deepEqual(readdirSync(tempRoot(RUN_ROOT_NAME)), [], 'the folder of the hub that failed to start is gone');
});
