// The engine of the web variant in Node: tasks.nvim at the commit of engine.lock, in wasmoon, with the vim shim, on
// the synthetic vault of the browser tests. No browser, no Neovim for the engine itself.
//
//   node --experimental-strip-types --test web/        (from ui/; REPOS_DIR or TASKS_ENGINE_DIR + LIB_NVIM_DIR)
//
// With TASKS_WEB_COMPARE=1 two tests also ask nvim: the documents of every read method of the pinned commits (written
// from the git objects into a temporary folder the test removes again), and every case of shim-parity.lua.

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { LuaFactory } from 'wasmoon';
import { WebEngine } from '../src/web/engine.ts';
import { serveEmbeddedWasm, startWorker, WASM_URL } from '../src/web/worker.ts';
import { bundle, checkout, gitFiles, readLock } from './engine-bundle.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const fixture = resolve(here, '..', '..', 'e2e', 'fixture', 'vault');
const SHIM = readFileSync(resolve(here, '..', 'src', 'web', 'vim-shim.lua'), 'utf8');
const PARITY = readFileSync(join(here, 'shim-parity.lua'), 'utf8');
const ROOT = '/vault';
const COMPARE = process.env.TASKS_WEB_COMPARE === '1';
const NEEDS_NVIM = !COMPARE && 'set TASKS_WEB_COMPARE=1 (needs nvim)';

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
      shim: SHIM,
      log: (level, message) => logs.push(`${level} ${message}`),
    });
    e.mount(vaultFiles(fixture));
    e.logs = logs;
    return e;
  })();
  return enginePromise;
}

/** Lua run in the engine's VM; for the tests only (the class keeps its VM to itself). */
async function lua(code) {
  return (await engine()).lua.doStringSync(code);
}

function decode(result) {
  assert.equal(result.code, null, `error document: ${result.text}`);
  return JSON.parse(result.text);
}

/** A temporary folder that is gone after the test, also when it fails. */
function tempDir(t, prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** The files of `commit` under `prefixes`, written below `target` from the git objects (no archive, no tar). */
function materialize(repo, commit, prefixes, target) {
  for (const [path, content] of gitFiles(repo, commit, prefixes)) {
    const file = join(target, path);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, content);
  }
  return target;
}

const parseCases = (text) =>
  new Map(
    String(text)
      .trim()
      .split(/\r?\n/)
      .map((line) => [line.slice(0, line.indexOf('\t')), line.slice(line.indexOf('\t') + 1)]),
  );

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
  assert.match(e.call('hello', null, { root: ROOT }).text, /"\\u003cn>d"/);
});

// What nvim 0.12.2 answers for these cases of shim-parity.lua (the full comparison needs nvim, these do not). The two
// long tolower lines and the digests are kept as the SHA-256 of nvim's line.
const NVIM_ANSWERS = {
  'nil.type': '"userdata" | "vim\\x2eNIL"',
  'nil.index': 'error',
  'trim.1': '"a b"',
  'trim.6': '"\\xc3\\xbcber"',
  'trim.long': '20002',
  'split.8': 'error',
  'deep.empty': '{"a"={"x"=1}}',
  'extend.fn': '{"a"=3,"b"=3}',
  'extend.empty_dict': '{}d',
  islist: '{1=true,2=false,3=true,4=false,5=false,6=false,7=false}',
  'json.encode.9': '"\\x2d0"',
  'json.encode.10': '"123456789012345"',
  'json.encode.11': '"0\\x2e3333333333333333"',
  'json.decode.1': '{"a"=NIL,"b"={},"c"={}d,"e"=100,"f"=3,"m"=-2.5,"n"=3}',
  'json.decode.3': 'error',
  'json.decode.4': 'error',
  'normalize.7': '"\\x2f"',
  'dirname.3': '"\\x2fa\\x2fb" | ""',
  joinpath: '{1="foo\\x2fbar",2="after\\x2fplugin",3="a\\x2fb\\x2fc"}',
  'fnamemodify.4': '""',
  'fnamemodify.7': '""',
  'strchars.bad': '{1=5,2="\\xc3\\xbc\\xe4",3="\\xe4x",4=1,5="\\xe2"}',
  'strcharpart.4': '""',
  tonumber: '{1="2",2="2\\x2e5",3="100",4="16",5="255",6="nil"}',
  has: '{1=1,2=1}',
  wait: 'true | true',
  'inspect.1': '"\\x27a\\x5cnb\\x22c\\x5c\\x5c\\x27"',
  'inspect.6': '"vim\\x2eempty\\x5fdict\\x28\\x29"',
  'tolower.text':
    '"\\xc3\\xa4\\xc3\\xb6\\xc3\\xbc\\xc3\\x9f \\xc3\\xbcbersicht i \\xe2\\xb1\\xa5 k \\xc3\\xa6\\xc3\\xb8\\xc3\\xa5 \\xcf\\x83\\xce\\xb1\\xce\\xb2 \\xd0\\xb4\\xd0\\xb6"',
};
const NVIM_DIGESTS = {
  'tolower.codepoints': '9dc03dd7443b0304bd1836202fb2910fd5cf1f73e8778d130e0fe990bf21762b',
  'tolower.bytes': 'c362f6c5df6768497717d74b4b3e7a5d84e3e052480b5ac12cae2ba44635d6fb',
  sha256: '4817f96b2ae1c290b7649046b633f3dccfdd6ab30b4c69768a34b00d087c38c9',
};

