// Packs the page of the web variant into one file.
//
//   pnpm web:build            (= vite build --mode web, then this)
//   node web/pack.mjs [--dist=<folder of vite build --mode web>] [--out=<folder>]    (from ui/)
//
// In:  dist-web/index.web.html with its one script and its one style (vite build --mode web).
// Out: <out>/tasks.html and <out>/SHA256SUMS. Everything is in the file: the script and the style inline, the four
//      parts of the engine (worker, WASM, Lua sources, vim shim) gzip-compressed as base64, and a Content-Security-Policy
//      as a meta tag that forbids every request. The page is opened from disk (file://) and needs no server.
//
// The packing and the check are the kit's (appkit-web/pack); this names what the tasks page carries: its four parts,
// the policy of a page that runs an engine (WASM, a worker from a blob), its title. The build refuses a file whose shell
// loads anything: an element with a src or a href, a script that is not inline, a URL, a refresh, a missing policy or
// a missing part. What the compiled script does at run time is checked by the browser test (e2e-web/), which opens the
// file and counts the requests.

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  assemble as assemblePage,
  CSP_WASM_WORKER,
  readDist as readKitDist,
  verifyShell as verifyKitShell,
  writePage,
} from 'appkit-web/pack';
import { bundle } from './engine-bundle.mjs';
import { bundleJson } from './engine-page.mjs';
import { ui, wasmBytes, workerSource } from './worker-source.mjs';

export { inlineScript, inlineStyle } from 'appkit-web/pack';

/** Nothing may leave the page: no request of any kind; scripts and styles only inline; workers only from blob:. */
export const CSP = CSP_WASM_WORKER;

export const PART_IDS = ['worker', 'wasm', 'bundle', 'shim'];

/** The single file. `parts` maps each id of PART_IDS to its bytes. */
export function assemble({ css, js, parts, build }) {
  return assemblePage({ css, js, partIds: PART_IDS, parts, csp: CSP, title: 'tasks', comment: `tasks-desktop web variant, build ${build}` });
}

/** What the page without the contents of its scripts and styles may not hold; empty when it is fine. */
export function verifyShell(html) {
  return verifyKitShell(html, { partIds: PART_IDS });
}

/** The script and the style `vite build --mode web` made, found through its index. */
export function readDist(dist) {
  return readKitDist(dist, 'index.web.html');
}

function commit() {
  try {
    return execFileSync('git', ['-C', ui, 'rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim();
  } catch {
    return 'unknown';
  }
}

function main() {
  const arg = (name, fallback) => {
    const given = process.argv.find((a) => a.startsWith(`--${name}=`));
    return resolve(given ? given.slice(name.length + 3) : fallback);
  };
  const dist = arg('dist', join(ui, 'dist-web'));
  const out = arg('out', dist);
  const { js, css } = readDist(dist);
  const engineBundle = bundle();
  const shim = readFileSync(join(ui, 'src', 'web', 'vim-shim.lua'));
  const parts = {
    worker: Buffer.from(workerSource(), 'utf8'),
    wasm: wasmBytes(),
    bundle: Buffer.from(bundleJson(engineBundle), 'utf8'),
    shim,
  };
  const html = assemble({ css, js, parts, build: commit() });
  const problems = verifyShell(html);
  if (problems.length) {
    for (const p of problems) console.error('pack: ' + p);
    process.exit(1);
  }
  const sha = writePage(out, 'tasks.html', html);
  console.log(`${sha}  ${join(out, 'tasks.html')} (${html.length} bytes: script ${js.length}, style ${css.length}, parts ${JSON.stringify(Object.fromEntries(Object.entries(parts).map(([k, v]) => [k, v.length])))})`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
