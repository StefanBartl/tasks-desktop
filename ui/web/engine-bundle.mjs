// Bundles the Lua sources of the engine for the web variant: tasks.nvim and lib.nvim at the commits of engine.lock.
//
//   node web/engine-bundle.mjs [--out=<file>] [--report]        (from ui/)
//
// The sources come from the git objects of the pinned commits, never from the working tree, so a local change in a
// checkout cannot slip into the page. The checkouts are found like the engine tests find them: TASKS_ENGINE_DIR and
// LIB_NVIM_DIR, else REPOS_DIR/tasks.nvim and REPOS_DIR/lib.nvim. Starting at the modules the web variant calls, every
// require with a literal name is followed (`require("x")`, `require "x"`, `pcall(require, "x")`); the bundle holds
// exactly that closure, as a map module name -> source, plus the modules of Neovim's runtime the shim brings along
// (VENDORED). A small Lua lexer finds the requires, so a require in a comment or a string is not one, and it drops the
// comments: the newlines stay, so a line number in an error is still the line of the file. `--report` prints the
// modules, their size, the `vim.*` names they use and the requires that are not a literal (those have to be listed in
// EXTRA by hand).

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
// Pure Lua modules of Neovim's runtime the shim uses, kept in this repository (see the head of each file).
const VENDORED = { 'vim.inspect': join(here, '..', 'src', 'web', 'vendor', 'inspect.lua') };

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

export function checkout(envName, name) {
  if (process.env[envName]) return process.env[envName];
  if (process.env.REPOS_DIR) return join(process.env.REPOS_DIR, name);
  throw new Error(`${envName} or REPOS_DIR must name the ${name} checkout`);
}

