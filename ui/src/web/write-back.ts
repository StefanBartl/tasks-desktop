// Writing what the engine changed back into the folder the person chose (File System Access API), without ever
// overwriting something the page has not seen.
//
// The engine works on a copy of the vault in the VM's memory. This module takes the list of what it changed (added,
// modified, removed files with their bytes) and applies it to the real folder, in three steps:
//
//   1. Check, write nothing. Every file the change touches is compared with what the page read: a file to change or
//      remove must still have the time, the size and the content it had (the digest of the bytes read), a file to add
//      must not be there. Any difference is a CONFLICT and nothing is written. Paths that are not plain, not a place the
//      reader would have read, or a folder the engine moved away that still holds files this page never saw (the assets
//      of a folder task) are refused, also before any write.
//   2. Write. New files and changed files first, removals last (a failure before the removals leaves the old files).
//      A file is written through `createWritable`, which the browser commits atomically on `close`. Right before each
//      write or removal the file is looked at once more (time and size), and before a new file is made it is looked at
//      that nothing is there; a change found by one of these looks is a CONFLICT too, found late. Any other failure in
//      the middle undoes what was done (files written are removed or given their old bytes back, unless an editor saved
//      them since; removed files are written again); what cannot be undone is told.
//   3. Read back. Every file written is read once more, its bytes compared with what was meant to be written, and its
//      time taken as the new state. Only then the baseline moves on.
//
// What this cannot do: the API has no compare-and-swap. A program that changes a file in the few milliseconds between
// the last look and the write wins or loses silently; the looks right before each write make that window small, not
// empty. The generated index (ROADMAP/TASKS.md) is written from the state the page read; another file that changed on
// disk meanwhile is not checked, because the change does not touch it (the next write rebuilds the index).

import {
  safeName,
  wantedDir,
  wantedFile,
  type DirHandleLike,
  type FileHandleLike,
  type FileStamp,
  type VaultChanges,
} from './vault-files.ts';

/** The part of a `FileSystemWritableFileStream` the write-back uses. */
export interface WritableStreamLike {
  write(data: Uint8Array): Promise<void>;
  close(): Promise<void>;
  abort?(reason?: unknown): Promise<void>;
}

/** A `FileSystemFileHandle`, as far as the write-back uses one. */
export interface WritableFileHandle extends FileHandleLike {
  createWritable(options?: { keepExistingData?: boolean }): Promise<WritableStreamLike>;
  /** Chrome's `FileSystemHandle.move`: into another folder under a name. Not on every handle. */
  move?(destination: WritableDirHandle, name: string): Promise<void>;
}

/** A `FileSystemDirectoryHandle`, as far as the write-back uses one. */
export interface WritableDirHandle extends DirHandleLike {
  getFileHandle(name: string, options?: { create?: boolean }): Promise<WritableFileHandle>;
  getDirectoryHandle(name: string, options?: { create?: boolean }): Promise<WritableDirHandle>;
  removeEntry(name: string, options?: { recursive?: boolean }): Promise<void>;
}

/** What the page knows of a file on disk: what it looked like when it was read, and a digest of its bytes. */
export interface BaselineEntry extends FileStamp {
  digest: string;
}

/** Path relative to the vault -> the state of the file on disk as the page last knew it. */
export type Baseline = Map<string, BaselineEntry>;

export type Hash = (bytes: Uint8Array) => Promise<string>;

/** SHA-256 of the bytes as lowercase hex (`crypto.subtle`; a secure context has it, so does `file://` in Chrome). */
export const sha256Hex: Hash = async (bytes) => {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', copy));
  return [...digest].map((b) => b.toString(16).padStart(2, '0')).join('');
};

/** The baseline of a folder that was just read. */
export async function makeBaseline(
  vault: { files: Map<string, Uint8Array>; stamps: Map<string, FileStamp> },
  hash: Hash = sha256Hex,
): Promise<Baseline> {
  const out: Baseline = new Map();
  for (const [path, bytes] of vault.files) {
    const stamp = vault.stamps.get(path);
    out.set(path, { size: stamp?.size ?? bytes.byteLength, lastModified: stamp?.lastModified, digest: await hash(bytes) });
  }
  return out;
}

export type ConflictReason =
  /** The file was changed on disk since it was read (time, size or content). */
  | 'changed'
  /** The file is gone from the disk. */
  | 'removed'
  /** A file or folder is on the disk where the engine made a new file. */
  | 'exists';

