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
import { verify as verifyPage } from 'appkit-web/pack';

const here = dirname(fileURLToPath(import.meta.url));
const FILLER_BYTES = 384 * 1024; // about 512 KiB of base64

/**
 * What keeps a built page from being one that loads nothing and reaches no network; empty when it is fine. The check
 * is the kit's (appkit-web/pack); the probe's pages may name the one address of its test of a blocked request.
 */
export function verify(html, { allowUrls = ['https://example.invalid/'] } = {}) {
  return verifyPage(html, { allowUrls });
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
