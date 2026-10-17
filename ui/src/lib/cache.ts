// The client cache: what is shown before the hub has answered.
//
// Rules (concept 5.7): an area that is `private`, or that has no class yet
// (fail-closed), never reaches IndexedDB. The cache holds only what the list
// needs; the plan and everything derived is read fresh. A reference from a
// kept task to a task that was left out is cut, so no id of a private task
// survives in the cache through an edge.

import type { Snapshot, TaskEntry } from './contract';
import type { HubArea } from './api';

export interface CachedList {
  /** The id of the vault the list is of. */
  vault: string;
  /**
   * The vault the hub read when the list was saved, by the name of its list of vaults (`null`: a hub with one vault and
   * no list). A page that starts asks the hub for it first and shows the list only for the same vault; absent in a
   * list saved before this was kept.
   */
  hubVault?: string | null;
  rev: string | null;
  etag: string | null;
  savedAt: number;
  tasks: TaskEntry[];
}

/** May tasks of this class be written to the cache? */
export function cacheableClass(dataClass: HubArea['data_class'] | undefined): boolean {
  return dataClass === 'public' || dataClass === 'internal';
}

/** The part of a snapshot that may be cached, or `null` when nothing may. */
export function cacheableList(
  doc: Snapshot,
  etag: string | null,
  areas: readonly HubArea[],
  now: number,
): CachedList | null {
  const classes = new Map(areas.map((a) => [a.name, a.data_class] as const));
  const kept = doc.tasks.filter((t) => cacheableClass(classes.get(t.area)));
  if (kept.length === 0) return null;
  const ids = new Set(kept.map((t) => t.id));
  const known = (list: readonly string[]) => list.filter((id) => ids.has(id));
  // A ref is text as the author wrote it: it may name a task, or a path into
  // an area that is left out. Such a ref is not kept.
  const left = [...new Set(doc.tasks.map((t) => t.area))].filter(
    (area) => !cacheableClass(classes.get(area)),
  );
  const refs = (list: readonly string[]) =>
    list.filter((ref) => !left.some((area) => ref.includes(`${area}/`)));
  const tasks = kept.map((t) => {
    const copy: TaskEntry = {
      ...t,
      blocked_by: known(t.blocked_by),
      after: known(t.after),
      refs: refs(t.refs),
    };
    if (t.readiness) {
      const { inversion: _inversion, same_file: _sameFile, ...rest } = t.readiness;
      copy.readiness = { ...rest, open_blockers: known(t.readiness.open_blockers) };
    }
    return copy;
  });
  return { vault: doc.vault.id, rev: doc.rev, etag, savedAt: now, tasks };
}

/** Where the list is kept. An interface, so that tests need no browser. */
export interface ListStore {
  load(): Promise<CachedList | null>;
  save(list: CachedList): Promise<void>;
  clear(): Promise<void>;
}

const DB = 'tasks-desktop';
const STORE = 'list';
const KEY = 'current';

function open(factory: IDBFactory): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = factory.open(DB, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function done<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

/** IndexedDB behind `ListStore`. Every failure is a miss, never an error. */
export function indexedDbStore(factory: IDBFactory | undefined): ListStore {
  const run = async <T>(mode: IDBTransactionMode, work: (s: IDBObjectStore) => IDBRequest<T>) => {
    if (!factory) return null;
    try {
      const db = await open(factory);
      try {
        return await done(work(db.transaction(STORE, mode).objectStore(STORE)));
      } finally {
        db.close();
      }
    } catch {
      return null;
    }
  };
  return {
    async load() {
      const value = await run('readonly', (s) => s.get(KEY));
      return isCachedList(value) ? value : null;
    },
    async save(list) {
      await run('readwrite', (s) => s.put(list, KEY));
    },
    async clear() {
      await run('readwrite', (s) => s.delete(KEY));
    },
  };
}

function isCachedList(value: unknown): value is CachedList {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Partial<CachedList>;
  return typeof v.vault === 'string' && Array.isArray(v.tasks) && typeof v.savedAt === 'number';
}
