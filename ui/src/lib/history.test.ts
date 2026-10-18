import { describe, expect, it } from 'vitest';
import { installAppHistory, isPlace, type HistoryApp, type Place } from './history';
import type { View } from './app.svelte';

/** A tab: a list of entries and a position, like the real history. */
function tab() {
  const entries: unknown[] = [null];
  let at = 0;
  const listeners: ((e: { state: unknown }) => void)[] = [];
  return {
    entries,
    get at() {
      return at;
    },
    history: {
      pushState(data: unknown) {
        entries.splice(at + 1);
        entries.push(data);
        at += 1;
      },
      replaceState(data: unknown) {
        entries[at] = data;
      },
    },
    addEventListener(_t: 'popstate', l: (e: { state: unknown }) => void) {
      listeners.push(l);
    },
    removeEventListener() {},
    go(delta: number) {
      at += delta;
      for (const l of listeners) l({ state: entries[at] });
    },
  };
}

function fakeApp(ids: string[]) {
  const app: HistoryApp & { ids: string[] } = {
    ids,
    view: 'today',
    selectedId: null,
    get tasks() {
      return this.ids.map((id) => ({ id }));
    },
    setView(view: View) {
      this.view = view;
    },
    select(id) {
      this.selectedId = id;
    },
  };
  return app;
}

describe('isPlace', () => {
  it('takes only a known view and a string or null', () => {
    expect(isPlace({ view: 'list', selectedId: null })).toBe(true);
    expect(isPlace({ view: 'nope', selectedId: null })).toBe(false);
    expect(isPlace({ view: 'list', selectedId: 3 })).toBe(false);
    expect(isPlace(null)).toBe(false);
  });
});

describe('installAppHistory', () => {
  const places = (t: ReturnType<typeof tab>) =>
    t.entries.map((e) => (e as { state: Place } | null)?.state ?? null);

  it('makes an entry per place, and Back and Forward bring the page there', () => {
    const t = tab();
    const app = fakeApp(['a/1', 'a/2']);
    const h = installAppHistory(app, t);
    h.sync();
    app.view = 'list';
    h.sync();
    app.selectedId = 'a/2';
    h.sync();
    expect(places(t)).toEqual([
      { view: 'today', selectedId: null },
      { view: 'list', selectedId: null },
      { view: 'list', selectedId: 'a/2' },
    ]);
    t.go(-1);
    expect([app.view, app.selectedId]).toEqual(['list', null]);
    t.go(-1);
    expect([app.view, app.selectedId]).toEqual(['today', null]);
    t.go(2);
    expect([app.view, app.selectedId]).toEqual(['list', 'a/2']);
    // What the restore did is not a new place: nothing was pushed.
    h.sync();
    expect(t.entries.length).toBe(3);
  });

  it('opens the view alone when the task of the entry is gone, in the same entry', () => {
    const t = tab();
    const app = fakeApp(['a/1']);
    const h = installAppHistory(app, t);
    h.sync();
    app.selectedId = 'a/1';
    h.sync();
    app.view = 'board';
    h.sync();
    app.ids = [];
    t.go(-1);
    expect([app.view, app.selectedId]).toEqual(['today', null]);
    t.go(1);
    t.go(-1);
    // The entry that named the vanished task was rewritten, no new one was made.
    expect(t.entries.length).toBe(3);
    expect(places(t)[1]).toEqual({ view: 'today', selectedId: null });
  });

  it('takes the place of the entry when the open task vanishes by itself', () => {
    const t = tab();
    const app = fakeApp(['a/1']);
    const h = installAppHistory(app, t);
    h.sync();
    app.selectedId = 'a/1';
    h.sync();
    app.ids = [];
    app.selectedId = null;
    h.sync();
    expect(t.entries.length).toBe(2);
    expect(places(t)[1]).toEqual({ view: 'today', selectedId: null });
  });
});
