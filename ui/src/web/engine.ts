// The tasks.nvim engine in a Lua VM (wasmoon, Lua 5.4) for the web variant: the same documents as
// `nvim --headless -l scripts/tasks.lua call <method>`, without Neovim and without a server.
//
// Nothing here knows where it runs. The caller hands in the VM factory (in the browser one whose WASM comes from the
// page itself, see worker.ts; in a Node test the stock one), the Lua sources (web/engine-bundle.mjs) and the vim shim
// (vim-shim.lua), and fills the in-memory file system of the VM with the vault. The engine only ever sees that file
// system: a path is a path inside the VM, never one of the machine.

import type { LuaEngine, LuaFactory } from 'wasmoon';

export interface EngineBundle {
  engine: { commit: string; lib_commit: string };
  modules: Record<string, string>;
}

/** The answer of one call: the canonical bytes of one document, and the error code when it is a `tasks.error`. */
export interface CallResult {
  text: string;
  code: string | null;
}

export interface WebEngineOptions {
  factory: LuaFactory;
  bundle: EngineBundle;
  shim: string;
  /** Environment the engine reads through `vim.env` (`TASKS_VAULT` is not needed: the root goes with every call). */
  env?: Record<string, string>;
  /** Where log lines of the engine go (vim.notify, errors of scheduled callbacks). */
  log?: (level: number, message: string) => void;
  /** The clock in milliseconds; a test fixes it. */
  now?: () => number;
}

/** The part of Emscripten's FS the bridge needs (wasmoon's build exports no `isDir` and no `mkdirTree`). */
interface MemFs {
  stat(path: string): { mode: number; size: number; mtime: Date };
  readdir(path: string): string[];
  mkdir(path: string): void;
  rmdir(path: string): void;
  unlink(path: string): void;
  writeFile(path: string, data: string | Uint8Array): void;
  readFile(path: string, opts: { encoding: 'utf8' }): string;
}

const HOME = '/home/web';

const S_IFMT = 0o170000;
const isDir = (mode: number) => (mode & S_IFMT) === 0o040000;
const isFile = (mode: number) => (mode & S_IFMT) === 0o100000;

function mkdirTree(fs: MemFs, path: string): void {
  let at = '';
  for (const part of path.split('/').filter(Boolean)) {
    at += `/${part}`;
    try {
      fs.mkdir(at);
    } catch {
      if (!isDir(fs.stat(at).mode)) throw new Error(`not a folder: ${at}`);
    }
  }
}

export class WebEngine {
  // Plain fields, no parameter properties: Node runs this file by stripping the types, without a build.
  private readonly lua: LuaEngine;
  // Taken once: every `global.get` makes a new JS wrapper with its own reference into the Lua registry.
  private readonly door: (method: string, request: string, root: string, today: string) => string;
  readonly fs: MemFs;
  readonly bundle: EngineBundle;

  private constructor(lua: LuaEngine, fs: MemFs, bundle: EngineBundle) {
    this.lua = lua;
    this.door = lua.global.get('__web_call');
    this.fs = fs;
    this.bundle = bundle;
  }

  static async create(opts: WebEngineOptions): Promise<WebEngine> {
    const wasm = await opts.factory.getLuaModule();
    const fs = wasm.module.FS as unknown as MemFs;
    const lua = await opts.factory.createEngine({ openStandardLibs: true, injectObjects: false, enableProxy: false });
    const env: Record<string, string> = { HOME, ...(opts.env ?? {}) };
    const log = opts.log ?? (() => {});
    const now = opts.now ?? (() => Date.now());
    const names = Object.keys(opts.bundle.modules).sort().join('\n');
    // Every answer to Lua is a string, a boolean or undefined (nil): numbers and tables would depend on how wasmoon
    // converts them (an integer or a float), the shim parses what it needs. Never null: wasmoon looks for a `.then` on
    // every object it gets back, and `typeof null` is 'object'.
    lua.global.set('__web', {
      module_names: () => names,
      source: (name: string) => opts.bundle.modules[name],
      env: (name: string) => env[name],
      set_env: (name: string, value: string | null) => {
        if (value === null || value === undefined) delete env[name];
        else env[name] = String(value);
      },
      home: () => HOME,
      now_ms: () => String(now()),
      log: (level: number, message: string) => log(Number(level), String(message)),
      stat: (path: string) => {
        try {
          const st = fs.stat(path);
          const kind = isDir(st.mode) ? 'directory' : isFile(st.mode) ? 'file' : 'other';
          const ms = st.mtime.getTime();
          return `${kind} ${st.size} ${Math.floor(ms / 1000)} ${(ms % 1000) * 1_000_000}`;
        } catch {
          return undefined;
        }
      },
      // JSON, not a separated list: a name may hold a tab or a newline on the system the folder comes from.
      readdir: (path: string) => {
        try {
          return JSON.stringify(
            fs
              .readdir(path)
              .filter((n) => n !== '.' && n !== '..')
              .map((n) => [n, isDir(fs.stat(`${path}/${n}`).mode) ? 'directory' : 'file']),
          );
        } catch {
          return undefined;
        }
      },
      mkdir: (path: string, parents: boolean) => {
        try {
          if (parents) mkdirTree(fs, path);
          else fs.mkdir(path);
          return true;
        } catch {
          return false;
        }
      },
      rmdir: (path: string, recursive: boolean) => {
        try {
          if (recursive) removeTree(fs, path);
          else fs.rmdir(path);
          return true;
        } catch {
          return false;
        }
      },
    });
    lua.doStringSync(opts.shim);
    return new WebEngine(lua, fs, opts.bundle);
  }

  /** Put files into the VM's file system: path inside the VM -> content. Folders are made as needed. */
  mount(files: Record<string, string | Uint8Array>): void {
    for (const [path, content] of Object.entries(files)) {
      const dir = path.slice(0, path.lastIndexOf('/'));
      if (dir) mkdirTree(this.fs, dir);
      this.fs.writeFile(path, content);
    }
  }

  /**
   * One method of the contract, as `tasks call <method> --params=<json>` would answer it. `request` is the JSON of the
   * whole request (`{"params": {...}}`, for `ops` the fields at the top), or empty.
   */
  call(method: string, request: string | null, opts: { root: string; today?: string }): CallResult {
    const raw = String(this.door(method, request ?? '', opts.root, opts.today ?? ''));
    const nl = raw.indexOf('\n');
    const code = raw.slice(0, nl);
    return { text: raw.slice(nl + 1), code: code === '' ? null : code };
  }

  close(): void {
    this.lua.global.close();
  }
}

function removeTree(fs: MemFs, path: string): void {
  for (const name of fs.readdir(path)) {
    if (name === '.' || name === '..') continue;
    const child = `${path}/${name}`;
    if (isDir(fs.stat(child).mode)) removeTree(fs, child);
    else fs.unlink(child);
  }
  fs.rmdir(path);
}
