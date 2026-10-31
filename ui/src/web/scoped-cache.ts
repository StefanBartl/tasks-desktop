// The list cache of the page (web WEB-17: `lib/cache.ts`, IndexedDB), made safe for a page that works on any folder.
//
// `lib/cache.ts` keeps one list under one key and names it by `vault.id`. In the web variant that id is the name of the
// mount point of the engine's file system (`vault`), the same for every folder, so a list of one folder would be shown
// first, for a moment, over another folder. And the classes the list was cut by when it was saved belong to the
// `areas.json` of that day; the file may have changed since. So this keeps the list of one folder only (named by the id the
// folders used before give it), and gives it back only while every area in it is still one the data classes release.
//
// What may be saved is decided where it always was (`cacheableList` in lib/cache.ts: only public and internal areas, a
// reference to a task that was left out is cut). This adds nothing to it; it narrows what is read back. The two rules
// (named by the folder, given back only while released) are the kit's (appkit-web/folder-cache); this says what
// "released" means for a list of tasks: every task's area is one the classes release now.

import { folderCache, forgetFolderCache } from 'appkit-web/folder-cache';
import type { ListStore } from '../lib/cache.ts';

export interface CacheScope {
  /** The folder this cache is for (`Recent.id`). */
  folder: string;
  /** May a task of this area be kept in the browser now (the class of the area, as the page knows it)? */
  permits(area: string): boolean;
}

export function scopedCache(store: ListStore, scope: CacheScope): ListStore {
  return folderCache(store, scope.folder, (list) => list.tasks.every((task) => scope.permits(task.area)));
}

/**
 * Forget the list kept for one folder (the person forgot the folder): nothing of it stays in the browser. The list of
 * another folder is not this folder's to clear.
 */
export function forgetList(store: ListStore, folder: string): Promise<void> {
  return forgetFolderCache(store, folder);
}
