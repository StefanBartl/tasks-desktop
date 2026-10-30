// The parts of the state of the page, each on its own (the page tests, `app.test.ts`, go through `App`).

import { describe, expect, it, vi } from 'vitest';
import { ApiError, type VaultList } from '../api';
import type { Conflict } from '../conflicts';
import { AboutState } from './about.svelte';
import { ConflictsState } from './conflicts.svelte';
import { TodayState } from './today.svelte';
import { VaultsState } from './vaults.svelte';
import { ViewsState, type ViewsHost } from './views.svelte';
import type { Groupings, View, Views } from '../contract';

const conflict = (key: string): Conflict => ({ key, id: `a/${key}`, op: { op: 'set', id: `a/${key}`, patch: {} }, code: 'conflict', at: 1 });

describe('the conflicts', () => {
  it('keeps the newest first, replaces a newer refusal of the same change, and opens only with something in it', () => {
    const state = new ConflictsState(() => undefined);
    state.show();
    expect(state.open).toBe(false);
    state.add([conflict('a'), conflict('b')]);
    state.add([conflict('b')]);
    expect(state.list.map((c) => c.key)).toEqual(['b', 'a']);
    state.show();
    expect(state.open).toBe(true);
  });

  it('closes with the last conflict that goes, and finds one by its key', () => {
    const state = new ConflictsState(() => undefined);
    state.add([conflict('a'), conflict('b')]);
    state.show();
    state.discard('a');
    expect(state.open).toBe(true);
    expect(state.find('b')?.id).toBe('a/b');
    expect(state.find('a')).toBeUndefined();
    state.discard('b');
    expect(state.open).toBe(false);
    state.add([conflict('c')]);
    state.show();
    state.discardAll();
    expect([state.list, state.open]).toEqual([[], false]);
  });

  it('hands the way of showing to the profile', () => {
    const remembered: string[] = [];
    const state = new ConflictsState((mode) => void remembered.push(mode));
    expect(state.mode).toBe('list');
    state.setMode('single');
    expect([state.mode, remembered]).toEqual(['single', ['single']]);
  });
});

describe('the vaults', () => {
  const listed: VaultList = { active: 'main', vaults: [{ name: 'main', label: 'v', main: true }] };
  function host(over: Partial<ConstructorParameters<typeof VaultsState>[0]> = {}) {
    const said: string[] = [];
    return {
      said,
      host: {
        ready: () => true,
        vaults: async () => listed,
        selectVault: async () => undefined,
        addVault: async () => undefined,
        removeVault: async () => undefined,
        say: (kind: string, key: string, params?: Record<string, string>) => void said.push(`${kind}:${key}:${params?.['message'] ?? ''}`),
        ...over,
      } as ConstructorParameters<typeof VaultsState>[0],
    };
  }

  it('reads the list, and tells a hub without a list from one that did not answer', async () => {
    const ok = new VaultsState(host().host);
    expect(await ok.read()).toBe('ok');
    expect(ok.list).toEqual(listed);
    const none = new VaultsState(host({ vaults: async () => Promise.reject(new ApiError(404, 'not_found', 'x')) }).host);
    expect(await none.read()).toBe('none');
    expect([none.list, none.failed]).toEqual([null, false]);
    const down = new VaultsState(host({ vaults: async () => Promise.reject(new Error('network')) }).host);
    expect(await down.read()).toBe('failed');
    expect(down.failed).toBe(true);
  });

  it('opens the dialog only for a page that is ready and has a list', async () => {
    const state = new VaultsState(host().host);
    state.open();
    expect(state.managing).toBe(false);
    await state.read();
    state.open();
    expect(state.managing).toBe(true);
    state.close();
    expect(state.managing).toBe(false);
    const idle = new VaultsState(host({ ready: () => false }).host);
    await idle.read();
    idle.open();
    expect(idle.managing).toBe(false);
  });

  it('does one step at a time, says what it did, and says the hub\'s words when it is refused', async () => {
    let release = (): void => undefined;
    const gate = new Promise<void>((r) => (release = r));
    const h = host({ addVault: () => gate });
    const state = new VaultsState(h.host);
    const first = state.add(' one ', ' /p ');
    expect(state.busy).toBe(true);
    // A second step beside it is not started.
    expect(await state.add('two', '/q')).toBe(false);
    release();
    expect(await first).toBe(true);
    expect(h.said).toEqual(['ok:vaults.added:']);
    expect(state.busy).toBe(false);

    const refused = host({ removeVault: async () => Promise.reject(new ApiError(409, 'busy', 'in use')) });
    const other = new VaultsState(refused.host);
    await other.remove('x');
    expect(refused.said).toEqual(['error:vaults.failed:in use']);
    expect(other.busy).toBe(false);
  });

  it('makes the folder first and remembers it only when that worked; shows the folder, with the words of the hub on a refusal', async () => {
    const calls: string[] = [];
    const ok = host({
      createVault: async (p: string, a: string) => void calls.push(`create ${p} ${a}`),
      addVault: async (n: string, p: string) => void calls.push(`add ${n} ${p}`),
    });
    expect(await new VaultsState(ok.host).create(' n ', ' /p ', ' a ')).toBe(true);
    expect(calls).toEqual(['create /p a', 'add n /p']);
    expect(ok.said).toEqual(['ok:vaults.created:']);

    const added: string[] = [];
    const refused = host({
      createVault: async () => Promise.reject(new ApiError(400, 'not_empty', 'the folder is not empty')),
      addVault: async () => void added.push('add'),
    });
    expect(await new VaultsState(refused.host).create('n', '/p', 'a')).toBe(false);
    expect([added, refused.said]).toEqual([[], ['error:vaults.failed:the folder is not empty']]);

    const shown: string[] = [];
    const reveal = host({ revealVault: async () => void shown.push('reveal') });
    await new VaultsState(reveal.host).reveal();
    expect([shown, reveal.said]).toEqual([['reveal'], []]);
    const gone = host({ revealVault: async () => Promise.reject(new ApiError(404, 'open_unavailable', 'no')) });
    await new VaultsState(gone.host).reveal();
    expect(gone.said).toEqual(['error:vaults.failed:no']);
  });

  it('takes the folder of the dialog, nothing when it was closed, and says why when it could not be shown', async () => {
    const chosen = host({ pickFolder: async () => '/home/me/vault' });
    const state = new VaultsState(chosen.host);
    expect(await state.pick()).toBe('/home/me/vault');
    expect([state.busy, chosen.said]).toEqual([false, []]);
    const closed = host({ pickFolder: async () => null });
    expect(await new VaultsState(closed.host).pick()).toBeNull();
    expect(closed.said).toEqual([]);
    const gone = host({ pickFolder: async () => Promise.reject(new ApiError(404, 'open_unavailable', 'no dialog')) });
    expect(await new VaultsState(gone.host).pick()).toBeNull();
    expect(gone.said).toEqual(['error:vaults.failed:no dialog']);
    // A step under way: no second dialog beside it.
    const busy = host({ pickFolder: async () => '/x' });
    const held = new VaultsState(busy.host);
    held.busy = true;
    expect(await held.pick()).toBeNull();
  });

  it('trims what is added, and runs what the page does before taking the choice of another vault', async () => {
    const added: string[][] = [];
    const order: string[] = [];
    const h = host({
      addVault: async (n: string, p: string) => void added.push([n, p]),
      selectVault: async () => void order.push('hub'),
    });
    const state = new VaultsState(h.host);
    await state.add('  n  ', '  /p  ');
    expect(added).toEqual([['n', '/p']]);
    expect(await state.select('other', async () => void order.push('page'))).toBe(true);
    expect(order).toEqual(['hub', 'page']);
  });
});

