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
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { LuaFactory } from 'wasmoon';
import { WebEngine } from '../src/web/engine.ts';
import { serveEmbeddedWasm, startWorker, WASM_URL } from '../src/web/worker.ts';
import { bundle, checkout, gitFiles, readLock } from './engine-bundle.mjs';
import { edgeFiles } from './edge-vault.mjs';
import { testDir } from './tmp.mjs';

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
  // the file descriptors the engine's writes use (fs_open, fs_write, fs_read, fs_fsync, fs_close, fs_copyfile)
  'fd.roundtrip': '{1=8,2=true,3=true,4="abc\\x00def\\xff",5=8}',
  'fd.exclusive': '{2="EEXIST",3="EEXIST",4="first"}',
  'fd.missing': '{2="ENOENT",3="ENOENT"}',
  'fd.truncate': '"new"',
  'fd.offset': '"abXYef"',
  'fd.sequential': '"one\\x2ctwo"',
  'fd.append': '"first\\x3bsecond"',
  'fd.read': '{1="0123",2="567",3="89",4=""}',
  'fd.closed': '{2="EBADF",3="EBADF",5="EBADF",6="EBADF"}',
  copyfile: '{10="ENOENT",1=true,2="payload\\x00\\xff",4="EEXIST",5="EEXIST",6=true,7="second",9="ENOENT"}',
  'fd.stat': '{1="file",2="number",3=true,4="number",6="ENOENT",7="ENOENT"}',
  pid: '{1="number",2=true,3=true}',
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
  const dir = testDir(t, 'parity');
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

/** `nvim -l tasks.lua call <method>` of the pinned commits on `vault`, written from the git objects into a temp folder. */
function nvimCaller(t, label, vault) {
  const lock = readLock();
  const dir = testDir(t, label);
  const engineDir = materialize(checkout('TASKS_ENGINE_DIR', 'tasks.nvim'), lock.commit, ['lua/', 'scripts/'], join(dir, 'tasks.nvim'));
  const libDir = materialize(checkout('LIB_NVIM_DIR', 'lib.nvim'), lock.lib_commit, ['lua/'], join(dir, 'lib.nvim'));
  return (method, params) => {
    const args = ['--headless', '-u', 'NONE', '-l', join(engineDir, 'scripts', 'tasks.lua'), 'call', method];
    if (params) args.push(`--params=${params}`);
    args.push(`--vault=${vault(dir)}`);
    try {
      return execFileSync('nvim', args, { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, env: { ...process.env, LIB_NVIM_DIR: libDir } });
    } catch (err) {
      return String(err.stdout ?? err);
    }
  };
}

test('every read method answers as nvim does on the same commit', { skip: NEEDS_NVIM }, async (t) => {
  const nvim = nvimCaller(t, 'compare', () => fixture);
  const e = await engine();
  const id = JSON.parse(e.call('list', null, { root: ROOT }).text).items[0].id;
  const cases = [...READ_METHODS.map((m) => [m]), ...BY_ID.map((m) => [m, JSON.stringify({ id })])];
  for (const [method, params] of cases) {
    const web = e.call(method, params ? `{"params":${params}}` : null, { root: ROOT }).text;
    assert.equal(mask(web), mask(nvim(method, params)), `${method} differs`);
  }
});

// The files a real vault grows over the years (edge-vault.mjs): CRLF, a byte order mark, heads that are not YAML,
// invalid bytes, text outside ASCII, numbers and dates that are none, names with a space, a folder as a task, ties in
// the order, a few hundred tasks. The measure is nvim: both answer on the same files and the documents must match:
// every page of `list` and `finished`, and every open and finished task that is not a generated one, by its id.
// The documents are compared as text: the bytes that are no UTF-8 (the task `invalid-utf8`) become U+FFFD on both
// sides before they are compared, so two different wrong bytes there would not be told apart.
test('the edge cases of a real vault answer as nvim does, for every read method and every task', { skip: NEEDS_NVIM }, async (t) => {
  const files = edgeFiles();
  const e = await WebEngine.create({ factory: new LuaFactory(), bundle: bundle(), shim: SHIM, log: () => {} });
  e.mount(Object.fromEntries(Object.entries(files).map(([path, bytes]) => [`${ROOT}/${path}`, bytes])));
  // Written once, at the first call (not again for each of the some hundred calls).
  let written = null;
  const nvim = nvimCaller(t, 'edge', (dir) => {
    if (written) return written;
    const target = join(dir, 'vault'); // named as the mount: the id of the vault is in the documents
    for (const [path, bytes] of Object.entries(files)) {
      mkdirSync(dirname(join(target, path)), { recursive: true });
      writeFileSync(join(target, path), bytes);
    }
    written = target;
    return target;
  });
  const differs = [];
  const check = (method, params) => {
    const web = e.call(method, params ? `{"params":${params}}` : null, { root: ROOT }).text;
    const there = nvim(method, params);
    if (mask(web) !== mask(there)) differs.push(`${method} ${params ?? ''}`.trim());
  };
  for (const method of READ_METHODS) check(method);
  // `list` and `finished` give a page of 100 at most: every page, by the offset, each compared with nvim's.
  const pages = (method) => {
    const items = [];
    for (let offset = 0; offset !== undefined && offset !== null; ) {
      const params = JSON.stringify({ limit: 100, offset });
      check(method, params);
      const page = JSON.parse(e.call(method, `{"params":${params}}`, { root: ROOT }).text);
      items.push(...(page.items ?? []));
      offset = page.next_offset;
    }
    return items;
  };
  const open = pages('list');
  const finished = pages('finished');
  assert.ok(open.length >= 150, `the edge vault is read: ${open.length} open tasks`);
  assert.ok(finished.length >= 3, `the finished edge cases are read: ${finished.length}`);
  // every hand made task, open or finished, by its id (the generated ones are in the pages already)
  for (const item of [...open, ...finished].filter((x) => !x.id.includes('/gen-'))) {
    for (const method of BY_ID) check(method, JSON.stringify({ id: item.id }));
  }
  assert.deepEqual(differs, [], 'the documents that differ from nvim');
});

