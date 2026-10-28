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

export const WASM_URL = 'embedded:glue.wasm';

export type WorkerRequest =
  | { type: 'init'; wasm: ArrayBuffer; bundle: EngineBundle; shim: string; files: Record<string, string> }
  | { type: 'call'; id: number; method: string; request: string | null; root: string; today?: string };

export type WorkerReply =
  | { type: 'ready'; ms: number }
  | { type: 'result'; id: number; text: string; code: string | null; ms: number }
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

export function startWorker(scope: Scope): void {
  let engine: Promise<WebEngine> | null = null;
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
        factory: new LuaFactory(WASM_URL),
        bundle: msg.bundle,
        shim: msg.shim,
        log: (level, message) => post({ type: 'log', level, message }),
      }).then((e) => {
        e.mount(msg.files);
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
