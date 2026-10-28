// The files of a vault folder in the web variant: read from a folder the user picked (File System Access API) into
// plain bytes, put into the in-memory file system of the engine's VM, and compared with that state later to find what
// the engine changed (the list the write-back of step 8 walks).
//
// The folder is the user's, but its names and sizes are untrusted input: a name with a separator, a NUL or a dot
// segment never becomes a path, a file over the cap is skipped and reported, and a folder over the budget is refused
// as a whole -- a vault read only in part would show wrong data without a word.

import { isDir, isFile, mkdirTree, removeTree, type MemFs } from './engine.ts';

/** The part of a `FileSystemFileHandle` the reader uses. */
export interface FileHandleLike {
  kind: 'file';
  name: string;
  getFile(): Promise<{ size: number; arrayBuffer(): Promise<ArrayBuffer> }>;
}

/** The part of a `FileSystemDirectoryHandle` the reader uses. */
export interface DirHandleLike {
  kind: 'directory';
  name: string;
  values(): AsyncIterable<FileHandleLike | DirHandleLike>;
}

export interface LoadLimits {
  maxFiles: number;
  maxFileBytes: number;
  maxTotalBytes: number;
  maxDepth: number;
}

export const DEFAULT_LIMITS: Readonly<LoadLimits> = {
  maxFiles: 20_000,
  maxFileBytes: 4 * 1024 * 1024,
  maxTotalBytes: 256 * 1024 * 1024,
  maxDepth: 32,
};

/** Files at the root of the vault that are read besides the task files (data classes, vault marker). */
export const ROOT_FILES: ReadonlySet<string> = new Set(['areas.json', 'vault.json']);

const SKIPPED_DIRS: ReadonlySet<string> = new Set(['node_modules']);

export interface Skipped {
  path: string;
  reason: 'name' | 'too-large' | 'unreadable';
}

export interface LoadedVault {
  /** Path relative to the vault folder, `/` separated -> bytes. */
  files: Map<string, Uint8Array>;
  skipped: Skipped[];
  totalBytes: number;
}

/** The folder is over a budget (files, total bytes, depth): nothing is returned, because a part would mislead. */
export class VaultLimitError extends Error {
  readonly limit: keyof LoadLimits;

  constructor(limit: keyof LoadLimits, message: string) {
    super(message);
    this.name = 'VaultLimitError';
    this.limit = limit;
  }
}

/** A name that may become one segment of a path inside the VM. */
export function safeName(name: unknown): name is string {
  return (
    typeof name === 'string' &&
    name !== '' &&
    name !== '.' &&
    name !== '..' &&
    name.length <= 255 &&
    !/[/\\\0]/.test(name)
  );
}

/** Whether the reader takes this file: a task file (`.md`) anywhere, a few named files at the root. */
export function wantedFile(name: string, atRoot: boolean): boolean {
  if (name.toLowerCase().endsWith('.md')) return true;
  return atRoot && ROOT_FILES.has(name);
}

/** Whether the reader enters this folder: hidden folders (`.git`, `.obsidian`, ...) and `node_modules` are left out. */
export function wantedDir(name: string): boolean {
  return !name.startsWith('.') && !SKIPPED_DIRS.has(name);
}

/** Read the vault in `root` into memory. Throws `VaultLimitError` when it is over a budget. */
export async function readVaultFolder(root: DirHandleLike, limits: Partial<LoadLimits> = {}): Promise<LoadedVault> {
  const lim = { ...DEFAULT_LIMITS, ...limits };
  const out: LoadedVault = { files: new Map(), skipped: [], totalBytes: 0 };

  async function walk(dir: DirHandleLike, prefix: string, depth: number): Promise<void> {
    if (depth > lim.maxDepth) {
      throw new VaultLimitError('maxDepth', `the folder is nested deeper than ${lim.maxDepth} levels (at ${prefix})`);
    }
    const entries: Array<FileHandleLike | DirHandleLike> = [];
    for await (const entry of dir.values()) entries.push(entry);
    // The same order on every machine: the engine's documents must not depend on the order a file system lists.
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      const path = prefix + entry.name;
      if (!safeName(entry.name)) {
        out.skipped.push({ path, reason: 'name' });
        continue;
      }
      if (entry.kind === 'directory') {
        if (wantedDir(entry.name)) await walk(entry, `${path}/`, depth + 1);
      } else if (entry.kind === 'file' && wantedFile(entry.name, depth === 0)) {
        await take(entry, path);
      }
    }
  }

  async function take(handle: FileHandleLike, path: string): Promise<void> {
    if (out.files.size >= lim.maxFiles) {
      throw new VaultLimitError('maxFiles', `the folder holds more than ${lim.maxFiles} files to read`);
    }
    let bytes: Uint8Array;
    try {
      const file = await handle.getFile();
      if (file.size > lim.maxFileBytes) {
        out.skipped.push({ path, reason: 'too-large' });
        return;
      }
      bytes = new Uint8Array(await file.arrayBuffer());
    } catch {
      out.skipped.push({ path, reason: 'unreadable' });
      return;
    }
    // The size the handle announced is not the size that came: check what is in hand.
    if (bytes.byteLength > lim.maxFileBytes) {
      out.skipped.push({ path, reason: 'too-large' });
      return;
    }
    out.totalBytes += bytes.byteLength;
    if (out.totalBytes > lim.maxTotalBytes) {
      throw new VaultLimitError('maxTotalBytes', `the files to read are larger than ${lim.maxTotalBytes} bytes together`);
    }
    out.files.set(path, bytes);
  }

  await walk(root, '', 0);
  return out;
}

