// The script of the engine's worker as one classic script: the VM loader (wasmoon is a UMD bundle that sets
// `self.wasmoon` in a classic worker), then the modules of src/web it needs, types stripped, imports dropped. The
// order is the order of their imports: a module comes after those it uses. Shared by the single-file page
// (web/pack.mjs) and the engine check page (web/engine-page.mjs).

import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripTypeScriptTypes } from 'node:module';

const here = dirname(fileURLToPath(import.meta.url));
export const ui = resolve(here, '..');

/**
 * A module of src/web as a classic script: types stripped, imports dropped (also those over several lines), `export`
 * removed. Refuses what it cannot turn into one.
 */
export function classic(ts) {
  const js = stripTypeScriptTypes(ts, { mode: 'strip' });
  // a re-export needs a module system; a classic script has none
  if (/^\s*export\s*\*/m.test(js)) throw new Error('classic: a re-export (export * from) is left');
  const out = js
    .replace(/^[ \t]*import\b[\s\S]*?(['"])[^'"\n]+\1[ \t]*;?/gm, '')
    .replace(/^[ \t]*export\s*\{[^}]*\}[^;\n]*;?/gm, '')
    .replace(/^([ \t]*)export\s+(?:default\s+)?/gm, '$1');
  if (/^\s*(?:import|export)\b/m.test(out)) throw new Error('classic: an import or export is left');
  return out;
}

/** The modules of the worker, in order. */
export const WORKER_MODULES = ['engine.ts', 'vault-files.ts', 'worker.ts'];

export function workerSource() {
  const wasmoonDir = join(ui, 'node_modules', 'wasmoon', 'dist');
  const src = (file) => readFileSync(join(ui, 'src', 'web', file), 'utf8');
  return [
    readFileSync(join(wasmoonDir, 'index.js'), 'utf8'),
    'const { LuaFactory } = self.wasmoon;',
    ...WORKER_MODULES.map((file) => classic(src(file))),
    'startWorker(self);',
  ].join('\n;\n');
}

/** The WASM of the VM. */
export function wasmBytes() {
  return readFileSync(join(ui, 'node_modules', 'wasmoon', 'dist', 'glue.wasm'));
}
