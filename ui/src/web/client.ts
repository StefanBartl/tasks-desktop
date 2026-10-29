// The page's side of the worker (worker.ts): one request, one answer, matched by an id. The page awaits `init`, hands
// the vault over with `mount`, asks the engine with `call`, and asks what it changed with `changes`.
//
// `createBrowserHub` joins this to the hub of the web variant (hub.ts): the routes of the Rust hub, answered by the
// engine in the worker over the vault that was mounted.

import type { CallResult, EngineBundle } from './engine.ts';
import { createWebHub, type DataClass, type WebHub } from './hub.ts';
import type { VaultChanges } from './vault-files.ts';
import type { WorkerReply, WorkerRequest } from './worker.ts';

/** What the client needs of a `Worker`; a test passes a pair of plain objects. */
export interface PortLike {
  postMessage(message: WorkerRequest): void;
  onmessage: ((event: { data: WorkerReply }) => void) | null;
}

interface Pending {
  resolve(reply: WorkerReply): void;
  reject(error: Error): void;
}

export class WorkerClient {
  // Plain fields, no parameter properties: Node runs this file by stripping the types, without a build.
  private readonly port: PortLike;
  private readonly pending = new Map<number, Pending>();
  private starting: Pending | null = null;
  private next = 1;
  private closed = false;
  /** Log lines of the engine (vim.notify, errors of scheduled callbacks). */
  onLog: (level: number, message: string) => void = () => {};

  constructor(port: PortLike) {
    this.port = port;
    port.onmessage = (event) => this.receive(event.data);
  }

  private receive(reply: WorkerReply): void {
    if (reply.type === 'log') {
      this.onLog(reply.level, reply.message);
      return;
    }
    if (reply.type === 'ready') {
      this.starting?.resolve(reply);
      this.starting = null;
      return;
    }
    if (reply.type === 'error' && reply.id === undefined) {
      // No id: it is the answer to `init` (or something the worker could not attribute).
      if (this.starting) {
        this.starting.reject(new Error(reply.message));
        this.starting = null;
      } else {
        this.onLog(3, reply.message);
      }
      return;
    }
    const id = (reply as { id?: number }).id;
    const waiting = id === undefined ? undefined : this.pending.get(id);
    if (!waiting || id === undefined) return;
    this.pending.delete(id);
    if (reply.type === 'error') waiting.reject(new Error(reply.message));
    else waiting.resolve(reply);
  }

  private ask(build: (id: number) => WorkerRequest): Promise<WorkerReply> {
    if (this.closed) return Promise.reject(new Error('the worker is closed'));
    const id = this.next++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.port.postMessage(build(id));
    });
  }

  /** Start the engine in the worker. Resolves with the milliseconds it took. */
  init(opts: { wasm: ArrayBuffer; bundle: EngineBundle; shim: string }): Promise<number> {
    if (this.closed) return Promise.reject(new Error('the worker is closed'));
    if (this.starting) return Promise.reject(new Error('the engine is already starting'));
    return new Promise((resolve, reject) => {
      this.starting = {
        resolve: (reply) => resolve(reply.type === 'ready' ? reply.ms : 0),
        reject,
      };
      this.port.postMessage({ type: 'init', ...opts });
    });
  }

  /** Put a vault into the VM at `root`, replacing what was there. Resolves with the number of files. */
  async mount(root: string, files: Map<string, Uint8Array> | Record<string, Uint8Array>): Promise<number> {
    const record = files instanceof Map ? Object.fromEntries(files) : files;
    const reply = await this.ask((id) => ({ type: 'mount', id, root, files: record }));
    return reply.type === 'mounted' ? reply.files : 0;
  }

  /** One method of the engine over the vault at `root`. A refusal of the engine is a result with a `code`, not a throw. */
  async call(method: string, request: string | null, opts: { root: string; today?: string }): Promise<CallResult> {
    const reply = await this.ask((id) => ({ type: 'call', id, method, request, root: opts.root, today: opts.today }));
    if (reply.type !== 'result') throw new Error(`unexpected reply ${reply.type}`);
    return { text: reply.text, code: reply.code };
  }

  /** What the engine changed in the mounted vault since the mount (or since the last write-back). */
  async changes(): Promise<VaultChanges> {
    const reply = await this.ask((id) => ({ type: 'changes', id }));
    if (reply.type !== 'changes') throw new Error(`unexpected reply ${reply.type}`);
    return reply.changes;
  }

  /** Reject everything that waits, and ask nothing more. */
  close(): void {
    this.closed = true;
    const gone = new Error('the worker is closed');
    for (const waiting of this.pending.values()) waiting.reject(gone);
    this.pending.clear();
    this.starting?.reject(gone);
    this.starting = null;
    this.port.onmessage = null;
  }
}

export interface BrowserHubOptions {
  /** Where the vault lies in the VM, as given to `mount`. */
  root: string;
  version: string;
  build: string | null;
  pinned: { engine: string | null; lib: string | null };
  classes?: (area: string) => DataClass;
  rescan?: () => Promise<void>;
}

/** The hub of the page: the routes of the Rust hub over the engine in the worker. */
export function createBrowserHub(client: WorkerClient, opts: BrowserHubOptions): WebHub {
  return createWebHub({
    call: (method, request) => client.call(method, request, { root: opts.root }),
    version: opts.version,
    build: opts.build,
    pinned: opts.pinned,
    classes: opts.classes,
    rescan: opts.rescan,
  });
}
