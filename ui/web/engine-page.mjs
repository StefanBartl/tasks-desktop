// Builds the engine check page of the web variant: one HTML file, opened from disk (file://), that starts the engine in
// a classic worker from a blob and answers the read methods on the synthetic vault of the browser tests.
//
//   node web/engine-page.mjs [--out=<file>]        (from ui/; default web/dist/engine-check.html)
//
// It is the proof of step 1 of the pilot in a real browser, built without vite (whose toolchain brings native binaries):
// the TypeScript of src/web is stripped of its types by Node itself, the imports become globals (wasmoon is a UMD
// bundle and sets `self.wasmoon` in a classic worker). The parts are embedded gzip-compressed as base64 and unpacked by
// the browser (DecompressionStream), so the page also measures what the real page will weigh. The build refuses a page
// that loads a file or names a URL outside the embedded parts (`verify` of probe/build.mjs).

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { verify } from '../probe/build.mjs';
import { bundle } from './engine-bundle.mjs';
import { classic, wasmBytes, workerSource as workerSourceText } from './worker-source.mjs';

export { classic };

const here = dirname(fileURLToPath(import.meta.url));
const ui = resolve(here, '..');
const fixture = resolve(ui, '..', 'e2e', 'fixture', 'vault');

/** The part of a bundle the page needs: the pins and the sources, not the report of the build. */
export function bundleJson(b) {
  return JSON.stringify({ engine: b.engine, modules: b.modules });
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

function main() {
  const outArg = process.argv.find((a) => a.startsWith('--out='));
  const out = resolve(outArg ? outArg.slice('--out='.length) : join(here, 'dist', 'engine-check.html'));
  const src = (file) => readFileSync(join(ui, 'src', 'web', file), 'utf8');
  const workerSource = workerSourceText();
  const engineBundle = bundle();
  const parts = {
    worker: Buffer.from(workerSource, 'utf8'),
    wasm: wasmBytes(),
    bundle: Buffer.from(bundleJson(engineBundle), 'utf8'),
    shim: Buffer.from(src('vim-shim.lua'), 'utf8'),
    vault: Buffer.from(JSON.stringify(vaultFiles(fixture)), 'utf8'),
  };
  const sizes = Object.fromEntries(Object.entries(parts).map(([k, v]) => [k, v.length]));
  const { commit: engineCommit, lib_commit: libCommit } = engineBundle.engine;
  let html = readFileSync(join(here, 'engine-page.src.html'), 'utf8')
    .replaceAll('__BUILD__', commit())
    .replace('__ENGINE__', `tasks.nvim ${engineCommit.slice(0, 7)}, lib.nvim ${libCommit.slice(0, 7)}`)
    .replace('__SIZES__', () => JSON.stringify(sizes))
    .replace('__EMBEDDED_JS__', () => classic(src('embedded.ts')));
  for (const [name, data] of Object.entries(parts)) html = html.replace(`__${name.toUpperCase()}_GZ__`, () => gz(data));
  const problems = verify(html);
  if (problems.length) {
    for (const p of problems) console.error('engine-page: ' + p);
    process.exit(1);
  }
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, html);
  console.log(`${createHash('sha256').update(html).digest('hex')}  ${out} (${html.length} bytes; parts ${JSON.stringify(sizes)})`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