describe('the info dialog', () => {
  const doc = { app: 'a', version: '1' } as never;

  it('opens only where the page may show it, and closes', () => {
    let allowed = false;
    const state = new AboutState({ available: () => allowed, about: async () => doc });
    state.open();
    expect(state.dialog.state).toBe('closed');
    allowed = true;
    state.open('report');
    expect(state.dialog).toEqual({ state: 'loading', focus: 'report' });
    state.close();
    expect(state.dialog.state).toBe('closed');
  });

  it('shows the answer of the opening it belongs to and not one that was closed meanwhile', async () => {
    let release = (): void => undefined;
    const gate = new Promise<void>((r) => (release = r));
    const state = new AboutState({ available: () => true, about: async () => (await gate, doc) });
    state.open();
    state.close();
    release();
    await vi.waitFor(() => expect(state.dialog.state).toBe('closed'));
    await Promise.resolve();
    expect(state.dialog.state).toBe('closed');
  });

  it('says why when the hub does not answer', async () => {
    const state = new AboutState({ available: () => true, about: async () => Promise.reject(new Error('no answer')) });
    state.open();
    await vi.waitFor(() => expect(state.dialog).toEqual({ state: 'failed', message: 'no answer' }));
  });
});

describe('the start page layout', () => {
  function profile(initial: Record<string, string> = {}) {
    const store = new Map(Object.entries(initial));
    return {
      store,
      host: { lang: () => 'en' as const, getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) },
    };
  }

  it('reads the profile back, and drops what is not a known block', () => {
    const p = profile({ 'tasks-desktop.tiles-hidden': '["next","nonsense","daily"]', 'tasks-desktop.tiles-order': '["waiting","next","remind","cdx"]' });
    const state = new TodayState(p.host);
    expect(state.hidden).toEqual(['next', 'daily']);
    expect(state.order).toEqual(['waiting', 'next', 'remind', 'cdx']);
    expect(state.orderChanged).toBe(true);
  });

  it('hides a block once, shows all again, and keeps each in the profile', () => {
    const p = profile();
    const state = new TodayState(p.host);
    state.hide('next');
    state.hide('next');
    expect(state.hidden).toEqual(['next']);
    expect(p.store.get('tasks-desktop.tiles-hidden')).toBe('["next"]');
    state.showAll();
    expect(p.store.get('tasks-desktop.tiles-hidden')).toBe('[]');
  });

  it('moves a block and says where it is now, and puts the order back', () => {
    const p = profile();
    const state = new TodayState(p.host);
    state.move('next', 'waiting', true, ['next', 'waiting', 'remind', 'cdx']);
    expect(state.order.slice(0, 2)).toEqual(['waiting', 'next']);
    expect(state.note).toContain('2');
    expect(p.store.get('tasks-desktop.tiles-order')).toContain('waiting');
    state.resetOrder();
    expect(state.orderChanged).toBe(false);
  });

  it('opens a number, walks its views with the key, and keeps the choice of the views and of the tile Today', () => {
    const p = profile();
    const state = new TodayState(p.host);
    state.cycleCountView('doing');
    expect(state.countOpen).toBe('doing');
    const first = state.countView('doing');
    state.cycleCountView('doing');
    expect(state.countView('doing')).not.toBe(first);
    expect(p.store.get('tasks-desktop.count-views')).toContain('doing');
    state.toggleCount('doing');
    expect(state.countOpen).toBeNull();
    state.setDaily({ mode: 'week', metrics: ['finished'] });
    expect(new TodayState(p.host).daily).toEqual({ mode: 'week', metrics: ['finished'] });
  });
});

