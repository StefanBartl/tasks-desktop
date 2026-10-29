// The list cache of the web page: one folder's list, read back only while its areas are still released.
//
//   node --experimental-strip-types --test web/scoped-cache.test.mjs        (from ui/)

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { forgetList, scopedCache } from '../src/web/scoped-cache.ts';

/** A store in memory with the one slot of lib/cache.ts. */
function slot() {
  const state = { value: null, cleared: 0, saved: 0 };
  return {
    state,
    load: async () => structuredClone(state.value),
    save: async (list) => {
      state.saved += 1;
      state.value = structuredClone(list);
    },
    clear: async () => {
      state.cleared += 1;
      state.value = null;
    },
  };
}

const list = (areas) => ({ vault: 'vault', rev: 'rev:1', etag: 'e', savedAt: 5, tasks: areas.map((area, i) => ({ id: `${area}/t${i}`, area })) });
const permits = (...ok) => (area) => ok.includes(area);

test('a list is read back by the folder it was saved for', async () => {
  const store = slot();
  const mine = scopedCache(store, { folder: 'f1', permits: permits('a', 'b') });
  await mine.save(list(['a', 'b']));
  assert.equal(store.state.value.folder, 'f1', 'the folder is part of what is kept');
  const back = await mine.load();
  assert.deepEqual(back.tasks.map((t) => t.id), ['a/t0', 'b/t1']);
});

test('the list of another folder is not shown, and it is left where it is', async () => {
  const store = slot();
  await scopedCache(store, { folder: 'f1', permits: permits('a') }).save(list(['a']));
  const other = scopedCache(store, { folder: 'f2', permits: permits('a') });
  assert.equal(await other.load(), null);
  assert.equal(store.state.cleared, 0, 'a miss, not a clear: the list is that folder\'s');
  // A list saved before lists had a folder is nobody's.
  store.state.value = list(['a']);
  assert.equal(await other.load(), null);
  assert.equal(await scopedCache(store, { folder: 'f1', permits: permits('a') }).load(), null);
});

test('a list with an area the classes do not release now is dropped and cleared', async () => {
  const store = slot();
  await scopedCache(store, { folder: 'f1', permits: permits('a', 'b') }).save(list(['a', 'b']));
  // areas.json changed since: `b` is private now.
  const later = scopedCache(store, { folder: 'f1', permits: permits('a') });
  assert.equal(await later.load(), null);
  assert.equal(store.state.cleared, 1);
  assert.equal(store.state.value, null, 'nothing of it stays in the browser');
});

test('with no class released at all nothing is read back', async () => {
  const store = slot();
  await scopedCache(store, { folder: 'f1', permits: permits('a') }).save(list(['a']));
  assert.equal(await scopedCache(store, { folder: 'f1', permits: () => false }).load(), null);
  assert.equal(store.state.value, null);
});

test('an empty store is a miss', async () => {
  assert.equal(await scopedCache(slot(), { folder: 'f1', permits: permits('a') }).load(), null);
});

test('a list with an area the classes do not release is not saved, and what is kept of older classes goes', async () => {
  const store = slot();
  let released = ['a', 'b'];
  const cache = scopedCache(store, { folder: 'f1', permits: (area) => released.includes(area) });
  await cache.save(list(['a', 'b']));
  assert.equal(store.state.saved, 1);
  // areas.json changed: `b` is private now, and a refresh that asked for the classes before still hands in `a` and `b`.
  released = ['a'];
  await cache.save(list(['a', 'b']));
  assert.equal(store.state.saved, 1, 'the late list is not written');
  assert.equal(store.state.value, null, 'and the list of the old classes does not stay');
  // The next list, cut by the new classes, is kept.
  await cache.save(list(['a']));
  assert.deepEqual(store.state.value.tasks.map((t) => t.area), ['a']);
});

test('forgetting a folder clears its list, and only its own', async () => {
  const store = slot();
  await scopedCache(store, { folder: 'f1', permits: permits('a') }).save(list(['a']));
  await forgetList(store, 'f2');
  assert.equal(store.state.cleared, 0, 'the list of another folder stays');
  assert.equal(store.state.value.folder, 'f1');
  await forgetList(store, 'f1');
  assert.equal(store.state.value, null);
  // Nothing kept, nothing to clear.
  await forgetList(store, 'f1');
  assert.equal(store.state.cleared, 1);
});

test('clear passes through, and a save of the page is kept as it is, plus the folder', async () => {
  const store = slot();
  const cache = scopedCache(store, { folder: 'f9', permits: permits('a') });
  await cache.save({ ...list(['a']), hubVault: null });
  assert.deepEqual(Object.keys(store.state.value).sort(), ['etag', 'folder', 'hubVault', 'rev', 'savedAt', 'tasks', 'vault']);
  await cache.clear();
  assert.equal(store.state.value, null);
});