test('an unknown method is a tasks.error, not a throw', async () => {
  const e = await engine();
  const result = e.call('no_such_method', null, { root: ROOT });
  assert.notEqual(result.code, null);
  assert.equal(JSON.parse(result.text).kind, 'tasks.error');
});

test('the write functions of the shim fail by name and like libuv: a callback, a number as flags, an unknown function, a folder', async () => {
  await engine();
  const fail = async (code) => String(await lua(`return select(2, pcall(function() ${code} end))`));
  for (const call of ['fs_open("/vault/x.md", "r", 438, function() end)', 'fs_write(1, "x", 0, function() end)', 'fs_read(1, 1, 0, function() end)', 'fs_close(1, function() end)', 'fs_fsync(1, function() end)', 'fs_copyfile("/a", "/b", 0, function() end)']) {
    assert.match(await fail(`vim.uv.${call}`), /callbacks are not available/, call);
  }
  assert.match(await fail('vim.uv.fs_open("/vault/x.md", 577, 438)'), /unsupported flags 577/);
  assert.match(await fail('vim.uv.fs_chmod("/vault/x.md", 438)'), /vim\.uv\.fs_chmod is not available in the browser/);
  assert.match(await fail('vim.uv.fs_fchmod(1, 438)'), /vim\.uv\.fs_fchmod is not available/, 'the engine asks inside pcall; the gap still has its name');
  // a folder is not opened for writing, a missing parent is ENOENT, a file where a folder is needed is ENOTDIR
  assert.equal(await lua('local fd, err, code = vim.uv.fs_open("/vault", "w", 420); return tostring(fd) .. "|" .. code'), 'nil|EISDIR');
  assert.equal(await lua('local fd, err, code = vim.uv.fs_open("/vault/nodir/x.md", "wx", 420); return tostring(fd) .. "|" .. code'), 'nil|ENOENT');
  await lua('local fd = vim.uv.fs_open("/vault/plainfile.md", "w", 420); vim.uv.fs_write(fd, "x", 0); vim.uv.fs_close(fd)');
  assert.equal(await lua('local fd, err, code = vim.uv.fs_open("/vault/plainfile.md/x.md", "wx", 420); return tostring(fd) .. "|" .. code'), 'nil|ENOTDIR');
  // a descriptor that was closed is gone, one that was opened to read cannot write
  assert.equal(await lua('local fd = vim.uv.fs_open("/vault/plainfile.md", "r", 438); local ok, err, code = vim.uv.fs_write(fd, "y", 0); vim.uv.fs_close(fd); return tostring(ok) .. "|" .. code'), 'nil|EBADF');
  assert.equal(await lua('return select(3, vim.uv.fs_read(9999, 1, 0))'), 'EBADF');
  // the file that was written is whole after the close, byte for byte
  assert.equal(await lua('local fd = vim.uv.fs_open("/vault/plainfile.md", "r", 438); local s = vim.uv.fs_read(fd, 10, 0); vim.uv.fs_close(fd); return s'), 'x');
});

test('a write of the engine through its own functions leaves the files as the engine meant: atomic write over an existing file, exclusive create, lock released', async () => {
  await engine();
  const result = await lua(`
    local fsio = require("tasks_nvim.fsio")
    local path = "/vault/atomic/over.md"
    local made = { fsio.create_exclusive(path, "first\\n") }
    local again = { fsio.create_exclusive(path, "second\\n") }
    local over = { fsio.write_atomic(path, "third\\0\\255\\n") }
    local locked = { fsio.with_lock(path, function() return "inside", fsio.read(path) end) }
    local names = {}
    for _, n in ipairs(vim.fn.readdir("/vault/atomic")) do names[#names + 1] = n end
    return table.concat({ tostring(made[1]), tostring(again[1]), tostring(again[2]), tostring(over[1]), locked[1], #locked[2], table.concat(names, ",") }, "|")
  `);
  assert.equal(result, 'true|false|exists|true|inside|8|over.md', 'no temporary file and no lock file stays behind');
});
