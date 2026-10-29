// The writes of the web engine are those of nvim on the same commit, byte for byte: the answer of every request of ops,
// and every file of the vault after it. The Lua 5.4 float trap (0.5 * 2 is "1.0", not "1") would show here, where a
// number made by arithmetic is written into a file.
//
//   TASKS_WEB_COMPARE=1 node --experimental-strip-types --test web/ops-compare.test.mjs        (from ui/; needs nvim)
//
// The pinned commits are written from the git objects into a temporary folder the test removes again, the same way
// web/engine.test.mjs does it. Without TASKS_WEB_COMPARE=1 the comparison is skipped (the run needs Neovim).

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { LuaFactory } from 'wasmoon';
import { isDir } from '../src/web/engine.ts';
import { WebEngine } from '../src/web/engine.ts';
import { VaultMount } from '../src/web/vault-files.ts';
import { bundle, checkout, gitFiles, readLock } from './engine-bundle.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const fixture = resolve(here, '..', '..', 'e2e', 'fixture', 'vault');
const SHIM = readFileSync(resolve(here, '..', 'src', 'web', 'vim-shim.lua'), 'utf8');
const COMPARE = process.env.TASKS_WEB_COMPARE === '1';
const TODAY = '2026-10-29';

const mask = (text) =>
  text.trim().replace(/"generated_at":"[^"]*"/g, '"generated_at":"*"').replace(/"engine":\{[^}]*\}/g, '"engine":{*}');

function materialize(repo, commit, prefixes, target) {
  for (const [path, content] of gitFiles(repo, commit, prefixes)) {
    const file = join(target, path);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, content);
  }
  return target;
}

/** Every file below `dir` as relative path -> hex of its bytes. */
function filesOnDisk(dir) {
  const out = {};
  const walk = (d) => {
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      if (statSync(p).isDirectory()) walk(p);
      else out[relative(dir, p).replaceAll('\\', '/')] = readFileSync(p).toString('hex');
    }
  };
  walk(dir);
  return out;
}

function filesInVm(fs, root) {
  const out = {};
  const walk = (abs, rel) => {
    for (const name of fs.readdir(abs)) {
      if (name === '.' || name === '..') continue;
      const child = `${abs}/${name}`;
      if (isDir(fs.stat(child).mode)) walk(child, `${rel}${name}/`);
      else out[`${rel}${name}`] = Buffer.from(fs.readFile(child)).toString('hex');
    }
  };
  walk(root, '');
  return out;
}

