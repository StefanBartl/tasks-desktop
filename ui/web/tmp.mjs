// Temp folders for the tests of ui/ (the Node tests in web/, the Playwright projects e2e/ and e2e-web/).
//
// Every test that needs a folder gets it from here and from nowhere else (web/tmp.test.mjs holds the sources to that).
// A process makes ONE root in the temp dir, named after the tests that own it (`tasks-web-run-XXXXXX`, or
// `tasks-desktop-e2e-XXXXXX` for the hub's browser tests), and everything below lives inside it:
//
//   - `testDir(t, label)` is a folder of one test, removed when that test is over, also when it failed;
//   - the root itself is removed when the process ends: normally, by `process.exit`, by an uncaught error, by SIGINT or
//     SIGTERM. Only a kill that gives the process no chance (SIGKILL, power) leaves it, and then it is one folder with a
//     name that says whose it is, not one per test. A host that handles the signal itself (Playwright does for Ctrl-C:
//     it stops the run, then runs the global teardown) keeps it: this module then leaves the ending to the host and only
//     removes the root in the `exit` event that follows;
//   - a folder that cannot be removed (a file a child process still holds: EBUSY or EPERM on Windows) is retried, and then
//     it is an error, never a silent leftover. At the end of the process that error sets the exit code to 1. The retries
//     are made here, in a loop: the `maxRetries` option of `fs.rmSync` does nothing on the Node of this repository (the
//     call fails at once on a busy file), so it is not used. web/tmp.test.mjs proves it with a real lock that goes away.
//
// tools/check-temp-leftovers.mjs counts the names `tasks-web-*` and `tasks-desktop-*` (CI runs it after these tests).

import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const DEFAULT_ROOT = 'tasks-web-run';

/** name -> the root of this process under that name */
const roots = new Map();
let hooked = false;

/** Errors of a file that is busy for a moment (the engine, a watcher, a virus scan); anything else is thrown at once. */
const BUSY = new Set(['EBUSY', 'EPERM', 'EACCES', 'ENOTEMPTY']);

/** Waits `ms` without a timer, so the callers stay synchronous (the exit event allows nothing else). */
function pause(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Remove a folder with everything in it. A file that is busy for a moment is tried again, `retries` times, `delay` ms
 * apart (the loop is here: `fs.rmSync` retries nothing on this Node, whatever `maxRetries` says); after that the error is
 * thrown. Gone or never there is fine; still there after a `rm` that did not throw is retried and then an error as well.
 * `rm` and `sleep` are for the tests of this module.
 */
export function removeTree(path, { retries = 10, delay = 100, rm = rmSync, sleep = pause } = {}) {
  let failure;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) sleep(delay);
    try {
      rm(path, { recursive: true, force: true });
    } catch (error) {
      failure = new Error(`cannot remove ${path}: ${error instanceof Error ? error.message : error}`, { cause: error });
      if (!BUSY.has(error?.code)) break;
      continue;
    }
    if (!existsSync(path)) return;
    failure = new Error(`cannot remove ${path}: it is still there`);
  }
  throw failure;
}

/**
 * Remove the roots of this process now (the end of a Playwright run). Every root is tried; if some cannot be removed
 * the error names them all.
 */
export function cleanUp(options) {
  const failed = [];
  for (const [name, root] of roots) {
    try {
      removeTree(root, options);
      roots.delete(name);
    } catch (error) {
      failed.push(error instanceof Error ? error.message : String(error));
    }
  }
  if (failed.length > 0) throw new Error(failed.join('\n'));
}

function atExit() {
  try {
    cleanUp();
  } catch (error) {
    console.error(`temp folder left behind: ${error instanceof Error ? error.message : error}`);
    process.exitCode = 1;
  }
}

function hook() {
  if (hooked) return;
  hooked = true;
  process.on('exit', atExit);
  // Without a listener the signal would end the process before the exit event; with one it has to end it itself, unless
  // somebody else listens: a host such as Playwright stops its run in its own listener (asynchronously: reporter, global
  // teardown, which stops the hub that sits in our root) and ends the process when that is done. Ending it here first
  // would skip all that, and the root could not be removed while the hub still runs. The `exit` event of the host's end
  // removes the root. (`once` has taken this listener away when it runs, so the count is the others'.)
  for (const [signal, code] of [['SIGINT', 130], ['SIGTERM', 143]]) {
    process.once(signal, () => {
      if (process.listenerCount(signal) > 0) return;
      atExit();
      process.exit(code);
    });
  }
}

/** The root of this process under `name`: made on the first call, removed when the process ends. */
export function tempRoot(name = DEFAULT_ROOT) {
  let root = roots.get(name);
  if (root === undefined || !existsSync(root)) {
    root = mkdtempSync(join(tmpdir(), `${name}-`));
    roots.set(name, root);
    hook();
  }
  return root;
}

/** A new folder below `root` (the root of this process by default). The caller removes it, or the root takes it along. */
export function tempDir(label, root = tempRoot()) {
  return mkdtempSync(join(root, `${label}-`));
}

/** A new folder for one test (`t` of node:test), removed when the test is over, also when it failed. */
export function testDir(t, label) {
  const dir = tempDir(label);
  t.after(() => removeTree(dir));
  return dir;
}