export interface VaultChanges {
  /** Paths relative to the vault root, sorted. */
  added: string[];
  modified: string[];
  removed: string[];
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false;
  for (let i = 0; i < a.byteLength; i++) if (a[i] !== b[i]) return false;
  return true;
}

/**
 * A vault in the VM's file system and the state it was loaded in. `changes()` says what the engine did since:
 * the files to write back, create or delete in the folder on disk.
 */
export class VaultMount {
  // Plain fields, no parameter properties: Node runs this file by stripping the types, without a build.
  readonly fs: MemFs;
  readonly root: string;
  private loaded = new Map<string, Uint8Array>();

  constructor(fs: MemFs, root: string) {
    if (!root.startsWith('/') || root === '/' || root.endsWith('/')) {
      throw new Error(`the vault root must be an absolute folder inside the VM, got ${JSON.stringify(root)}`);
    }
    this.fs = fs;
    this.root = root;
  }

  /** Replace whatever the root holds with `files` (relative path -> bytes) and remember it as the loaded state. */
  load(files: Map<string, Uint8Array>): void {
    if (this.exists(this.root)) removeTree(this.fs, this.root);
    mkdirTree(this.fs, this.root);
    this.loaded = new Map();
    for (const [rel, bytes] of files) {
      const abs = `${this.root}/${rel}`;
      const dir = abs.slice(0, abs.lastIndexOf('/'));
      mkdirTree(this.fs, dir);
      this.fs.writeFile(abs, bytes);
      // A copy: the caller's array and the VM must never be the one place both sides compare against.
      this.loaded.set(rel, bytes.slice());
    }
  }

  /** What the engine changed since the last `load` or `accept`. */
  changes(): VaultChanges {
    const now = this.current();
    const added: string[] = [];
    const modified: string[] = [];
    const removed: string[] = [];
    for (const [rel, bytes] of now) {
      const before = this.loaded.get(rel);
      if (!before) added.push(rel);
      else if (!sameBytes(before, bytes)) modified.push(rel);
    }
    for (const rel of this.loaded.keys()) if (!now.has(rel)) removed.push(rel);
    return { added: added.sort(), modified: modified.sort(), removed: removed.sort() };
  }

  /** The current bytes of a file in the VM (to write it back), or undefined when there is none. */
  read(rel: string): Uint8Array | undefined {
    const abs = `${this.root}/${rel}`;
    try {
      return isFile(this.fs.stat(abs).mode) ? this.fs.readFile(abs) : undefined;
    } catch {
      return undefined;
    }
  }

  /** The current state is now the loaded one: call it after the changes are written to the folder on disk. */
  accept(): void {
    this.loaded = this.current();
  }

  private exists(path: string): boolean {
    try {
      this.fs.stat(path);
      return true;
    } catch {
      return false;
    }
  }

  private current(): Map<string, Uint8Array> {
    const out = new Map<string, Uint8Array>();
    const walk = (abs: string, rel: string) => {
      for (const name of this.fs.readdir(abs)) {
        if (name === '.' || name === '..') continue;
        const child = `${abs}/${name}`;
        const relChild = rel + name;
        if (isDir(this.fs.stat(child).mode)) walk(child, `${relChild}/`);
        else out.set(relChild, this.fs.readFile(child).slice());
      }
    };
    if (this.exists(this.root)) walk(this.root, '');
    return out;
  }
}