export interface Conflict {
  path: string;
  reason: ConflictReason;
}

export type WriteBackResult =
  /** Everything is in the folder and read back; the baseline has moved on. */
  | { status: 'written'; written: string[]; removed: string[] }
  /** The folder is not what the page read. Nothing was written. */
  | { status: 'conflict'; conflicts: Conflict[]; message: string }
  /**
   * Nothing was written: the change is not one this page writes (a path, a folder that would hold unseen files).
   * `internal` is true when the list of changes itself is not consistent (a file named twice, bytes missing, a file
   * the page never read): that is a fault of the page, not a place the person may not write.
   */
  | { status: 'refused'; message: string; internal?: boolean }
  /**
   * A write or the read-back went wrong. `undone` is true when everything that had been done was taken back;
   * otherwise `leftover` names what may differ from before. The baseline is NOT updated: read the folder again.
   */
  | { status: 'failed'; message: string; undone: boolean; leftover: string[] };

export interface WriteBackInput {
  root: WritableDirHandle;
  /** Updated in place when (and only when) the result is `written`. */
  baseline: Baseline;
  /** What the engine changed. */
  changes: VaultChanges;
  /** The bytes of every added and modified file. */
  files: Map<string, Uint8Array>;
  hash?: Hash;
}

function errName(error: unknown): string {
  return typeof error === 'object' && error !== null && typeof (error as { name?: unknown }).name === 'string'
    ? (error as { name: string }).name
    : '';
}

function describe(error: unknown): string {
  const text = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  // eslint-disable-next-line no-control-regex
  return text.replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ').trim().slice(0, 160);
}

/** Why a vault-relative path is not one the write-back writes, or null. */
export function refusalOfPath(path: string): string | null {
  const segments = path.split('/');
  if (path === '' || !segments.every((s) => safeName(s))) {
    return `${JSON.stringify(path.slice(0, 80))} is not a plain path inside the vault`;
  }
  const dirs = segments.slice(0, -1);
  const name = segments[segments.length - 1] as string;
  if (!dirs.every((d) => wantedDir(d)) || !wantedFile(name, dirs.length === 0)) {
    return `${path} is not a place this page reads or writes`;
  }
  return null;
}

/** The folder changed under the write, between the check and the turn of one file: a conflict, found late. */
class ChangedWhileWriting extends Error {
  readonly conflict: Conflict;

  constructor(conflict: Conflict) {
    super(
      `${conflict.path} ${conflict.reason === 'removed' ? 'was removed' : conflict.reason === 'exists' ? 'appeared' : 'was changed'} while writing`,
    );
    this.name = 'ChangedWhileWriting';
    this.conflict = conflict;
  }
}

/** The folder at `segments` below `root`; null when it is not there (and `create` is off). */
async function dirAt(root: WritableDirHandle, segments: string[], create: boolean): Promise<WritableDirHandle | null> {
  let at = root;
  for (const segment of segments) {
    try {
      at = await at.getDirectoryHandle(segment, create ? { create: true } : undefined);
    } catch (error) {
      if (!create && errName(error) === 'NotFoundError') return null;
      throw error;
    }
  }
  return at;
}

/** The file handle at `path`, or null when nothing is there. A folder or file in its way throws TypeMismatchError. */
async function fileAt(root: WritableDirHandle, path: string): Promise<WritableFileHandle | null> {
  const segments = path.split('/');
  const parent = await dirAt(root, segments.slice(0, -1), false);
  if (!parent) return null;
  try {
    return await parent.getFileHandle(segments[segments.length - 1] as string);
  } catch (error) {
    if (errName(error) === 'NotFoundError') return null;
    throw error;
  }
}

/** A file at `path` (made empty when new), its folders made as needed. */
async function createAt(root: WritableDirHandle, path: string): Promise<WritableFileHandle> {
  const segments = path.split('/');
  const parent = (await dirAt(root, segments.slice(0, -1), true)) as WritableDirHandle;
  return parent.getFileHandle(segments[segments.length - 1] as string, { create: true });
}

async function readBytes(handle: WritableFileHandle): Promise<{ bytes: Uint8Array; stamp: FileStamp }> {
  const file = await handle.getFile();
  const bytes = new Uint8Array(await file.arrayBuffer());
  return { bytes, stamp: { size: bytes.byteLength, lastModified: file.lastModified } };
}

