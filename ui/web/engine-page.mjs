// Builds the engine check page of the web variant: one HTML file, opened from disk (file://), that starts the engine in
// a classic worker from a blob and answers the read methods on the synthetic vault of the browser tests.
//
//   node web/engine-page.mjs [--out=<file>]        (from ui/; default web/dist/engine-check.html)
//
// It is the proof of step 1 of the pilot in a real browser, built without vite (whose toolchain brings native binaries):
// the TypeScript of src/web is stripped of its types by Node itself, the imports become globals (wasmoon is a UMD
// bundle and sets `self.wasmoon` in a classic worker). The parts are embedded gzip-compressed as base64 and unpacked by
// the browser (DecompressionStream), so the page also measures what the real page will weigh. The build refuses a page
// that loads a file or names a URL outside the embedded parts.

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { bundle } from './engine-bundle.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const ui = resolve(here, '..');
const fixture = resolve(ui, '..', 'e2e', 'fixture', 'vault');

const outArg = process.argv.find((a) => a.startsWith('--out='));
const out = resolve(outArg ? outArg.slice('--out='.length) : join(here, 'dist', 'engine-check.html'));

/** A module of src/web as a classic script: types stripped, imports dropped, `export` removed. */
function classic(file) {
  const js = stripTypeScriptTypes(readFileSync(file, 'utf8'), { mode: 'strip' });
  return js
    .split('\n')
    .filter((line) => !/^\s*import\s/.test(line))
    .map((line) => line.replace(/^export\s+/, ''))
    .join('\n');
}

function vaultFiles(dir) {
  const files = {};
  const walk = (d) => {
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      if (statSync(p).isDirectory()) walk(p);
      else files[`/vault/${relative(dir, p).replaceAll('\\', '/')}`] = readFileSync(p, 'utf8');
    }
  };
  walk(dir);
  return files;
}

function commit() {
  try {
    return execFileSync('git', ['-C', ui, 'rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim();
  } catch {
    return 'unknown';
  }
}

const gz = (data) => gzipSync(data, { level: 9 }).toString('base64').replace(/.{1,120}/g, '$&\n');

const wasmoonDir = join(ui, 'node_modules', 'wasmoon', 'dist');
const workerSource = [
  readFileSync(join(wasmoonDir, 'index.js'), 'utf8'),
  'const { LuaFactory } = self.wasmoon;',
  classic(join(ui, 'src', 'web', 'engine.ts')),
  classic(join(ui, 'src', 'web', 'worker.ts')),
  'startWorker(self);',
].join('\n;\n');
const engineBundle = bundle();
const parts = {
  worker: Buffer.from(workerSource, 'utf8'),
  wasm: readFileSync(join(wasmoonDir, 'glue.wasm')),
  bundle: Buffer.from(JSON.stringify(engineBundle), 'utf8'),
  shim: readFileSync(join(ui, 'src', 'web', 'vim-shim.lua')),
  vault: Buffer.from(JSON.stringify(vaultFiles(fixture)), 'utf8'),
};
const sizes = Object.fromEntries(Object.entries(parts).map(([k, v]) => [k, v.length]));

const src = readFileSync(join(here, 'engine-page.src.html'), 'utf8');
let html = src
  .replaceAll('__BUILD__', commit())
  .replace('__ENGINE__', `tasks.nvim ${engineBundle.lock.commit.slice(0, 7)}, lib.nvim ${engineBundle.lock.lib_commit.slice(0, 7)}`)
  .replace('__SIZES__', JSON.stringify(sizes));
for (const [name, data] of Object.entries(parts)) html = html.replace(`__${name.toUpperCase()}_GZ__`, gz(data));

const problems = [];
if (!/<meta http-equiv="Content-Security-Policy"[^>]*connect-src 'none'/.test(html)) problems.push('CSP meta missing');
if (/<(script|link|img|iframe)\b[^>]*\s(src|href)=/i.test(html)) problems.push('an element loads a file');
if (/__[A-Z_]+__/.test(html)) problems.push('a placeholder is left: ' + html.match(/__[A-Z_]+__/)[0]);
const urls = (html.match(/\b(?:https?|wss?):\/\/[^\s"'<>]+/g) ?? []).filter((u) => !u.startsWith('https://example.invalid/'));
if (urls.length) problems.push('a URL in the page: ' + urls.join(', '));
if (problems.length) {
  for (const p of problems) console.error('engine-page: ' + p);
  process.exit(1);
}
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, html);
console.log(`${createHash('sha256').update(html).digest('hex')}  ${out} (${html.length} bytes; parts ${JSON.stringify(sizes)})`);
