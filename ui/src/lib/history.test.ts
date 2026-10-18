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
    peeking: false,
    get tasks() {
      return this.ids.map((id) => ({ id }));
    },
    setView(view: View) {
      this.view = view;
    },
    select(id) {
      this.selectedId = id;
    },
    peek(id) {
      this.selectedId = id;
      this.peeking = true;
    },
    closePeek() {
      this.peeking = false;
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
    // The popup is a flag that is there only when it is on; a place from before it has none.
    expect(isPlace({ view: 'plan', selectedId: 'a/1', peek: true })).toBe(true);
    expect(isPlace({ view: 'plan', selectedId: 'a/1', peek: false })).toBe(false);
    expect(isPlace({ view: 'plan', selectedId: 'a/1', peek: 'yes' })).toBe(false);
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

  it('makes the popup a place: Back closes it, Forward opens it again, closing it by hand is a place of its own', () => {
    const tb = tab();
    const app = fakeApp(['a/1', 'a/2']);
    const h = installAppHistory(app, tb);
    h.sync();
    app.view = 'plan';
    h.sync();
    app.peek('a/2');
    h.sync();
    expect(places(tb).at(-1)).toEqual({ view: 'plan', selectedId: 'a/2', peek: true });
    // Closed by hand: the same task, no popup.
    app.closePeek();
    h.sync();
    expect(places(tb).at(-1)).toEqual({ view: 'plan', selectedId: 'a/2' });
    // Back: the place with the popup, so the popup is open again; once more: the plan without a task.
    tb.go(-1);
    expect([app.view, app.selectedId, app.peeking]).toEqual(['plan', 'a/2', true]);
    tb.go(-1);
    expect([app.view, app.selectedId, app.peeking]).toEqual(['plan', null, false]);
    tb.go(1);
    expect([app.view, app.selectedId, app.peeking]).toEqual(['plan', 'a/2', true]);
    // Nothing the restore did is a new place.
    h.sync();
    expect(tb.entries.length).toBe(4);
  });

  it('opens no popup for a task that is gone, and the place becomes the view alone', () => {
    const tb = tab();
    const app = fakeApp(['a/1']);
    const h = installAppHistory(app, tb);
    h.sync();
    app.view = 'plan';
    h.sync();
    app.peek('a/1');
    h.sync();
    app.ids = [];
    app.selectedId = null;
    app.peeking = false;
    h.sync();
    tb.go(-1);
    expect([app.view, app.selectedId, app.peeking]).toEqual(['plan', null, false]);
  });
});