test('every kind of write answers and writes as nvim does on the same commit', { skip: !COMPARE && 'set TASKS_WEB_COMPARE=1 (needs nvim)' }, async (t) => {
  const lock = readLock();
  const dir = mkdtempSync(join(tmpdir(), 'tasks-web-ops-compare-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const engineDir = materialize(checkout('TASKS_ENGINE_DIR', 'tasks.nvim'), lock.commit, ['lua/', 'scripts/'], join(dir, 'tasks.nvim'));
  const libDir = materialize(checkout('LIB_NVIM_DIR', 'lib.nvim'), lock.lib_commit, ['lua/'], join(dir, 'lib.nvim'));
  // the vault is called "vault" on both sides: the id in every document is the name of the folder
  const nvimVault = join(dir, 'nvim', 'vault');
  cpSync(fixture, nvimVault, { recursive: true });
  // a folder task as well, so that the move of a folder is compared
  mkdirSync(join(nvimVault, 'lib.nvim', 'ROADMAP', 'tasks', 'fold'), { recursive: true });
  const foldText = '---\ntitle: Fold task\nstatus: open\nkind: feature\ncreated: 2026-01-01\nupdated: 2026-01-01\n---\n\nBody of the folder task\n';
  writeFileSync(join(nvimVault, 'lib.nvim', 'ROADMAP', 'tasks', 'fold', 'fold.md'), foldText);

  // a task whose numbers are written as decimals: Lua 5.4 reads "2.0" as a float and would write it back as "2.0"
  writeFileSync(
    join(nvimVault, 'lib.nvim', 'ROADMAP', 'tasks', 'floaty.md'),
    '---\ntitle: Floaty\nstatus: open\nkind: feature\nprio: 2.0\nvalue: 3.0\norder: 4.0\ncreated: 2026-01-01\nupdated: 2026-01-01\n---\n\nBody\n',
  );

  const nvim = (method, params) => {
    const args = ['--headless', '-u', 'NONE', '-l', join(engineDir, 'scripts', 'tasks.lua'), 'call', method];
    if (params) args.push(`--params=${params}`);
    args.push(`--today=${TODAY}`, `--vault=${nvimVault}`);
    try {
      return execFileSync('nvim', args, { encoding: 'utf8', env: { ...process.env, LIB_NVIM_DIR: libDir } });
    } catch (err) {
      return String(err.stdout ?? err);
    }
  };

  const web = await WebEngine.create({ factory: new LuaFactory(), bundle: bundle(), shim: SHIM });
  const vault = new VaultMount(web.fs, '/vault');
  vault.load(new Map(Object.entries(filesOnDisk(nvimVault)).map(([p, hex]) => [p, Uint8Array.from(Buffer.from(hex, 'hex'))])));

  const ops = (...list) => JSON.stringify({ client_op_id: 'cmp', ops: list });
  const confirm = (id) => {
    const here = JSON.parse(web.call('done_preview', JSON.stringify({ params: { id } }), { root: '/vault', today: TODAY }).text).confirm;
    const there = JSON.parse(nvim('done_preview', JSON.stringify({ id }))).confirm;
    assert.equal(here, there, `the token to finish ${id}`);
    return here;
  };
  const steps = [
    ['new with fields', () => ops({ op: 'new', area: 'lib.nvim', title: 'Compare new', fields: { prio: 2, effort: '0.5d', value: 4 }, body: 'Body text.\n' })],
    ['new between two tasks (a fraction of order)', () => ops({ op: 'new', area: 'lib.nvim', title: 'In between', fields: { order: 2.5 } })],
    ['set on a task with decimal numbers', () => ops({ op: 'set', id: 'lib.nvim/floaty', patch: { effort: 'S' } })],
    ['reorder next to a task with a decimal order', () => ops({ op: 'reorder', id: 'lib.nvim/order-a', before: 'lib.nvim/floaty' })],
    ['set', () => ops({ op: 'set', id: 'lib.nvim/alpha', patch: { prio: 2, effort: 'M', tags: ['x', 'y'] } })],
    ['set to the same values', () => ops({ op: 'set', id: 'lib.nvim/alpha', patch: { prio: 2 } })],
    ['append_note', () => ops({ op: 'append_note', id: 'lib.nvim/beta', text: 'a note' })],
    ['set_body', () => ops({ op: 'set_body', id: 'lib.nvim/delta', body: 'New body\n\nSecond paragraph\n' })],
    ['reorder after a task', () => ops({ op: 'reorder', id: 'lib.nvim/order-a', after: 'lib.nvim/alpha' })],
    ['tick_step', () => ops({ op: 'tick_step', id: 'lib.nvim/alpha', n: 2, done: true })],
    ['move_area', () => ops({ op: 'move_area', id: 'lib.nvim/gamma', to_area: 'nvim-config' })],
    ['plan_new', () => ops({ op: 'plan_new', area: 'lib.nvim', title: 'A compared plan' })],
    ['a wrong id and a good change in one request', () => ops({ op: 'set', id: 'lib.nvim/nope', patch: { prio: 1 } }, { op: 'set', id: 'lib.nvim/epsilon', patch: { prio: 1 } })],
    ['a stale if_match', () => ops({ op: 'set', id: 'lib.nvim/alpha', patch: { prio: 3 }, if_match: 'sha256:0000000000000000' })],
    ['a dry run', () => JSON.stringify({ client_op_id: 'cmp', dry_run: true, ops: [{ op: 'new', area: 'lib.nvim', title: 'Dry' }] })],
    ['done of a file task', () => ops({ op: 'done', id: 'lib.nvim/beta', confirm: confirm('lib.nvim/beta') })],
    ['done of a folder task', () => ops({ op: 'done', id: 'lib.nvim/fold', confirm: confirm('lib.nvim/fold') })],
    ['reopen', () => ops({ op: 'reopen', id: 'lib.nvim/done-here' })],
    ['a request the engine refuses as a whole', () => JSON.stringify({ client_op_id: 'cmp', schema: 99, ops: [{ op: 'set', id: 'lib.nvim/alpha', patch: {} }] })],
  ];
  for (const [name, build] of steps) {
    const request = build();
    const here = web.call('ops', request, { root: '/vault', today: TODAY });
    const there = nvim('ops', request);
    assert.equal(mask(here.text), mask(there), `${name}: the answer differs`);
    const left = filesInVm(web.fs, '/vault');
    const right = filesOnDisk(nvimVault);
    const differ = [...new Set([...Object.keys(left), ...Object.keys(right)])].filter((p) => left[p] !== right[p]);
    assert.deepEqual(differ, [], `${name}: files that differ between the web engine and nvim`);
  }
  // what the page reads after all these writes: the same documents on both sides (numbers written as "2.0" are read as 2)
  for (const method of ['snapshot', 'list', 'order', 'check']) {
    assert.equal(mask(web.call(method, null, { root: '/vault', today: TODAY }).text), mask(nvim(method)), `${method} after the writes`);
  }
  web.close();
});