describe('the views', () => {
  /** A host whose answers come when the test lets them (`answer`), each for the question it was asked for. */
  function pending() {
    const views: ((doc: Views) => void)[] = [];
    const groupings: ((doc: Groupings) => void)[] = [];
    let rev: string | undefined = 'rev:1';
    const host: ViewsHost = {
      can: () => true,
      rev: () => rev,
      views: () => new Promise<Views>((resolve) => views.push(resolve)),
      groupings: () => new Promise<Groupings>((resolve) => groupings.push(resolve)),
      write: async () => null,
      remembered: () => null,
      remember: () => undefined,
    };
    return { host, views, groupings, setRev: (r: string | undefined) => void (rev = r) };
  }
  const viewsDoc = { rev: 'v:1', views: [{ id: 'pub/a' }] } as unknown as Views;
  const groupingsDoc = { rev: 'rev:1', fields: [] } as unknown as Groupings;

  it('takes no answer to a question asked before it forgot (the session was lost meanwhile)', async () => {
    const p = pending();
    const state = new ViewsState(p.host);
    const loading = state.load();
    const grouping = state.loadGroupings();
    state.forget();
    // The page has no snapshot any more: `loadGroupings` would keep an answer for any state while none is held.
    p.setRev(undefined);
    p.views[0]!(viewsDoc);
    p.groupings[0]!(groupingsDoc);
    await Promise.all([loading, grouping]);
    expect(state.doc).toBeNull();
    expect(state.groupings).toBeNull();
  });

  it('forgets what was read and asks again afterwards', async () => {
    const p = pending();
    const state = new ViewsState(p.host);
    const loading = state.load();
    p.views[0]!(viewsDoc);
    await loading;
    const grouping = state.loadGroupings();
    p.groupings[0]!(groupingsDoc);
    await grouping;
    expect(state.groupingsNow?.rev).toBe('rev:1');
    state.forget();
    expect([state.doc, state.groupings]).toEqual([null, null]);
    // The same state is asked again (the groupings held were forgotten), and its answer is kept.
    const again = state.loadGroupings();
    expect(p.groupings).toHaveLength(2);
    p.groupings[1]!(groupingsDoc);
    await again;
    expect(state.groupingsNow?.rev).toBe('rev:1');
  });

  it('read only, a fold stays in the page and nothing is written; writing, the fold goes to the view', async () => {
    const p = pending();
    const written: unknown[] = [];
    let readOnly = true;
    p.host.write = async (ops) => (written.push(ops), null);
    p.host.readOnly = () => readOnly;
    const state = new ViewsState(p.host);
    const view = { id: 'pub/a', area: 'pub', title: 'A', display: 'list', group_by: 'status', collapsed: ['done'], select: {}, etag: 'e1' } as unknown as View;
    expect(state.collapsedOf(view)).toEqual(['done']);
    expect(await state.toggle(view, { title: 'A', display: 'list', group_by: 'status', collapsed: ['done'] } as never, 'open')).toBe(true);
    expect(state.collapsedOf(view)).toEqual(['done', 'open']);
    await state.toggle(view, { title: 'A', display: 'list', group_by: 'status', collapsed: ['done'] } as never, 'done');
    expect(state.collapsedOf(view)).toEqual(['open']);
    expect(written).toEqual([]);
    readOnly = false;
    await state.toggle({ ...view, id: 'pub/b' } as View, { title: 'A', display: 'list', group_by: 'status', collapsed: [] } as never, 'open');
    expect(written).toHaveLength(1);
  });
});
