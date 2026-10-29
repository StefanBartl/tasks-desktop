// The list cache of the page (web WEB-17: `lib/cache.ts`, IndexedDB), made safe for a page that works on any folder.
//
// `lib/cache.ts` keeps one list under one key and names it by `vault.id`. In the web variant that id is the name of the
// mount point of the engine's file system (`vault`), the same for every folder, so a list of one folder would be shown
// first, for a moment, over another folder. And the classes the list was cut by when it was saved belong to the
// `areas.json` of that day; the file may have changed since. So this keeps the list of one folder only (named by the id the
// folders used before give it), and gives it back only while every area in it is still one the data classes release.
//
// What may be saved is decided where it always was (`cacheableList` in lib/cache.ts: only public and internal areas, a
// reference to a task that was left out is cut). This adds nothing to it; it narrows what is read back.

import type { CachedList, ListStore } from '../lib/cache.ts';

export interface CacheScope {
  /** The folder this cache is for (`Recent.id`). */
  folder: string;
  /** May a task of this area be kept in the browser now (the class of the area, as the page knows it)? */
  permits(area: string): boolean;
}

/** A list as the scope keeps it: the folder it is of is part of it. */
type Scoped = CachedList & { folder?: unknown };

export function scopedCache(store: ListStore, scope: CacheScope): ListStore {
  return {
    async load() {
      const list = (await store.load()) as Scoped | null;
      if (!list) return null;
      // Another folder's list (or one saved before lists were named by folder): not shown, and not this folder's to clear.
      if (list.folder !== scope.folder) return null;
      // A list that holds a task of an area the classes do not release now was saved under other classes: it goes.
      if (list.tasks.some((task) => !scope.permits(task.area))) {
        await store.clear();
        return null;
      }
      return list;
    },
    save: async (list) => {
      // The same rule on the way in as on the way out. The page builds a list from the classes it asked for, and a
      // question that was asked before `areas.json` changed can be answered after it (two refreshes overlap when the file
      // changes): such a list must not be written, whatever the page believes. What is stored under it is of the same
      // old classes, so it goes too.
      if (list.tasks.some((task) => !scope.permits(task.area))) {
        await store.clear();
        return;
      }
      await store.save({ ...list, folder: scope.folder } as Scoped);
    },
    clear: () => store.clear(),
  };
}

/**
 * Forget the list kept for one folder (the person forgot the folder): nothing of it stays in the browser. The list of
 * another folder is not this folder's to clear.
 */
export async function forgetList(store: ListStore, folder: string): Promise<void> {
  const list = (await store.load()) as Scoped | null;
  if (list && list.folder === folder) await store.clear();
}
