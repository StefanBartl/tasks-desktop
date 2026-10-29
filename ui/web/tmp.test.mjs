// The temp helper of the tests (web/tmp.mjs): where its folders are, when they go, what happens when one cannot go.
// And a guard over the sources: no test makes a temp folder of its own any more.
//
// A case that needs a process of its own (the end of a process is what is tested) starts `node` on a small program.
// The program gets a temp dir of its own through TEMP/TMP/TMPDIR, so what it leaves behind is found there and nowhere
// near the real one.

import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { removeTree, testDir } from './tmp.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const TMP_URL = pathToFileURL(join(here, 'tmp.mjs')).href;

/**
 * Runs `body` in a process of its own whose temp dir is `home`. The program has `tmp` (the module) and `made()`, which
 * makes a folder with a file in it and prints the root as the first line of the output.
 */
function run(home, body, { timeout } = {}) {
  const code = [
    `import * as tmp from ${JSON.stringify(TMP_URL)};`,
    `import { writeFileSync } from 'node:fs';`,
    `const made = () => { writeFileSync(tmp.tempDir('x') + '/f.txt', 'x'); console.log(tmp.tempRoot()); };`,
    body,
  ].join('\n');
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', code], {
    encoding: 'utf8',
    env: { ...process.env, TEMP: home, TMP: home, TMPDIR: home },
    timeout,
  });
  return { code: r.status, out: r.stdout, err: r.stderr, root: r.stdout.split(/\r?\n/)[0] ?? '' };
}

test('the root is in the temp dir, named after its tests, and the folders are inside it', (t) => {
  const home = testDir(t, 'home');
  const r = run(home, `console.log(tmp.tempRoot()); console.log(tmp.tempDir('label'));`);
  assert.equal(r.code, 0, r.err);
  const [root, dir] = r.out.split(/\r?\n/);
  assert.equal(resolve(dirname(root)), resolve(home));
  assert.match(root.slice(dirname(root).length + 1), /^tasks-web-run-[A-Za-z0-9]{6}$/);
  assert.equal(dirname(dir), root);
  assert.match(dir.slice(root.length + 1), /^label-[A-Za-z0-9]{6}$/);
});

test('a process makes one root per name however often it asks, and none when it never asks', (t) => {
  const home = testDir(t, 'home');
  const r = run(home, `console.log(tmp.tempRoot() === tmp.tempRoot()); console.log(tmp.tempRoot('tasks-desktop-e2e') !== tmp.tempRoot());`);
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(r.out.split(/\r?\n/).slice(0, 2), ['true', 'true']);
  const idle = run(home, `console.log('nothing asked');`);
  assert.equal(idle.code, 0, idle.err);
  assert.deepEqual(readdirSync(home), [], 'a process that asked for nothing made nothing');
});

// The point of the module: the root is gone however the process ended.
const ENDS = {
  'ends normally': `made();`,
  'calls process.exit': `made(); process.exit(3);`,
  'throws an error nobody catches': `made(); throw new Error('boom');`,
  'rejects a promise nobody catches': `made(); Promise.reject(new Error('boom'));`,
};
for (const [how, body] of Object.entries(ENDS)) {
  test(`the root is removed, with what is in it, when the process ${how}`, (t) => {
    const home = testDir(t, 'home');
    const r = run(home, body);
    assert.equal(resolve(dirname(r.root)), resolve(home), `no root was printed: ${r.out}${r.err}`);
    assert.equal(existsSync(r.root), false, `${r.root} is still there (exit ${r.code})`);
    assert.deepEqual(readdirSync(home), [], 'nothing is left in the temp dir');
  });
}