function sameStamp(a: FileStamp, b: FileStamp): boolean {
  return a.size === b.size && a.lastModified === b.lastModified;
}

async function writeFile(handle: WritableFileHandle, bytes: Uint8Array): Promise<void> {
  const stream = await handle.createWritable({ keepExistingData: false });
  try {
    await stream.write(bytes);
    await stream.close();
  } catch (error) {
    // The browser keeps the old file until `close` succeeded: an abort drops the swap file.
    try {
      await stream.abort?.(error);
    } catch {
      // nothing more to do about it
    }
    throw error;
  }
}

/** A file in the folder that is not hidden and not among those about to be removed (hidden folders are left alone). */
async function unseenEntry(dir: WritableDirHandle, prefix: string, removing: ReadonlySet<string>): Promise<string | null> {
  for await (const entry of dir.values()) {
    const path = prefix + entry.name;
    if (entry.kind === 'directory') {
      if (entry.name.startsWith('.')) continue;
      const found = await unseenEntry(entry as WritableDirHandle, `${path}/`, removing);
      if (found) return found;
    } else if (!removing.has(path) && !entry.name.startsWith('.')) {
      return path;
    }
  }
  return null;
}

interface Step {
  path: string;
  /** Take this step back; throws when it cannot. */
  undo(): Promise<void>;
}

/** Write what the engine changed into the folder. Never throws: every way it can end is a `WriteBackResult`. */
export async function writeBack(input: WriteBackInput): Promise<WriteBackResult> {
  try {
    return await run(input);
  } catch (error) {
    // Reached only by something that went wrong before the first write (run() reports its own failures after that).
    return { status: 'failed', message: describe(error), undone: true, leftover: [] };
  }
}

