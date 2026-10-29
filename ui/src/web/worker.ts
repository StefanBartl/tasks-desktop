// The worker of the web variant: the engine (engine.ts) runs here, off the page's thread.
//
// A classic worker started from a blob, never `type: module`: a module worker from a blob does not start on a page
// opened from disk (`file://`, probe 2026-10-28), a classic one does. The page hands in everything at `init`: the WASM
// of the VM, the Lua sources and the vim shim, so the worker never loads a file and never asks the network.
//
// The VM's loader asks `fetch` for its WASM. For the one address WASM_URL this worker answers from the bytes it got;
// every other request goes to the real `fetch`, which the page's CSP (`connect-src 'none'`) refuses.

import { LuaFactory } from 'wasmoon';
import { WebEngine, type EngineBundle } from './engine.ts';
import { safeName, VaultMount, type VaultChanges } from './vault-files.ts';

export const WASM_URL = 'embedded:glue.wasm';

export type WorkerRequest =
  /** `files` (path inside the VM -> text) is for the check page; a vault comes with `mount`. */
  | { type: 'init'; wasm: ArrayBuffer; bundle: EngineBundle; shim: string; files?: Record<string, string> }
  /** Replace the vault at `root` (an absolute folder inside the VM) with `files` (path relative to it -> bytes). */
  | { type: 'mount'; id: number; root: string; files: Record<string, Uint8Array> }
  | { type: 'changes'; id: number }
  /** What the engine changed, with the bytes of every file it added or changed (the write-back writes them). */
  | { type: 'pending'; id: number }
  /** The page wrote exactly these changes to the folder: they are the loaded state now, others stay pending. */
  | { type: 'accept'; id: number; changes: VaultChanges }
  | { type: 'call'; id: number; method: string; request: string | null; root: string; today?: string };

export type WorkerReply =
  | { type: 'ready'; ms: number }
  | { type: 'result'; id: number; text: string; code: string | null; ms: number }
  | { type: 'mounted'; id: number; files: number; ms: number }
  | { type: 'changes'; id: number; changes: VaultChanges }
  | { type: 'pending'; id: number; changes: VaultChanges; files: Record<string, Uint8Array> }
  | { type: 'accepted'; id: number }
  | { type: 'log'; level: number; message: string }
  | { type: 'error'; id?: number; message: string };

/** Let `fetch(WASM_URL)` answer with `bytes`, without a request. */
export function serveEmbeddedWasm(scope: { fetch: typeof fetch }, bytes: ArrayBuffer): void {
  const real = scope.fetch.bind(scope);
  scope.fetch = (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url === WASM_URL) {
      return Promise.resolve(new Response(bytes, { headers: { 'Content-Type': 'application/wasm' } }));
    }
    return real(input, init);
  };
}

type Scope = {
  fetch: typeof fetch;
  postMessage(message: WorkerReply): void;
  onmessage: ((event: MessageEvent<WorkerRequest>) => void) | null;
};

export interface WorkerOptions {
  /** The VM factory. The default loads the WASM from the bytes of `init`; a test in Node passes the stock one. */
  factory?: () => LuaFactory;
}

/** A relative path of the vault: plain segments only, so a name from a folder never leaves the vault's root. */
function plainPath(path: string): boolean {
  return path !== '' && path.split('/').every((segment) => safeName(segment));
}

export function startWorker(scope: Scope, options: WorkerOptions = {}): void {
  let engine: Promise<WebEngine> | null = null;
  let vault: VaultMount | null = null;
  const post = (reply: WorkerReply) => scope.postMessage(reply);

  scope.onmessage = async (event) => {
    const msg = event.data;
    if (msg.type === 'init') {
      // One engine per worker: a second init would wrap `fetch` again and start a second VM beside the first.
      if (engine) {
        post({ type: 'error', message: 'the engine is already started (one init per worker)' });
        return;
      }
      const t0 = performance.now();
      serveEmbeddedWasm(scope, msg.wasm);
      engine = WebEngine.create({
        factory: options.factory ? options.factory() : new LuaFactory(WASM_URL),
        bundle: msg.bundle,
        shim: msg.shim,
        log: (level, message) => post({ type: 'log', level, message }),
      }).then((e) => {
        if (msg.files) e.mount(msg.files);
        return e;
      });
      try {
        await engine;
        post({ type: 'ready', ms: Math.round(performance.now() - t0) });
      } catch (err) {
        post({ type: 'error', message: String(err) });
      }
      return;
    }
    if (msg.type === 'mount' || msg.type === 'changes' || msg.type === 'pending' || msg.type === 'accept') {
      if (!engine) {
        post({ type: 'error', id: msg.id, message: 'the engine is not started (init first)' });
        return;
      }
      try {
        const e = await engine;
        if (msg.type === 'mount') {
          const t0 = performance.now();
          const bad = Object.keys(msg.files).find((path) => !plainPath(path));
          if (bad !== undefined) throw new Error(`not a plain path inside the vault: ${JSON.stringify(bad)}`);
          // A new mount replaces the vault of the old root too: two vaults never lie in the VM side by side.
          // The new mount is made first: a root that is refused must leave the vault that is there as it is.
          const next = new VaultMount(e.fs, msg.root);
          if (vault && vault.root !== msg.root) vault.load(new Map());
          next.load(new Map(Object.entries(msg.files)));
          vault = next;
          post({ type: 'mounted', id: msg.id, files: Object.keys(msg.files).length, ms: Math.round(performance.now() - t0) });
        } else if (msg.type === 'changes') {
          if (!vault) throw new Error('no vault is mounted');
          post({ type: 'changes', id: msg.id, changes: vault.changes() });
        } else if (msg.type === 'pending') {
          if (!vault) throw new Error('no vault is mounted');
          const changes = vault.changes();
          const files: Record<string, Uint8Array> = {};
          for (const rel of [...changes.added, ...changes.modified]) {
            const bytes = vault.read(rel);
            if (!bytes) throw new Error(`a changed file is gone from the VM: ${JSON.stringify(rel)}`);
            files[rel] = bytes;
          }
          post({ type: 'pending', id: msg.id, changes, files });
        } else {
          if (!vault) throw new Error('no vault is mounted');
          const listed = [...msg.changes.added, ...msg.changes.modified, ...msg.changes.removed];
          const bad = listed.find((path) => !plainPath(path));
          if (bad !== undefined) throw new Error(`not a plain path inside the vault: ${JSON.stringify(bad)}`);
          vault.accept(msg.changes);
          post({ type: 'accepted', id: msg.id });
        }
      } catch (err) {
        post({ type: 'error', id: msg.id, message: String(err) });
      }
      return;
    }
    if (msg.type === 'call') {
      if (!engine) {
        post({ type: 'error', id: msg.id, message: 'the engine is not started (init first)' });
        return;
      }
      try {
        const e = await engine;
        const t0 = performance.now();
        const r = e.call(msg.method, msg.request, { root: msg.root, today: msg.today });
        post({ type: 'result', id: msg.id, text: r.text, code: r.code, ms: Math.round(performance.now() - t0) });
      } catch (err) {
        post({ type: 'error', id: msg.id, message: String(err) });
      }
    }
  };
}
