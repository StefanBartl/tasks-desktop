// The folder the person works in, in the web variant: choosing it (File System Access API), the folders used before
// (their handles in IndexedDB), and the permission to read them, which the browser asks again after a restart.
//
// Everything that is the browser's comes in by argument (the window, the key-value store), so Node runs this without
// one. The probe of 2026-10-28 (`ui/probe/`) showed on the workstation what this relies on: the handle survives a
// reload and a restart of Chrome, the permission is `granted` after a reload and `prompt` after a restart, and only a
// click (`requestPermission` inside a user gesture) brings it back.

import type { InputDocument } from './folder-input.ts';
import type { WritableDirHandle } from './write-back.ts';

export type PermissionState = 'granted' | 'prompt' | 'denied';
export type AccessMode = 'read' | 'readwrite';

/** A `FileSystemDirectoryHandle`, as far as this module uses one. */
export interface DirHandle extends WritableDirHandle {
  queryPermission(descriptor: { mode: AccessMode }): Promise<PermissionState>;
  requestPermission(descriptor: { mode: AccessMode }): Promise<PermissionState>;
  isSameEntry?(other: DirHandle): Promise<boolean>;
}

/** What the module needs of `window`. */
export interface PickerWindow {
  showDirectoryPicker?: (options: { id: string; mode: AccessMode }) => Promise<DirHandle>;
  isSecureContext?: boolean;
  /** Where a folder input is made, for the browsers without the picker (`folder-input.ts`). */
  document?: InputDocument;
}

/** The mode asked for. `readwrite` from the start, so that writing (step 8) does not ask a second time. */
export const MODE: AccessMode = 'readwrite';
/** The picker remembers the last folder per id and starts there. */
export const PICKER_ID = 'tasks-web-vault';
export const MAX_RECENT = 5;

export type Support = 'ok' | 'missing' | 'insecure';

/** Whether this page can choose a folder at all. A policy that blocks it shows only when the picker is called. */
export function pickerSupport(win: PickerWindow): Support {
  if (typeof win.showDirectoryPicker !== 'function') return 'missing';
  if (win.isSecureContext === false) return 'insecure';
  return 'ok';
}

export type PickResult =
  | { kind: 'picked'; handle: DirHandle }
  | { kind: 'cancelled' }
  | { kind: 'blocked'; message: string }
  | { kind: 'failed'; message: string };

/** One line of text of an error: no control characters, cut short. */
export function oneLine(error: unknown, max = 200): string {
  const raw = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  // eslint-disable-next-line no-control-regex
  return raw.replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ').trim().slice(0, max);
}

function nameOf(error: unknown): string {
  return typeof error === 'object' && error !== null && typeof (error as { name?: unknown }).name === 'string'
    ? (error as { name: string }).name
    : '';
}

/** Ask the person for a folder. Must run inside a click: the browser refuses the picker without one. */
export async function pickFolder(win: PickerWindow): Promise<PickResult> {
  if (typeof win.showDirectoryPicker !== 'function') return { kind: 'failed', message: 'showDirectoryPicker is missing' };
  try {
    return { kind: 'picked', handle: await win.showDirectoryPicker({ id: PICKER_ID, mode: MODE }) };
  } catch (error) {
    const name = nameOf(error);
    if (name === 'AbortError') return { kind: 'cancelled' };
    // A policy of the organisation, or no click behind the call: the picker is refused, not failed.
    if (name === 'SecurityError' || name === 'NotAllowedError') return { kind: 'blocked', message: oneLine(error) };
    return { kind: 'failed', message: oneLine(error) };
  }
}

/** The permission a stored handle has now; `gone` when the folder does not exist any more. */
export async function permissionOf(handle: DirHandle): Promise<PermissionState | 'gone'> {
  try {
    return await handle.queryPermission({ mode: MODE });
  } catch (error) {
    return nameOf(error) === 'NotFoundError' ? 'gone' : 'denied';
  }
}

/** Ask for the permission again. Must run inside a click (the first thing the click handler does). */
export async function grantAccess(handle: DirHandle): Promise<PermissionState | 'gone'> {
  try {
    return await handle.requestPermission({ mode: MODE });
  } catch (error) {
    return nameOf(error) === 'NotFoundError' ? 'gone' : 'denied';
  }
}

// -- the folders used before ------------------------------------------------------------------------------------

/** The part of a key-value store the list needs. */
export interface KeyValue {
  get(key: string): Promise<unknown>;
  put(key: string, value: unknown): Promise<void>;
}

export interface Recent {
  id: string;
  name: string;
  handle: DirHandle;
  lastUsed: number;
}

const RECENT_KEY = 'recent';