test('the shim answers the recorded cases as nvim does', async () => {
  const web = parseCases(await lua(PARITY));
  for (const [name, want] of Object.entries(NVIM_ANSWERS)) assert.equal(web.get(name), want, name);
  for (const [name, digest] of Object.entries(NVIM_DIGESTS)) {
    assert.equal(createHash('sha256').update(web.get(name) ?? '').digest('hex'), digest, name);
  }
});

test('every case of shim-parity.lua answers as nvim does', { skip: NEEDS_NVIM }, async (t) => {
  const dir = tempDir(t, 'tasks-web-parity-');
  const runner = join(dir, 'run.lua');
  writeFileSync(runner, 'io.stdout:write(dofile(arg[1]), "\\n")\n');
  const nvim = parseCases(execFileSync('nvim', ['--headless', '-u', 'NONE', '-l', runner, join(here, 'shim-parity.lua')], { encoding: 'utf8' }));
  const web = parseCases(await lua(PARITY));
  const differ = [...nvim.keys()].filter((name) => web.get(name) !== nvim.get(name));
  assert.deepEqual(differ, [], `cases that differ: ${differ.map((n) => `${n}: nvim ${nvim.get(n)?.slice(0, 120)} / web ${web.get(n)?.slice(0, 120)}`).join('; ')}`);
});

test('vim.trim stays linear on a long run of whitespace inside the text', async () => {
  const ms = Number(await lua('local s = " x" .. string.rep(" ", 40000) .. "y "; local t = os.clock(); vim.trim(s); return (os.clock() - t) * 1000'));
  assert.ok(ms < 500, `vim.trim took ${Math.round(ms)} ms`);
});

test('a folder whose names hold a tab or a newline is listed whole', async () => {
  const e = await engine();
  e.mount({ '/names/a\tb.md': 'x', '/names/c\nd.md': 'y' });
  assert.equal(await lua('local n = vim.fn.readdir("/names"); return #n .. "|" .. table.concat(n, "|")'), '2|a\tb.md|c\nd.md');
});

