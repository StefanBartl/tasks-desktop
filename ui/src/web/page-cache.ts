// The wiring of the page's list cache (main.web.ts), apart from the page so that a test can reach it.
//
// What the page keeps in the browser is decided by the data classes of the folder (`areas.json`, web/classes.ts), as in
// the Rust hub: the app's own rules (`lib/cache.ts`) let only public and internal areas into IndexedDB, and an area the
// file does not name is unclassified and stays out. The cache is made when the folder has been read, with its classes
// (Entry.open: VaultSession.load, then `begin`), so the classes it asks are those of the file, never a guess.

import { cacheableClass, type ListStore } from '../lib/cache.ts';
import type { HubArea } from '../lib/api.ts';
import { scopedCache } from './scoped-cache.ts';

/** A cache that keeps nothing: for a folder the browser could not remember, which has no name to keep a list under. */
export const noCache: ListStore = { load: async () => null, save: async () => {}, clear: async () => {} };

/**
 * The list cache for the folder `folder` (the id the folders used before give it; `null`: the browser could not keep
 * it). `classOf` is asked at every read and write: the file may change while the page is open.
 */
export function pageCache(
  store: ListStore,
  folder: string | null,
  classOf: (area: string) => HubArea['data_class'] | undefined,
): ListStore {
  if (folder === null) return noCache;
  return scopedCache(store, { folder, permits: (area) => cacheableClass(classOf(area)) });
}