// A signal. `process.emit` runs the listeners and nothing else (on Windows a real SIGINT cannot be sent to a process,
// it kills it at once), so what is tested is what this module's listener does. The 30 s timer keeps the process alive:
// it ends at once with the exit code of the signal only if the listener ends it; without the listener, or without its
// `process.exit`, the process runs until `timeout` kills it (code null) and the case is red.
for (const [signal, expected] of [['SIGINT', 130], ['SIGTERM', 143]]) {
  test(`the root is removed and the process ends at once with ${expected} when it gets ${signal}`, (t) => {
    const home = testDir(t, 'home');
    const began = Date.now();
    const r = run(home, `made(); process.emit('${signal}'); setTimeout(() => {}, 30000);`, { timeout: 10_000 });
    assert.equal(r.code, expected, `exit ${r.code}: ${r.out}${r.err}`);
    assert.ok(Date.now() - began < 8_000, 'the process was killed by the timeout, not ended by the listener');
    assert.equal(resolve(dirname(r.root)), resolve(home), `no root was printed: ${r.out}${r.err}`);
    assert.equal(existsSync(r.root), false, `${r.root} is still there`);
    assert.deepEqual(readdirSync(home), [], 'nothing is left in the temp dir');
  });
}

// Playwright listens to Ctrl-C before the global setup (which makes the root) and stops its run in that listener,
// asynchronously, then ends the process. The listener of this module must not end the process first, and must not
// remove the root while the host still works in it (the hub sits in it); the end of the host removes it. Both orders of
// the two listeners are tried.
const HOST = `import { existsSync } from 'node:fs';
let root;
const host = () => {
  console.log('HOST');
  setTimeout(() => { console.log('STILL=' + existsSync(root)); process.exit(5); }, 100);
};`;
for (const [order, body] of Object.entries({
  'before the root is made': `process.on('SIGINT', host); made(); root = tmp.tempRoot(); process.emit('SIGINT');`,
  'after the root is made': `made(); root = tmp.tempRoot(); process.on('SIGINT', host); process.emit('SIGINT');`,
})) {
  test(`a host that handles SIGINT itself keeps it, and the root goes when the host ends (listener ${order})`, (t) => {
    const home = testDir(t, 'home');
    const r = run(home, `${HOST}
${body}`, { timeout: 10_000 });
    assert.equal(r.code, 5, `the host ends the process, not this module: exit ${r.code}: ${r.out}${r.err}`);
    assert.match(r.out, /HOST/);
    assert.match(r.out, /STILL=true/, 'the root was removed while the host still worked');
    assert.equal(existsSync(r.root), false, `${r.root} is still there after the host ended the process`);
    assert.deepEqual(readdirSync(home), []);
  });
}

test('testDir removes the folder when the test is over, also when the test failed', (t) => {
  const home = testDir(t, 'home');
  const code = [
    `import test from 'node:test';`,
    `import { testDir } from ${JSON.stringify(TMP_URL)};`,
    `import { existsSync } from 'node:fs';`,
    `let dir;`,
    `test('fails', (t) => { dir = testDir(t, 'one'); throw new Error('the test fails'); });`,
    // the next test runs when the first is over, long before the process ends
    `test('later', () => { console.log('GONE=' + !existsSync(dir)); });`,
  ].join('\n');
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', code], {
    encoding: 'utf8',
    env: { ...process.env, TEMP: home, TMP: home, TMPDIR: home },
  });
  assert.equal(r.status, 1, 'the inner test is meant to fail');
  assert.match(r.stdout, /GONE=true/, 'the folder of the failed test is still there when the next test runs');
  assert.deepEqual(readdirSync(home), [], 'the folder of the failed test and its root are gone');
});

// A folder that cannot be removed is an error, never a silent leftover. `rm` replaces fs.rmSync here.
test('removeTree tells the folder when the removal fails, and when it does not remove', (t) => {
  const dir = testDir(t, 'busy');
  const busy = () => {
    throw Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY' });
  };
  assert.throws(() => removeTree(dir, { retries: 1, delay: 1, rm: busy }), (e) => e.message.includes(dir) && e.message.includes('EBUSY') && e.cause?.code === 'EBUSY');
  assert.throws(() => removeTree(dir, { retries: 1, delay: 1, rm: () => {} }), (e) => e.message.includes(dir) && /still there/.test(e.message));
  assert.ok(existsSync(dir));
});

