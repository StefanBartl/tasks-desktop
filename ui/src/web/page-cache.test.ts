// The wiring of the page's list cache: which folder a list is kept for, and which areas the page's classes release.
import { describe, expect, it } from 'vitest';
import type { CachedList, ListStore } from '../lib/cache';
import { pageCache } from './page-cache';

/** A store in memory with the one slot of lib/cache.ts. */
function slot(): ListStore & { value: CachedList | null } {
  const store = {
    value: null as CachedList | null,
    load: async () => (store.value ? structuredClone(store.value) : null),
    save: async (list: CachedList) => {
      store.value = structuredClone(list);
    },
    clear: async () => {
      store.value = null;
    },
  };
  return store;
}

const list = (...areas: string[]): CachedList => ({
  vault: 'vault',
  rev: 'rev:1',
  etag: 'e',
  savedAt: 5,
  tasks: areas.map((area, i) => ({ id: `${area}/t${i}`, area }) as never),
});

const classes: Record<string, 'public' | 'internal' | 'private' | 'unclassified'> = {
  pub: 'public',
  int: 'internal',
  sec: 'private',
};
const classOf = (area: string) => classes[area] ?? 'unclassified';

describe('the list cache of the page', () => {
  it('keeps and gives back the list of public and internal areas, for the folder it was made for', async () => {
    const store = slot();
    const cache = pageCache(store, 'f1', classOf);
    await cache.save(list('pub', 'int'));
    expect((await cache.load())?.tasks.map((t) => t.area)).toEqual(['pub', 'int']);
    expect((store.value as unknown as { folder: string }).folder).toBe('f1');
  });

  it('shows the list of one folder to that folder only', async () => {
    const store = slot();
    await pageCache(store, 'f1', classOf).save(list('pub'));
    expect(await pageCache(store, 'f2', classOf).load()).toBeNull();
    expect(await pageCache(store, 'f1', classOf).load()).not.toBeNull();
  });

  it('gives nothing back that the classes of now do not release, and clears it', async () => {
    const store = slot();
    await pageCache(store, 'f1', classOf).save(list('pub', 'int'));
    // areas.json changed while the page was closed: `int` is private, an area it does not name is unclassified.
    const later: typeof classes = { ...classes, int: 'private' };
    expect(await pageCache(store, 'f1', (area) => later[area] ?? 'unclassified').load()).toBeNull();
    expect(store.value).toBeNull();
  });

  it('does not write a list of an area that is private or unclassified now', async () => {
    const store = slot();
    const cache = pageCache(store, 'f1', classOf);
    await cache.save(list('pub', 'sec'));
    expect(store.value).toBeNull();
    await cache.save(list('pub', 'nobody-names-me'));
    expect(store.value).toBeNull();
  });

  it('asks the classes at every read and write, not once', async () => {
    const store = slot();
    let now: Record<string, string> = { pub: 'public' };
    const cache = pageCache(store, 'f1', (area) => (now[area] ?? 'unclassified') as never);
    await cache.save(list('pub'));
    expect(store.value).not.toBeNull();
    now = {};
    await cache.save(list('pub'));
    expect(store.value).toBeNull();
  });

  it('keeps nothing for a folder the browser could not remember', async () => {
    const store = slot();
    const cache = pageCache(store, null, classOf);
    await cache.save(list('pub'));
    expect(store.value).toBeNull();
    store.value = list('pub');
    expect(await cache.load()).toBeNull();
  });
});