/** Whether a stored value is a directory handle this module can use. */
function isHandle(value: unknown): value is DirHandle {
  const h = value as Partial<DirHandle> | null;
  return (
    typeof h === 'object' &&
    h !== null &&
    h.kind === 'directory' &&
    typeof h.values === 'function' &&
    typeof h.queryPermission === 'function' &&
    typeof h.requestPermission === 'function'
  );
}

/** A name for the list: what the folder is called, without control characters, cut short. */
export function displayName(name: unknown): string {
  // eslint-disable-next-line no-control-regex
  return (typeof name === 'string' ? name : '').replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ').trim().slice(0, 200);
}

export class RecentFolders {
  // Plain fields, no parameter properties: Node runs this file by stripping the types, without a build.
  private readonly kv: KeyValue;
  private readonly max: number;
  private readonly newId: () => string;

  constructor(kv: KeyValue, opts: { max?: number; newId?: () => string } = {}) {
    this.kv = kv;
    this.max = opts.max ?? MAX_RECENT;
    this.newId = opts.newId ?? (() => crypto.randomUUID());
  }

  /** The folders, the one used last first. What is stored is checked: an entry that is not a folder is dropped. */
  async list(): Promise<Recent[]> {
    let raw: unknown;
    try {
      raw = await this.kv.get(RECENT_KEY);
    } catch {
      return [];
    }
    if (!Array.isArray(raw)) return [];
    const out: Recent[] = [];
    const seen = new Set<string>();
    for (const item of raw as Array<Partial<Recent> | null>) {
      if (typeof item !== 'object' || item === null) continue;
      const { id, handle, lastUsed } = item;
      if (typeof id !== 'string' || id === '' || seen.has(id) || !isHandle(handle)) continue;
      seen.add(id);
      out.push({
        id,
        name: displayName(handle.name),
        handle,
        lastUsed: typeof lastUsed === 'number' && Number.isFinite(lastUsed) ? lastUsed : 0,
      });
    }
    return out.sort((a, b) => b.lastUsed - a.lastUsed).slice(0, this.max);
  }

  /** Remember `handle` as used at `now`: the same folder as one in the list moves up, a new one is added. */
  async remember(handle: DirHandle, now: number): Promise<Recent> {
    const all = await this.list();
    let same: Recent | undefined;
    for (const entry of all) {
      if (await sameFolder(entry.handle, handle)) {
        same = entry;
        break;
      }
    }
    const kept = all.filter((entry) => entry !== same);
    const entry: Recent = { id: same?.id ?? this.newId(), name: displayName(handle.name), handle, lastUsed: now };
    await this.save([entry, ...kept].slice(0, this.max));
    return entry;
  }

  async forget(id: string): Promise<void> {
    await this.save((await this.list()).filter((entry) => entry.id !== id));
  }

  private save(list: Recent[]): Promise<void> {
    return this.kv.put(RECENT_KEY, list.map(({ id, handle, lastUsed }) => ({ id, handle, lastUsed })));
  }
}

async function sameFolder(a: DirHandle, b: DirHandle): Promise<boolean> {
  if (a === b) return true;
  try {
    return typeof a.isSameEntry === 'function' ? await a.isSameEntry(b) : false;
  } catch {
    return false;
  }
}

// -- IndexedDB ---------------------------------------------------------------------------------------------------

/** One object store, handles by key. A directory handle can be stored in IndexedDB, in no other place. */
export function idbKeyValue(factory: IDBFactory, name = 'tasks-web', store = 'handles'): KeyValue {
  // One connection for the page; a failed open is tried again next time.
  let opened: Promise<IDBDatabase> | null = null;
  const db = (): Promise<IDBDatabase> => {
    opened ??= new Promise<IDBDatabase>((resolve, reject) => {
      const request = factory.open(name, 1);
      request.onupgradeneeded = () => request.result.createObjectStore(store);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    }).catch((error: unknown) => {
      opened = null;
      throw error;
    });
    return opened;
  };
  const run = async <T>(mode: IDBTransactionMode, make: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> => {
    const d = await db();
    return new Promise<T>((resolve, reject) => {
      const tx = d.transaction(store, mode);
      const request = make(tx.objectStore(store));
      tx.oncomplete = () => resolve(request.result);
      tx.onerror = () => reject(tx.error);
      // An aborted transaction (quota) fires no error of its own.
      tx.onabort = () => reject(tx.error ?? new Error('transaction aborted'));
    });
  };
  return {
    get: (key) => run('readonly', (s) => s.get(key)),
    put: async (key, value) => {
      await run('readwrite', (s) => s.put(value, key));
    },
  };
}