test('vim.fn.mkdir raises E739 as Neovim does, os.exit is refused', async () => {
  await engine();
  assert.match(String(await lua('return select(2, pcall(vim.fn.mkdir, "/vault"))')), /E739/);
  assert.equal(await lua('return vim.fn.mkdir("/made/deep/down", "p")'), 1);
  assert.match(String(await lua('return select(2, pcall(os.exit, 1))')), /not available in the browser/);
  // `$VAR` in a path as Neovim: replaced when set, kept when not, kept on request
  assert.equal(await lua('vim.env.WEB_T = "/x"; return vim.fs.normalize("$WEB_T/a/$WEB_NOT_SET")'), '/x/a/$WEB_NOT_SET');
  assert.equal(await lua('return vim.fs.normalize("$WEB_T/a", { expand_env = false })'), '$WEB_T/a');
  // the screen's width of a text is the editor's: refused by name, not counted wrong
  assert.match(String(await lua('return select(2, pcall(vim.fn.strdisplaywidth, "a\\tb"))')), /strdisplaywidth/);
  // a callback would never come: refused at once, like fs_stat's
  assert.match(String(await lua('return select(2, pcall(vim.uv.fs_scandir, "/vault", function() end))')), /callbacks/);
});

test('a call does not ask the VM for its door again', async () => {
  const e = await engine();
  const get = e.lua.global.get;
  e.lua.global.get = () => {
    throw new Error('global.get during a call');
  };
  try {
    assert.equal(decode(e.call('hello', null, { root: ROOT })).kind, 'tasks.hello');
  } finally {
    e.lua.global.get = get;
  }
});

test('a door that cannot load the engine still answers one tasks.error document', async () => {
  const bare = await WebEngine.create({ factory: new LuaFactory(), bundle: { engine: readLock(), modules: {} }, shim: SHIM });
  const r = bare.call('hello', null, { root: ROOT });
  assert.equal(r.code, 'internal');
  const doc = JSON.parse(r.text);
  assert.equal(doc.kind, 'tasks.error');
  assert.match(doc.message, /tasks_nvim\.api/);
  bare.close();
});

test('the worker serves the embedded WASM and refuses a second init', async () => {
  const bytes = new Uint8Array([0, 97, 115, 109]).buffer;
  const seen = [];
  const scope = { fetch: async (url) => (seen.push(String(url)), new Response('net')), postMessage: () => {}, onmessage: null };
  serveEmbeddedWasm(scope, bytes);
  assert.deepEqual([...new Uint8Array(await (await scope.fetch(WASM_URL)).arrayBuffer())], [0, 97, 115, 109]);
  await scope.fetch('https://example.invalid/');
  assert.deepEqual(seen, ['https://example.invalid/'], 'only the other request reaches the real fetch');

  // The first init fails on purpose (Node has no embedded WASM; Emscripten prints "Aborted(...)"): only the refusal
  // of the second one is the point here.
  const replies = [];
  const worker = { fetch: async () => new Response(''), postMessage: (m) => replies.push(m), onmessage: null };
  startWorker(worker);
  const init = { data: { type: 'init', wasm: bytes, bundle: { engine: readLock(), modules: {} }, shim: '', files: {} } };
  const first = worker.onmessage(init);
  await worker.onmessage(init);
  assert.ok(replies.some((m) => m.type === 'error' && /already started/.test(m.message)), JSON.stringify(replies));
  await first;
});

// The documents of the web engine are those of nvim on the same commit, byte for byte. Masked are only the fields that
// must differ: the time of the answer and the runtime (`engine`: no Neovim in the browser).
const READ_METHODS = [
  'hello', 'areas', 'snapshot', 'list', 'next', 'links', 'groupings', 'views', 'lists', 'order', 'finished', 'check',
  'estimate',
];
const BY_ID = ['task', 'done_preview', 'plan_for'];

const mask = (text) =>
  text.trim().replace(/"generated_at":"[^"]*"/g, '"generated_at":"*"').replace(/"engine":\{[^}]*\}/g, '"engine":{*}');

test('every read method answers as nvim does on the same commit', { skip: NEEDS_NVIM }, async (t) => {
  const lock = readLock();
  const dir = tempDir(t, 'tasks-web-compare-');
  const engineDir = materialize(checkout('TASKS_ENGINE_DIR', 'tasks.nvim'), lock.commit, ['lua/', 'scripts/'], join(dir, 'tasks.nvim'));
  const libDir = materialize(checkout('LIB_NVIM_DIR', 'lib.nvim'), lock.lib_commit, ['lua/'], join(dir, 'lib.nvim'));
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
