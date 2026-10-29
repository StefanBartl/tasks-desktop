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

type FromBase64 = (text: string) => Uint8Array<ArrayBuffer>;

/** `Uint8Array.fromBase64` where the browser has it (Chrome 140 and later), else null. */
const nativeFromBase64 = (Uint8Array as unknown as { fromBase64?: FromBase64 }).fromBase64 ?? null;

/** base64 -> bytes through `atob`: a string of one character per byte, copied over byte by byte. */
export function base64ByAtob(text: string): Uint8Array<ArrayBuffer> {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/**
 * base64 -> bytes: `Uint8Array.fromBase64` where there is one (no string in between, no loop), else `atob`. Both skip
 * the line breaks the packer puts into the text and give the same bytes; `fromBase64` refuses a text that is no base64
 * as `atob` does. `fromBase64` is for a test: null takes the way of a browser without it.
 */
export function base64Bytes(text: string, fromBase64: FromBase64 | null = nativeFromBase64): Uint8Array<ArrayBuffer> {
  return fromBase64 ? fromBase64(text) : base64ByAtob(text);
}

/**
 * gzip -> bytes. The bytes go into the decompression as the one chunk of a stream made here: a `Blob` around them would
 * be one more copy, and in Chrome its stream is read back from the browser's blob store piece by piece.
 */
export async function gunzip(bytes: Uint8Array<ArrayBuffer>): Promise<Uint8Array<ArrayBuffer>> {
  const source = new ReadableStream<Uint8Array<ArrayBuffer>>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
  return new Uint8Array(await new Response(source.pipeThrough(new DecompressionStream('gzip'))).arrayBuffer());
}

/** gzip + base64 -> bytes. */
export function unpack(base64: string): Promise<Uint8Array<ArrayBuffer>> {
  return gunzip(base64Bytes(base64));
}

/**
 * Unpack the four parts. `read(id)` gives the text of the element `id`, or null when it is not there. A missing part is
 * an error that names it: the page cannot start without any of them.
 */
export async function loadParts(read: (id: string) => string | null): Promise<Parts> {
  const raw = (id: string): string => {
    const text = read(id);
    // A look for the first character that is not white space; `trim()` would make another string of the whole part.
    if (text === null || !/\S/.test(text)) throw new Error(`the page lacks its part "${id}"`);
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
