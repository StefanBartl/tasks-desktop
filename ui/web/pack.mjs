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
// The build refuses a file whose shell loads anything: an element with a src or a href, a script that is not inline, a
// URL, a refresh, a missing policy or a missing part. What the compiled script does at run time is checked by the
// browser test (e2e-web/), which opens the file and counts the requests.

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { verify } from '../probe/build.mjs';
import { bundle } from './engine-bundle.mjs';
import { bundleJson } from './engine-page.mjs';
import { ui, wasmBytes, workerSource } from './worker-source.mjs';

/** Nothing may leave the page: no request of any kind; scripts and styles only inline; workers only from blob:. */
export const CSP = [
  "default-src 'none'",
  "script-src 'unsafe-inline' 'wasm-unsafe-eval'",
  "style-src 'unsafe-inline'",
  'img-src data: blob:',
  'worker-src blob:',
  "connect-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join('; ');

export const PART_IDS = ['worker', 'wasm', 'bundle', 'shim'];

const gz = (data) => gzipSync(data, { level: 9 }).toString('base64').replace(/.{1,120}/g, '$&\n');

/** Text as the content of an inline script: `</script` and `<!--` would end it or start a comment. */
export function inlineScript(js) {
  // The case of the word is kept: a string "</SCRIPT>" must still be that string once the browser has read it.
  return js.replace(/<\/(script)/gi, (_, word) => `<\\/${word}`).replace(/<!--/g, '<\\!--');
}

/** Text as the content of an inline style; a `</style` cannot be written there, so it is refused. */
export function inlineStyle(css) {
  if (/<\/style/i.test(css)) throw new Error('pack: the style holds "</style"');
  return css;
}

/** The single file. `parts` maps each id of PART_IDS to its bytes. */
export function assemble({ css, js, parts, build }) {
  const missing = PART_IDS.filter((id) => !(parts[id] instanceof Uint8Array) && !Buffer.isBuffer(parts[id]));
  if (missing.length) throw new Error('pack: parts missing: ' + missing.join(', '));
  const blocks = PART_IDS.map((id) => `<script id="${id}" type="application/octet-stream">${gz(parts[id])}</script>`).join('\n');
  return [
    '<!doctype html>',
    '<html lang="en">',
    '<head>',
    '<meta charset="utf-8">',
    `<meta http-equiv="Content-Security-Policy" content="${CSP}">`,
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<meta name="referrer" content="no-referrer">',
    '<meta name="color-scheme" content="light dark">',
    '<title>tasks</title>',
    `<!-- tasks-desktop web variant, build ${build} -->`,
    `<style>${inlineStyle(css)}</style>`,
    '</head>',
    '<body>',
    '<div id="app"></div>',
    blocks,
    `<script type="module">${inlineScript(js)}</script>`,
    '</body>',
    '</html>',
    '',
  ].join('\n');
}

/** What the page without the contents of its scripts and styles may not hold; empty when it is fine. */
export function verifyShell(html) {
  const shell = html
    .replace(/(<script\b[^>]*>)[\s\S]*?(<\/script>)/gi, '$1$2')
    .replace(/(<style\b[^>]*>)[\s\S]*?(<\/style>)/gi, '$1$2');
  const problems = verify(shell, { allowUrls: [] });
  for (const id of PART_IDS) {
    if (!new RegExp(`<script id="${id}" type="application/octet-stream">`).test(shell)) problems.push(`the part "${id}" is missing`);
  }
  const modules = shell.match(/<script type="module">/g) ?? [];
  if (modules.length !== 1) problems.push(`expected one inline module script, found ${modules.length}`);
  const plain = shell.match(/<script\b(?![^>]*\b(?:id="(?:worker|wasm|bundle|shim)"|type="module")[^>]*>)[^>]*>/gi);
  if (plain) problems.push('a script that is neither a part nor the module: ' + plain[0]);
  return problems;
}

/** The script and the style `vite build --mode web` made, found through its index. */
export function readDist(dist) {
  const index = readFileSync(join(dist, 'index.web.html'), 'utf8');
  const scripts = [...index.matchAll(/<script\b[^>]*\btype="module"[^>]*\bsrc="([^"]+)"/g)].map((m) => m[1]);
  const styles = [...index.matchAll(/<link\b[^>]*\brel="stylesheet"[^>]*\bhref="([^"]+)"/g)].map((m) => m[1]);
  if (scripts.length !== 1) throw new Error(`pack: expected one script in ${dist}/index.web.html, found ${scripts.length} (is code splitting off?)`);
  if (styles.length !== 1) throw new Error(`pack: expected one style in ${dist}/index.web.html, found ${styles.length}`);
  return {
    js: readFileSync(resolve(dist, scripts[0]), 'utf8'),
    css: readFileSync(resolve(dist, styles[0]), 'utf8'),
  };
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
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, 'tasks.html'), html);
  const sha = createHash('sha256').update(html).digest('hex');
  writeFileSync(join(out, 'SHA256SUMS'), `${sha}  tasks.html\n`);
  console.log(`${sha}  ${join(out, 'tasks.html')} (${html.length} bytes: script ${js.length}, style ${css.length}, parts ${JSON.stringify(Object.fromEntries(Object.entries(parts).map(([k, v]) => [k, v.length])))})`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
