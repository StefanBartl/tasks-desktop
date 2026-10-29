// The parts the single-file page carries inside itself: the worker's script, the WASM of the Lua VM, the Lua sources of
// the engine and the vim shim. Each is gzip-compressed and base64-encoded in a `<script type="application/octet-stream">`
// of the page (never fetched: the CSP forbids every request) and unpacked here.

import type { EngineBundle } from './engine.ts';

export interface Parts {
  /** The classic script of the worker (engine, worker, VM loader). */
  worker: string;
  wasm: ArrayBuffer;
  bundle: EngineBundle;
  shim: string;
}

/** The ids of the elements that hold the parts. */
export const PART_IDS = ['worker', 'wasm', 'bundle', 'shim'] as const;

/** gzip + base64 -> bytes. `atob` ignores the line breaks the packer puts into the text. */
export async function unpack(base64: string): Promise<Uint8Array<ArrayBuffer>> {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/**
 * Unpack the four parts. `read(id)` gives the text of the element `id`, or null when it is not there. A missing part is
 * an error that names it: the page cannot start without any of them.
 */
export async function loadParts(read: (id: string) => string | null): Promise<Parts> {
  const raw = (id: string): string => {
    const text = read(id);
    if (text === null || text.trim() === '') throw new Error(`the page lacks its part "${id}"`);
    return text;
  };
  const decoder = new TextDecoder();
  // The text of each part is read (and a missing one named) before any of them is unpacked.
  const text = { worker: raw('worker'), wasm: raw('wasm'), bundle: raw('bundle'), shim: raw('shim') };
  const [worker, wasm, bundle, shim] = await Promise.all([
    unpack(text.worker),
    unpack(text.wasm),
    unpack(text.bundle),
    unpack(text.shim),
  ]);
  const parsed: unknown = JSON.parse(decoder.decode(bundle));
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    typeof (parsed as { modules?: unknown }).modules !== 'object' ||
    typeof (parsed as { engine?: { commit?: unknown } }).engine?.commit !== 'string'
  ) {
    throw new Error('the part "bundle" is not an engine bundle');
  }
  return {
    worker: decoder.decode(worker),
    wasm: wasm.buffer,
    bundle: parsed as EngineBundle,
    shim: decoder.decode(shim),
  };
}

/** What `startBlobWorker` needs of the browser. */
export interface WorkerHost {
  Blob: typeof Blob;
  URL: Pick<typeof URL, 'createObjectURL'>;
  Worker: new (url: string, options?: { type?: 'classic' | 'module' }) => Worker;
}

/**
 * The worker, started from a blob. A classic one: a module worker from a blob does not start on a page opened from disk
 * (probe 2026-10-28). The address of the blob stays: the browser fetches the script after the constructor returns.
 */
export function startBlobWorker(source: string, host: WorkerHost): Worker {
  const url = host.URL.createObjectURL(new host.Blob([source], { type: 'text/javascript' }));
  return new host.Worker(url, { type: 'classic' });
}