// The retries are made by removeTree itself (fs.rmSync retries nothing on this Node). `rm` and `sleep` replace the real
// calls here, so the loop is counted.
function busyThen(times, code = 'EBUSY') {
  const calls = { rm: 0, sleeps: [] };
  const rm = (path, options) => {
    calls.rm++;
    if (calls.rm <= times) throw Object.assign(new Error(`${code}: busy`), { code });
    rmSync(path, options);
  };
  return { calls, rm, sleep: (ms) => calls.sleeps.push(ms) };
}

test('removeTree tries a busy folder again, delay ms apart, until it goes', (t) => {
  for (const code of ['EBUSY', 'EPERM', 'EACCES', 'ENOTEMPTY']) {
    const dir = testDir(t, 'again');
    const { calls, rm, sleep } = busyThen(3, code);
    removeTree(dir, { retries: 5, delay: 7, rm, sleep });
    assert.equal(calls.rm, 4, `${code}: three failures and the call that works`);
    assert.deepEqual(calls.sleeps, [7, 7, 7], `${code}: one wait before each new try`);
    assert.equal(existsSync(dir), false);
  }
});

test('removeTree gives up after the retries, with the last error, and leaves other errors alone', (t) => {
  const dir = testDir(t, 'gives-up');
  const busy = busyThen(Infinity);
  assert.throws(
    () => removeTree(dir, { retries: 4, delay: 1, rm: busy.rm, sleep: busy.sleep }),
    (e) => e.message.includes(dir) && e.cause?.code === 'EBUSY',
  );
  assert.equal(busy.calls.rm, 5, 'the first try and four retries');
  assert.equal(busy.calls.sleeps.length, 4);
  const odd = busyThen(Infinity, 'EINVAL');
  assert.throws(() => removeTree(dir, { retries: 4, delay: 1, rm: odd.rm, sleep: odd.sleep }), (e) => e.cause?.code === 'EINVAL');
  assert.equal(odd.calls.rm, 1, 'an error that is not a busy file is not tried again');
  assert.equal(odd.calls.sleeps.length, 0);
  // a folder that a `rm` leaves in place is tried again too, and then an error
  const stays = { n: 0 };
  assert.throws(
    () => removeTree(dir, { retries: 2, delay: 1, rm: () => stays.n++, sleep: () => {} }),
    (e) => /still there/.test(e.message),
  );
  assert.equal(stays.n, 3);
  assert.ok(existsSync(dir));
});

test('removeTree: a folder that is not there is fine, and the default needs no options', (t) => {
  const dir = testDir(t, 'gone');
  const made = join(dir, 'a', 'b');
  mkdirSync(made, { recursive: true });
  writeFileSync(join(made, 'f.txt'), 'x');
  removeTree(dir);
  assert.equal(existsSync(dir), false);
  removeTree(join(dir, 'never-made'));
});

const HOLD = "console.log('up'); setInterval(() => {}, 1000)";

/**
 * A process that sits in `dir` until it is killed, or until `ms` have passed: on Windows a folder that is the working
 * folder of a process stays.
 */
async function holder(dir, ms = 0) {
  const program = ms > 0 ? `console.log('up'); setTimeout(() => process.exit(0), ${ms})` : HOLD;
  const child = spawn(process.execPath, ['-e', program], { cwd: dir, stdio: ['ignore', 'pipe', 'ignore'] });
  // it says so when it runs: until then the folder is not yet its working folder
  await new Promise((done, fail) => {
    child.stdout.once('data', done);
    child.once('error', fail);
  });
  return child;
}

// A real busy folder. (Elsewhere a folder is removed under a process that sits in it, so there is nothing to refuse.)
test('removeTree fails loudly on a real busy folder, and works when it is free', { skip: process.platform !== 'win32' && 'only Windows refuses' }, async (t) => {
  const dir = testDir(t, 'busy-real');
  const child = await holder(dir);
  try {
    assert.throws(() => removeTree(dir, { retries: 2, delay: 10 }), (e) => e.message.includes(dir));
    assert.ok(existsSync(dir));
  } finally {
    const gone = new Promise((done) => child.once('exit', done));
    child.kill();
    await gone;
  }
  removeTree(dir, { retries: 20, delay: 50 });
  assert.equal(existsSync(dir), false);
});

