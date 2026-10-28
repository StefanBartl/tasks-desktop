// The engine of the web variant in Node: tasks.nvim at the commit of engine.lock, in wasmoon, with the vim shim, on
// the synthetic vault of the browser tests. No browser, no Neovim for the engine itself.
//
//   node --test web/                                   (from ui/; REPOS_DIR or TASKS_ENGINE_DIR + LIB_NVIM_DIR)
//
// With TASKS_WEB_COMPARE=1 the answers are also compared with `nvim --headless -l scripts/tasks.lua call ...` of the
// same commits: the test unpacks them from the checkouts with `git archive` into a temporary folder it removes again.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { LuaFactory } from 'wasmoon';
import { WebEngine } from '../src/web/engine.ts';
import { bundle, readLock } from './engine-bundle.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const fixture = resolve(here, '..', '..', 'e2e', 'fixture', 'vault');
const ROOT = '/vault';

function vaultFiles(dir) {
  const files = {};
  const walk = (d) => {
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      if (statSync(p).isDirectory()) walk(p);
      else files[`${ROOT}/${relative(dir, p).replaceAll('\\', '/')}`] = readFileSync(p);
    }
  };
  walk(dir);
  return files;
}

let enginePromise;
function engine() {
  enginePromise ??= (async () => {
    const logs = [];
    const e = await WebEngine.create({
      factory: new LuaFactory(),
      bundle: bundle(),
      shim: readFileSync(resolve(here, '..', 'src', 'web', 'vim-shim.lua'), 'utf8'),
      log: (level, message) => logs.push(`${level} ${message}`),
    });
    e.mount(vaultFiles(fixture));
    e.logs = logs;
    return e;
  })();
  return enginePromise;
}

function decode(result) {
  assert.equal(result.code, null, `error document: ${result.text}`);
  return JSON.parse(result.text);
}

test('hello answers with the handshake of the pinned engine', async () => {
  const e = await engine();
  const doc = decode(e.call('hello', null, { root: ROOT }));
  assert.equal(doc.kind, 'tasks.hello');
  assert.equal(doc.schema, 1);
  assert.ok(doc.capabilities.length > 0, 'capabilities');
  assert.ok(doc.enums.status.includes('open'), 'enums.status');
  // no Neovim runs in the browser, and the document says so instead of naming a version
  assert.equal(doc.engine.nvim, 'web+Lua5.4');
  // the canonical bytes of lib.nvim.json.canonical: "<" is escaped, as nvim writes it
  assert.match(result(e).text, /"\\u003cn>d"/);
});

function result(e) {
  return e.call('hello', null, { root: ROOT });
}

// The documents of the web engine are those of nvim on the same commit, byte for byte. Masked are only the fields that
// must differ: the time of the answer and the runtime (`engine`: no Neovim in the browser).
const READ_METHODS = [
  'hello', 'areas', 'snapshot', 'list', 'next', 'links', 'groupings', 'views', 'lists', 'order', 'finished', 'check',
  'estimate',
];
const BY_ID = ['task', 'done_preview', 'plan_for'];

const mask = (text) =>
  text.trim().replace(/"generated_at":"[^"]*"/g, '"generated_at":"*"').replace(/"engine":\{[^}]*\}/g, '"engine":{*}');

test('every read method answers as nvim does on the same commit', { skip: process.env.TASKS_WEB_COMPARE !== '1' && 'set TASKS_WEB_COMPARE=1 (needs nvim)' }, async (t) => {
  const lock = readLock();
  const dir = mkdtempSync(join(tmpdir(), 'tasks-web-compare-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const pinned = (repo, commit, name) => {
    const target = join(dir, name);
    mkdirSync(target);
    execFileSync('git', ['-C', repo, 'archive', '-o', join(dir, `${name}.tar`), commit]);
    execFileSync('tar', ['-xf', join(dir, `${name}.tar`), '-C', target]);
    return target;
  };
  const repos = process.env.REPOS_DIR ?? '';
  const engineDir = pinned(process.env.TASKS_ENGINE_DIR ?? join(repos, 'tasks.nvim'), lock.commit, 'tasks.nvim');
  const libDir = pinned(process.env.LIB_NVIM_DIR ?? join(repos, 'lib.nvim'), lock.lib_commit, 'lib.nvim');
  const nvim = (method, params) => {
    const args = ['--headless', '-u', 'NONE', '-l', join(engineDir, 'scripts', 'tasks.lua'), 'call', method];
    if (params) args.push(`--params=${params}`);
    args.push(`--vault=${fixture}`);
    try {
      return execFileSync('nvim', args, { encoding: 'utf8', env: { ...process.env, LIB_NVIM_DIR: libDir } });
    } catch (err) {
      return String(err.stdout ?? err);
    }
  };
  const e = await engine();
  const id = JSON.parse(e.call('list', null, { root: ROOT }).text).items[0].id;
  const cases = [...READ_METHODS.map((m) => [m]), ...BY_ID.map((m) => [m, JSON.stringify({ id })])];
  for (const [method, params] of cases) {
    const web = e.call(method, params ? `{"params":${params}}` : null, { root: ROOT }).text;
    assert.equal(mask(web), mask(nvim(method, params)), `${method} differs`);
  }
});

test('an unknown method is a tasks.error, not a throw', async () => {
  const e = await engine();
  const result = e.call('no_such_method', null, { root: ROOT });
  assert.notEqual(result.code, null);
  assert.equal(JSON.parse(result.text).kind, 'tasks.error');
});