async function run(input: WriteBackInput): Promise<WriteBackResult> {
  const { root, baseline, changes, files } = input;
  const hash = input.hash ?? sha256Hex;
  const added = [...changes.added].sort();
  const modified = [...changes.modified].sort();
  const removed = [...changes.removed].sort();
  // The deepest first: a folder is empty only after the folders in it are gone.
  const removedDirs = [...changes.removedDirs].sort((a, b) => b.split('/').length - a.split('/').length || (a < b ? -1 : 1));
  const all = [...added, ...modified, ...removed];
  if (new Set(all).size !== all.length) {
    return { status: 'refused', message: 'a file is named twice in the list of changes', internal: true };
  }

  // ── 1. check, write nothing ──────────────────────────────────────────────────
  for (const path of [...all, ...removedDirs.map((d) => `${d}/x.md`)]) {
    const why = refusalOfPath(path);
    if (why) return { status: 'refused', message: why };
  }
  for (const path of [...added, ...modified]) {
    if (!files.has(path)) return { status: 'refused', message: `the bytes of ${path} are missing`, internal: true };
  }
  for (const path of [...modified, ...removed]) {
    if (!baseline.has(path)) return { status: 'refused', message: `${path} was never read from the folder`, internal: true };
  }

  const conflicts: Conflict[] = [];
  const old = new Map<string, Uint8Array>();
  for (const path of added) {
    try {
      if (await fileAt(root, path)) conflicts.push({ path, reason: 'exists' });
    } catch (error) {
      // A file where a folder is needed, or a folder where the file goes: something is there.
      if (errName(error) !== 'TypeMismatchError') throw error;
      conflicts.push({ path, reason: 'exists' });
    }
  }
  for (const path of [...modified, ...removed]) {
    const entry = baseline.get(path) as BaselineEntry;
    let there: WritableFileHandle | null;
    try {
      there = await fileAt(root, path);
    } catch (error) {
      if (errName(error) !== 'TypeMismatchError') throw error;
      conflicts.push({ path, reason: 'changed' });
      continue;
    }
    if (!there) {
      conflicts.push({ path, reason: 'removed' });
      continue;
    }
    const now = await readBytes(there);
    if (!sameStamp(now.stamp, entry) || (await hash(now.bytes)) !== entry.digest) {
      conflicts.push({ path, reason: 'changed' });
      continue;
    }
    old.set(path, now.bytes);
  }
  if (conflicts.length > 0) {
    const shown = conflicts.slice(0, 5).map((c) => `${c.path} (${c.reason})`);
    const more = conflicts.length > shown.length ? ` and ${conflicts.length - shown.length} more` : '';
    return {
      status: 'conflict',
      conflicts,
      message: `the folder changed since it was read, nothing was written: ${shown.join(', ')}${more}`,
    };
  }

  // A folder the engine got rid of (a folder task that moved) must not hold files this page never saw: the engine moved
  // the folder with everything in it, this module only knows the files it read, and the rest would stay behind.
  const removing = new Set(removed);
  for (const dir of removedDirs) {
    const handle = await dirAt(root, dir.split('/'), false);
    if (!handle) continue;
    const found = await unseenEntry(handle, `${dir}/`, removing);
    if (found) {
      return {
        status: 'refused',
        message: `${found} lies in a folder that would be moved or removed, and this page does not read it: nothing was written, change it in Neovim or the app`,
      };
    }
  }

  // ── 2. write ─────────────────────────────────────────────────────────────────
  const digests = new Map<string, string>();
  for (const path of [...added, ...modified]) digests.set(path, await hash(files.get(path) as Uint8Array));

  const steps: Step[] = [];
  const madeDirs: Array<{ parent: WritableDirHandle; name: string }> = [];
  const wrote = new Map<string, string>(); // path -> digest of the bytes written
  const gone: string[] = [];
  const moved = new Set<string>(); // removed files that were moved to their new name

  /** The folder a new file goes into; folders made on the way are remembered, to be taken back. */
  async function parentFor(path: string): Promise<{ parent: WritableDirHandle; name: string }> {
    const segments = path.split('/');
    let at = root;
    for (const segment of segments.slice(0, -1)) {
      try {
        at = await at.getDirectoryHandle(segment);
      } catch (error) {
        if (errName(error) !== 'NotFoundError') throw error;
        const parent = at;
        at = await parent.getDirectoryHandle(segment, { create: true });
        madeDirs.push({ parent, name: segment });
      }
    }
    return { parent: at, name: segments[segments.length - 1] as string };
  }

  /** Right before a change: the file is still what the check saw. */
  async function stillThere(path: string): Promise<void> {
    const entry = baseline.get(path) as BaselineEntry;
    let handle: WritableFileHandle | null;
    try {
      handle = await fileAt(root, path);
    } catch (error) {
      if (errName(error) !== 'TypeMismatchError') throw error;
      throw new ChangedWhileWriting({ path, reason: 'changed' });
    }
    if (!handle) throw new ChangedWhileWriting({ path, reason: 'removed' });
    const file = await handle.getFile();
    if (!sameStamp({ size: file.size, lastModified: file.lastModified }, entry)) {
      throw new ChangedWhileWriting({ path, reason: 'changed' });
    }
  }

  /** Right before a file is made: nothing is there (the check saw nothing, someone may have made it since). */
  async function stillAbsent(parent: WritableDirHandle, name: string, path: string): Promise<void> {
    try {
      await parent.getFileHandle(name);
    } catch (error) {
      if (errName(error) === 'NotFoundError') return;
      if (errName(error) !== 'TypeMismatchError') throw error;
    }
    throw new ChangedWhileWriting({ path, reason: 'exists' });
  }

  async function digestAt(path: string): Promise<string | null> {
    const handle = await fileAt(root, path);
    return handle ? hash((await readBytes(handle)).bytes) : null;
  }

  async function undoAll(cause: unknown, at: string): Promise<WriteBackResult> {
    const leftover: string[] = [];
    for (const step of [...steps].reverse()) {
      try {
        await step.undo();
      } catch {
        leftover.push(step.path);
      }
    }
    for (const made of [...madeDirs].reverse()) {
      try {
        await made.parent.removeEntry(made.name);
      } catch {
        // a folder that stays (not empty, or gone) does no harm
      }
    }
    return {
      status: 'failed',
      message: `writing ${at} failed: ${describe(cause)}${leftover.length ? '; not taken back: ' + leftover.join(', ') : ''}`,
      undone: leftover.length === 0,
      leftover,
    };
  }

  let at = '';
  try {
    for (const path of added) {
      at = path;
      const { parent, name } = await parentFor(path);
      await stillAbsent(parent, name, path);
      // A new file that is a removed file under another name is moved when the browser can; else it is written and the
      // old one removed below.
      const from = removed.find((r) => !moved.has(r) && (baseline.get(r) as BaselineEntry).digest === digests.get(path));
      const source = from === undefined ? null : await fileAt(root, from);
      if (from !== undefined && source?.move) {
        let done = false;
        try {
          await stillThere(from);
          await source.move(parent, name);
          done = true;
        } catch (error) {
          // The source changed after the check: not a failed move, a conflict; the copy below must not take it over.
          if (error instanceof ChangedWhileWriting) throw error;
          // A move is one step in the browser; if the source is gone, it happened after all.
          done = (await fileAt(root, from)) === null && (await fileAt(root, path)) !== null;
        }
        if (done) {
          moved.add(from);
          const oldBytes = old.get(from) as Uint8Array;
          steps.push({
            path,
            async undo() {
              await writeFile(await createAt(root, from), oldBytes);
              await parent.removeEntry(name);
            },
          });
          wrote.set(path, digests.get(path) as string);
          continue;
        }
      }
      await stillAbsent(parent, name, path);
      const handle = await parent.getFileHandle(name, { create: true });
      steps.push({
        path,
        async undo() {
          await parent.removeEntry(name);
        },
      });
      await writeFile(handle, files.get(path) as Uint8Array);
      wrote.set(path, digests.get(path) as string);
    }
    for (const path of modified) {
      at = path;
      await stillThere(path);
      const handle = (await fileAt(root, path)) as WritableFileHandle;
      const oldBytes = old.get(path) as Uint8Array;
      const before = (baseline.get(path) as BaselineEntry).digest;
      const ours = digests.get(path) as string;
      steps.push({
        path,
        async undo() {
          const now = await digestAt(path);
          // Still the old file (the write never happened): nothing to give back. Something else: leave it alone.
          if (now === before) return;
          if (now !== ours) throw new Error('changed meanwhile');
          await writeFile(await createAt(root, path), oldBytes);
        },
      });
      await writeFile(handle, files.get(path) as Uint8Array);
      wrote.set(path, ours);
    }
    for (const path of removed) {
      if (moved.has(path)) {
        gone.push(path);
        continue;
      }
      at = path;
      await stillThere(path);
      const oldBytes = old.get(path) as Uint8Array;
      const segments = path.split('/');
      const parent = (await dirAt(root, segments.slice(0, -1), false)) as WritableDirHandle;
      await parent.removeEntry(segments[segments.length - 1] as string);
      gone.push(path);
      steps.push({
        path,
        async undo() {
          await writeFile(await createAt(root, path), oldBytes);
        },
      });
    }
  } catch (error) {
    const undone = await undoAll(error, at);
    if (error instanceof ChangedWhileWriting && undone.status === 'failed' && undone.undone) {
      // Found late, taken back completely: the same answer as a conflict found by the check, so the person retries.
      const { path, reason } = error.conflict;
      return {
        status: 'conflict',
        conflicts: [error.conflict],
        message: `the folder changed while writing, everything was taken back: ${path} (${reason})`,
      };
    }
    return undone;
  }

  // Folders the engine removed that are empty now. One that is not empty stays; that is no failure.
  for (const dir of removedDirs) {
    const segments = dir.split('/');
    try {
      const parent = await dirAt(root, segments.slice(0, -1), false);
      await parent?.removeEntry(segments[segments.length - 1] as string);
    } catch {
      // not empty (a hidden file), or not there
    }
  }

  // ── 3. read back ─────────────────────────────────────────────────────────────
  const next = new Map<string, BaselineEntry>();
  for (const [path, digest] of wrote) {
    try {
      const handle = await fileAt(root, path);
      if (!handle) throw new Error('is not there');
      const now = await readBytes(handle);
      if ((await hash(now.bytes)) !== digest) throw new Error('does not hold what was written');
      next.set(path, { size: now.stamp.size, lastModified: now.stamp.lastModified, digest });
    } catch (error) {
      // The files are written and not taken back: another program may have written there meanwhile, and giving the old
      // bytes back could destroy that. The baseline stays; the caller reads the folder again.
      return {
        status: 'failed',
        message: `${path} could not be verified after writing: ${describe(error)}`,
        undone: false,
        leftover: [path],
      };
    }
  }
  for (const [path, entry] of next) baseline.set(path, entry);
  for (const path of gone) baseline.delete(path);
  return { status: 'written', written: [...wrote.keys()], removed: gone };
}