// The reason for the loop: a lock that is gone after a moment (the engine host still ending, a virus scan) must not
// fail the run. removeTree blocks this process while it waits, so the lock is a process of its own that ends by itself.
// Without the retries of removeTree the first try fails at once (as `fs.rmSync` does with `maxRetries`, which retries
// nothing here), and the case is red.
test('removeTree waits for a real lock that goes away, and takes the folder then', { skip: process.platform !== 'win32' && 'only Windows refuses' }, async (t) => {
  const dir = testDir(t, 'busy-then-free');
  writeFileSync(join(dir, 'f.txt'), 'x');
  const child = await holder(dir, 1000);
  const gone = new Promise((done) => child.once('exit', done));
  const began = Date.now();
  try {
    removeTree(dir, { retries: 30, delay: 100 });
  } finally {
    child.kill();
    await gone;
  }
  assert.equal(existsSync(dir), false);
  assert.ok(Date.now() - began >= 300, 'the lock was there when removeTree began, so it had to wait');
});

test('a root that cannot be removed at the end sets the exit code and names the folder', { skip: process.platform !== 'win32' && 'only Windows refuses' }, (t) => {
  const home = testDir(t, 'home');
  // the program starts a process that sits in a folder of its root and ends: the exit hook cannot remove the root
  const r = run(
    home,
    `import { spawn } from 'node:child_process';
const c = spawn(process.execPath, ['-e', ${JSON.stringify(HOLD)}], { cwd: tmp.tempDir('held'), stdio: ['ignore', 'pipe', 'ignore'] });
await new Promise((done) => c.stdout.once('data', done));
c.stdout.destroy();
c.unref();
console.log(tmp.tempRoot());
console.log(c.pid);`,
  );
  const pid = Number(r.out.split(/\r?\n/)[1]);
  try {
    assert.equal(r.code, 1, `${r.out}${r.err}`);
    assert.match(r.err, /temp folder left behind/);
    assert.ok(r.err.includes(r.root), r.err);
    assert.ok(existsSync(r.root), 'the root was meant to stay in this case');
  } finally {
    // the root is the test's to remove now
    try {
      if (pid > 0) process.kill(pid);
    } catch {
      // already gone
    }
    removeTree(r.root, { retries: 30, delay: 100 });
  }
});

// Every temp folder of the tests comes from tmp.mjs. A test that makes one by hand (mkdtemp, a name of its own in
// tmpdir()) would leave it when it crashes, and the guard in CI would only see it when the name has a known prefix.
test('no test or helper of ui/ makes a temp folder of its own', () => {
  const ui = resolve(here, '..');
  const files = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (/\.(mjs|ts)$/.test(name) && !name.endsWith('.d.ts') && !name.endsWith('.d.mts')) files.push(path);
    }
  };
  for (const sub of ['web', 'e2e', 'e2e-web']) walk(join(ui, sub));
  // tmpdir() is only read in e2e/app.spec.ts (to check that the page shows nothing of this machine)
  // (this file only names the words in strings and comments)
  const ALLOWED = { 'web/tmp.mjs': ['mkdtemp', 'tmpdir'], 'web/tmp.test.mjs': ['mkdtemp', 'tmpdir'], 'e2e/app.spec.ts': ['tmpdir'] };
  const found = [];
  for (const file of files) {
    const rel = relative(ui, file).replaceAll('\\', '/');
    const text = readFileSync(file, 'utf8');
    for (const word of ['mkdtemp', 'tmpdir']) {
      if (text.includes(word) && !(ALLOWED[rel] ?? []).includes(word)) found.push(`${rel}: ${word}`);
    }
  }
  assert.deepEqual(found, [], 'get temp folders from web/tmp.mjs (testDir, tempDir, tempRoot)');
  assert.ok(files.length > 10, 'the walk found the sources');
});