function git(dir, args) {
  return execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

/**
 * The files of one commit under `prefixes`, as a map path -> content (Buffer), read in one `git cat-file --batch`.
 * @param {string} dir
 * @param {string} commit
 * @param {string[]} prefixes
 */
export function gitFiles(dir, commit, prefixes) {
  // -z: without it git quotes a path outside ASCII ("lua/\303\244.lua"), and cat-file would not find it
  const paths = git(dir, ['ls-tree', '-r', '-z', '--name-only', commit, '--', ...prefixes])
    .split('\0')
    .filter(Boolean);
  const out = execFileSync('git', ['-C', dir, 'cat-file', '--batch'], {
    input: paths.map((p) => `${commit}:${p}\n`).join(''),
    maxBuffer: 256 * 1024 * 1024,
  });
  const files = new Map();
  let at = 0;
  for (const path of paths) {
    const eol = out.indexOf(0x0a, at);
    const header = out.subarray(at, eol).toString('utf8');
    if (!/^[0-9a-f]+ blob \d+$/.test(header)) throw new Error(`git cat-file: ${header} (${path})`);
    const size = Number(header.split(' ')[2]);
    files.set(path, out.subarray(eol + 1, eol + 1 + size));
    at = eol + 1 + size + 1;
  }
  return files;
}

/**
 * The Lua files under lua/ of one commit, as a map module name -> source. `x.lua` wins over `x/init.lua`, as in the
 * search order of Lua and Neovim (`?.lua` before `?/init.lua`).
 */
export function luaFiles(dir, commit) {
  const files = new Map();
  const fromInit = new Set();
  for (const [path, content] of gitFiles(dir, commit, ['lua/'])) {
    if (!path.endsWith('.lua')) continue;
    const isInit = path.endsWith('/init.lua');
    const mod = path
      .slice('lua/'.length, -'.lua'.length)
      .replace(/\/init$/, '')
      .replaceAll('/', '.');
    if (files.has(mod) && (isInit || !fromInit.has(mod))) continue;
    files.set(mod, content.toString('utf8'));
    if (isInit) fromInit.add(mod);
    else fromInit.delete(mod);
  }
  return files;
}

/**
 * Lua tokens of `source`: names, strings (with their value), other symbols; comments are skipped but reported as
 * ranges, so they can be cut out. Follows the Lua 5.1-5.4 lexer where it matters for that: long brackets
 * (`[[`, `[==[`), quoted strings with escapes, `--` comments of both kinds.
 * @param {string} source
 */
export function lex(source) {
  const tokens = [];
  const comments = [];
  const n = source.length;
  let i = 0;
  const longBracket = (at) => {
    // `[` `=`* `[` at `at`: the level, or -1
    let j = at + 1;
    while (source[j] === '=') j++;
    return source[j] === '[' ? j - at - 1 : -1;
  };
  const closeLong = (from, level) => {
    const end = source.indexOf(`]${'='.repeat(level)}]`, from);
    if (end < 0) throw new Error(`unfinished long bracket at ${from}`);
    return end + level + 2;
  };
  while (i < n) {
    const c = source[i];
    if (c === '-' && source[i + 1] === '-') {
      const start = i;
      i += 2;
      const level = source[i] === '[' ? longBracket(i) : -1;
      if (level >= 0) i = closeLong(i + level + 2, level);
      else {
        const nl = source.indexOf('\n', i);
        i = nl < 0 ? n : nl;
      }
      comments.push([start, i]);
    } else if (c === '[' && longBracket(i) >= 0) {
      const level = longBracket(i);
      let from = i + level + 2;
      // a newline right after the opening bracket is not part of the string
      if (source[from] === '\r') from++;
      if (source[from] === '\n') from++;
      const end = closeLong(from, level);
      tokens.push({ type: 'string', value: source.slice(from, end - level - 2), at: i });
      i = end;
    } else if (c === '"' || c === "'") {
      let j = i + 1;
      let value = '';
      while (j < n && source[j] !== c) {
        if (source[j] === '\\') {
          value += source[j + 1] ?? '';
          j += 2;
        } else if (source[j] === '\n') {
          throw new Error(`unfinished string at ${i}`);
        } else value += source[j++];
      }
      tokens.push({ type: 'string', value, at: i });
      i = j + 1;
    } else if (/[A-Za-z_]/.test(c)) {
      let j = i + 1;
      while (j < n && /\w/.test(source[j])) j++;
      tokens.push({ type: 'name', value: source.slice(i, j), at: i });
      i = j;
    } else if (/\s/.test(c)) {
      i++;
    } else {
      tokens.push({ type: 'symbol', value: c, at: i });
      i++;
    }
  }
  return { tokens, comments };
}

/** The requires of `source`: literal names, and the arguments of the others (for the report). */
export function requiresOf(tokens) {
  const literal = [];
  const dynamic = [];
  for (let k = 0; k < tokens.length; k++) {
    const t = tokens[k];
    if (t.type !== 'name' || t.value !== 'require') continue;
    const prev = tokens[k - 1];
    // `x.require` / `x:require` is a field of another table (soft.require is caught by its own literal argument)
    const next = tokens[k + 1];
    const after = tokens[k + 2];
    if (next?.type === 'string') literal.push(next.value);
    else if (next?.value === '(' && after?.type === 'string' && tokens[k + 3]?.value === ')') literal.push(after.value);
    else if (next?.value === ',' && prev?.value === '(' && tokens[k - 2]?.value === 'pcall') {
      // `pcall(require, "x")`; `pcall(require, "x" .. y)` is a name made at run time
      if (after?.type === 'string' && tokens[k + 3]?.value === ')') literal.push(after.value);
      else dynamic.push(after ? `${after.value}...` : '?');
    } else if (next?.value === '(') dynamic.push(after ? `${after.value}...` : '?');
  }
  return { literal, dynamic };
}

/** `source` without its comments; every newline of a comment stays, so the lines keep their numbers. */
export function stripComments(source, comments) {
  let out = '';
  let at = 0;
  for (const [start, end] of comments) {
    out += source.slice(at, start) + source.slice(start, end).replace(/[^\n]/g, '');
    at = end;
  }
  return out + source.slice(at);
}

const VIM_NAME = /\bvim\.((?:[A-Za-z_]\w*)(?:\.[A-Za-z_]\w*)?)/g;

/**
 * The closure of the entry modules.
 * @returns {{ engine: { commit: string, lib_commit: string }, modules: Record<string, string>, report: object[],
 *   missing: string[] }}
 */
export function bundle({ lock = readLock(), engineDir, libDir, strip = true } = {}) {
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
    const { tokens, comments } = lex(text);
    const code = stripComments(text, comments);
    modules[mod] = strip ? code : text;
    const { literal, dynamic } = requiresOf(tokens);
    const vim = [...new Set([...code.matchAll(VIM_NAME)].map((m) => m[1]))].sort();
    report.push({ mod, bytes: text.length, stripped: code.length, requires: literal, dynamic, vim });
    queue.push(...literal);
  }
  for (const [mod, file] of Object.entries(VENDORED)) modules[mod] = readFileSync(file, 'utf8');
  return { engine: lock, modules, report, missing: [...missing].sort() };
}

function main() {
  const outArg = process.argv.find((a) => a.startsWith('--out='));
  const out = resolve(outArg ? outArg.slice('--out='.length) : join(here, '..', 'src', 'web', 'generated', 'engine.json'));
  const { engine, modules, report, missing } = bundle();
  if (process.argv.includes('--report')) {
    const vim = new Map();
    for (const r of report) {
      console.log(`${r.mod}  ${r.bytes} -> ${r.stripped}${r.dynamic.length ? '  dynamic: ' + r.dynamic.join(' | ') : ''}`);
      for (const v of r.vim) vim.set(v, (vim.get(v) ?? 0) + 1);
    }
    const raw = report.reduce((n, r) => n + r.bytes, 0);
    const stripped = report.reduce((n, r) => n + r.stripped, 0);
    console.log(`\n${report.length} modules, ${raw} bytes, ${stripped} without comments`);
    console.log('not found (Neovim built-ins or optional): ' + missing.join(', '));
    console.log('\nvim.* (modules using it):');
    for (const [v, n] of [...vim].sort()) console.log(`  ${v}  ${n}`);
  }
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, JSON.stringify({ engine, modules }));
  console.log(`${out}  ${Object.keys(modules).length} modules`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
