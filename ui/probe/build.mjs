// Builds the workstation probe of the web variant: one HTML file that runs from file:// without a server.
//
//   node probe/build.mjs [--out=<file>]        (from ui/; default probe/dist/probe.html)
//
// The source page carries everything but the filler: a block of base64 the size of the later Lua VM, so that the
// probe also shows whether a scanner on the workstation objects to a large HTML file with embedded data. The filler
// is deterministic, so the same commit gives the same file and the same SHA-256. The build refuses a page that could
// reach the network or load anything from outside (`verify`, shared with web/engine-page.mjs).

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const FILLER_BYTES = 384 * 1024; // about 512 KiB of base64

// Every attribute that makes the browser fetch something, on any element (<a href>, <object data>, <base href>,
// <form action>, <video poster>, <img srcset>, ...): the page loads nothing, so none may be there.
const LOADING_ATTRIBUTE = /<[a-z][a-z0-9-]*\b[^>]*\s(src|href|data|action|formaction|poster|srcset|ping|background)\s*=/i;

/** What keeps a built page from being one that loads nothing and reaches no network; empty when it is fine. */
export function verify(html, { allowUrls = ['https://example.invalid/'] } = {}) {
  const problems = [];
  if (!/<meta http-equiv="Content-Security-Policy"[^>]*connect-src 'none'/.test(html)) {
    problems.push("the CSP meta with connect-src 'none' is missing");
  }
  const loading = html.match(LOADING_ATTRIBUTE);
  if (loading) problems.push(`an element loads a file (${loading[1]}=)`);
  if (/<meta[^>]*http-equiv=["']?refresh/i.test(html)) problems.push('a meta refresh');
  const urls = html.match(/\b(?:https?|wss?|ftp):\/\/[^\s"'<>]+/g) ?? [];
  const foreign = urls.filter((u) => !allowUrls.includes(u));
  if (foreign.length > 0) problems.push('a URL in the page: ' + foreign.join(', '));
  const placeholder = html.match(/__[A-Z][A-Z_]*__/);
  if (placeholder) problems.push('a placeholder is left: ' + placeholder[0]);
  return problems;
}

function build() {
  try {
    return execFileSync('git', ['-C', here, 'rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim();
  } catch {
    return 'unknown';
  }
}

// xorshift32 from a fixed seed: incompressible enough to look like a VM, the same on every run.
function filler(n) {
  const bytes = new Uint8Array(n);
  let x = 0x2545f491;
  for (let i = 0; i < n; i++) {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    bytes[i] = x & 0xff;
  }
  return Buffer.from(bytes).toString('base64').replace(/.{1,120}/g, '$&\n');
}

function verifyProbe(html) {
  const problems = verify(html);
  const wasm = html.match(/const WASM = new Uint8Array\(\[([^\]]*)\]\)/);
  if (!wasm) problems.push('the WASM bytes are missing');
  else {
    const bytes = new Uint8Array(wasm[1].split(',').map((s) => s.trim()).filter(Boolean).map(Number));
    if (!WebAssembly.validate(bytes)) problems.push('the WASM bytes are no valid module');
  }
  return problems;
}

function main() {
  const outArg = process.argv.find((a) => a.startsWith('--out='));
  const out = resolve(outArg ? outArg.slice('--out='.length) : join(here, 'dist', 'probe.html'));
  const src = readFileSync(join(here, 'probe.src.html'), 'utf8');
  const html = src.replaceAll('__BUILD__', build()).replace('__FILLER_B64__', () => filler(FILLER_BYTES));
  const problems = verifyProbe(html);
  if (problems.length > 0) {
    for (const p of problems) console.error('probe: ' + p);
    process.exit(1);
  }
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, html);
  const sha = createHash('sha256').update(html).digest('hex');
  console.log(`${sha}  ${out} (${html.length} bytes)`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
