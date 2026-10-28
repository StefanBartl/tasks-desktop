// Bundles the Lua sources of the engine for the web variant: tasks.nvim and lib.nvim at the commits of engine.lock.
//
//   node web/engine-bundle.mjs [--out=<file>] [--report]        (from ui/)
//
// The sources come from the git objects of the pinned commits, never from the working tree, so a local change in a
// checkout cannot slip into the page. The checkouts are found like the engine tests find them: TASKS_ENGINE_DIR and
// LIB_NVIM_DIR, else REPOS_DIR/tasks.nvim and REPOS_DIR/lib.nvim. Starting at the modules the web variant calls, every
// `require("...")` with a literal name is followed; the bundle holds exactly that closure, as a map module name ->
// source. `--report` prints the modules, their size, the `vim.*` names they use and the requires that are not a
// literal (those have to be listed in EXTRA by hand).

import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');

// The modules the web variant calls. Everything else is found from these.
const ENTRY = ['tasks_nvim.api'];
// Modules reached by a require that is not a literal (none known yet).
const EXTRA = [];

/** @returns {{ commit: string, lib_commit: string }} */
export function readLock(file = join(repoRoot, 'engine.lock')) {
  const lock = {};
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([a-z_]+)\s*=\s*(\S+)\s*$/);
    if (m) lock[m[1]] = m[2];
  }
  if (!/^[0-9a-f]{40}$/.test(lock.commit ?? '') || !/^[0-9a-f]{40}$/.test(lock.lib_commit ?? '')) {
    throw new Error('engine.lock: commit and lib_commit must be full commit hashes');
  }
  return { commit: lock.commit, lib_commit: lock.lib_commit };
}

function checkout(envName, name) {
  if (process.env[envName]) return process.env[envName];
  if (process.env.REPOS_DIR) return join(process.env.REPOS_DIR, name);
  throw new Error(`${envName} or REPOS_DIR must name the ${name} checkout`);
}

function git(dir, args) {
  return execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

/** The Lua files under lua/ of one commit, as a map module name -> source, read in one `git cat-file --batch`. */
function luaFiles(dir, commit) {
  const paths = git(dir, ['ls-tree', '-r', '--name-only', commit, '--', 'lua/'])
    .split('\n')
    .filter((p) => p.endsWith('.lua'));
  const out = execFileSync('git', ['-C', dir, 'cat-file', '--batch'], {
    input: paths.map((p) => `${commit}:${p}\n`).join(''),
    maxBuffer: 256 * 1024 * 1024,
  });
  const files = new Map();
  let at = 0;
  for (const path of paths) {
    const eol = out.indexOf(0x0a, at);
    const header = out.subarray(at, eol).toString('utf8');
    const size = Number(header.split(' ')[2]);
    if (!/^[0-9a-f]+ blob \d+$/.test(header)) throw new Error(`git cat-file: ${header} (${path})`);
    const mod = path
      .slice('lua/'.length, -'.lua'.length)
      .replace(/\/init$/, '')
      .replaceAll('/', '.');
    files.set(mod, out.subarray(eol + 1, eol + 1 + size).toString('utf8'));
    at = eol + 1 + size + 1;
  }
  return files;
}

const LITERAL_REQUIRE = /\brequire\s*\(?\s*(["'])([\w.@-]+)\1/g;
const ANY_REQUIRE = /\brequire\s*\(\s*([^"'\s)][^)]*)\)/g;
const VIM_NAME = /\bvim\.((?:[A-Za-z_]\w*)(?:\.[A-Za-z_]\w*)?)/g;

/** Lua comments and strings removed, so a require in a comment is not followed. Long brackets included. */
function code(source) {
  return source.replace(/--\[(=*)\[[\s\S]*?\]\1\]|--[^\n]*/g, '');
}

/**
 * The closure of the entry modules.
 * @returns {{ lock: object, modules: Record<string, string>, report: object[] }}
 */
export function bundle({ lock = readLock(), engineDir, libDir } = {}) {
  engineDir ??= checkout('TASKS_ENGINE_DIR', 'tasks.nvim');
  libDir ??= checkout('LIB_NVIM_DIR', 'lib.nvim');
  const sources = [luaFiles(engineDir, lock.commit), luaFiles(libDir, lock.lib_commit)];
  const modules = {};
  const report = [];
  const queue = [...ENTRY, ...EXTRA];
  const missing = new Set();
  while (queue.length > 0) {
    const mod = queue.shift();
    if (mod in modules) continue;
    const src = sources.find((s) => s.has(mod));
    if (!src) {
      missing.add(mod);
      continue;
    }
    const text = src.get(mod);
    modules[mod] = text;
    const body = code(text);
    const requires = [...body.matchAll(LITERAL_REQUIRE)].map((m) => m[2]);
    const dynamic = [...body.matchAll(ANY_REQUIRE)].map((m) => m[1].trim());
    const vim = [...new Set([...body.matchAll(VIM_NAME)].map((m) => m[1]))].sort();
    report.push({ mod, bytes: text.length, requires, dynamic, vim });
    queue.push(...requires);
  }
  return { lock, modules, report, missing: [...missing].sort() };
}

function main() {
  const outArg = process.argv.find((a) => a.startsWith('--out='));
  const out = resolve(outArg ? outArg.slice('--out='.length) : join(here, '..', 'src', 'web', 'generated', 'engine.json'));
  const { lock, modules, report, missing } = bundle();
  if (process.argv.includes('--report')) {
    const vim = new Map();
    for (const r of report) {
      console.log(`${r.mod}  ${r.bytes}${r.dynamic.length ? '  dynamic: ' + r.dynamic.join(' | ') : ''}`);
      for (const v of r.vim) vim.set(v, (vim.get(v) ?? 0) + 1);
    }
    console.log(`\n${report.length} modules, ${report.reduce((n, r) => n + r.bytes, 0)} bytes`);
    console.log('not found (Neovim built-ins or optional): ' + missing.join(', '));
    console.log('\nvim.* (modules using it):');
    for (const [v, n] of [...vim].sort()) console.log(`  ${v}  ${n}`);
  }
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, JSON.stringify({ engine: lock, modules }));
  console.log(`${out}  ${Object.keys(modules).length} modules`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
