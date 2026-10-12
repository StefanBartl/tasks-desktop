import { describe, expect, it } from 'vitest';
import { ApiError, type Hub, type HubArea } from './api';
import { App, type Env } from './app.svelte';
import type { CachedList, ListStore } from './cache';
import type { Snapshot, TaskDocument, TaskEntry } from './contract';
import { task } from './fixtures';

function snapshot(tasks: TaskEntry[], rev = 'rev:1'): Snapshot {
  return {
    kind: 'tasks.snapshot',
    vault: { id: 'v' },
    rev,
    digest: rev,
    tasks,
    counts: { listed: tasks.length, unlisted: 0, by_status: {} },
  } as unknown as Snapshot;
}

class FakeHub {
  token: string | null = null;
  onUnauthorized: () => void = () => {};
  doc: Snapshot = snapshot([task('pub/a', { etag: 'e1' })]);
  areaList: HubArea[] = [{ name: 'pub', data_class: 'public' }];
  snapshotCalls: (string | null)[] = [];
  engineReady = true;
  hubDown = false;
  exchanged: string[] = [];
  rescans = 0;

  setToken(t: string | null) {
    this.token = t;
  }
  get hasToken() {
    return this.token !== null;
  }
  get bearer() {
    return this.token ?? '';
  }
  url(p: string) {
    return p;
  }
  async hello() {
    if (this.hubDown) throw new Error('down');
    return { instance: 'i', version: '0', engine: { ready: this.engineReady, problem: 'x' } };
  }
  async exchange(code: string) {
    this.exchanged.push(code);
    return 'token-1';
  }
  async snapshot(etag: string | null) {
    this.snapshotCalls.push(etag);
    if (!this.token) throw new ApiError(401, 'unauthorized', 'x');
    return { kind: 'fresh' as const, doc: this.doc, etag: this.doc.digest ?? null };
  }
  async areas() {
    return { areas: this.areaList, unclassified: [], private: [] };
  }
  async next() {
    return { alternatives: [], cdx: [], incomplete: [] };
  }
  async task(id: string): Promise<TaskDocument> {
    return { task: this.doc.tasks.find((t) => t.id === id), body: 'body', steps: [] } as never;
  }
  async rescan() {
    this.rescans += 1;
  }
}

function make(overrides: { token?: string; cached?: CachedList | null } = {}) {
  const hub = new FakeHub();
  const saved: CachedList[] = [];
  let cleared = 0;
  const cache: ListStore = {
    load: async () => overrides.cached ?? null,
    save: async (l) => void saved.push(l),
    clear: async () => void (cleared += 1),
  };
  const session = new Map<string, string>();
  if (overrides.token) session.set('tasks-desktop.session', overrides.token);
  const env: Env = {
    hub: hub as unknown as Hub,
    cache,
    session: {
      getItem: (k) => session.get(k) ?? null,
      setItem: (k, v) => void session.set(k, v),
      removeItem: (k) => void session.delete(k),
    },
    prefs: { getItem: () => null, setItem: () => {} },
    preferredLanguages: ['de'],
    now: () => 1000,
    // The stream is not under test here: it is refused, and the loop stops
    // because the test stops the app.
    fetchFn: (async () => new Response('', { status: 503 })) as typeof fetch,
    sleep: async () => {
      await new Promise((r) => setTimeout(r, 1));
    },
  };
  return { app: new App(env), hub, saved, session, cleared: () => cleared };
}

describe('App', () => {
  it('uses the browser language', () => {
    expect(make().app.lang).toBe('de');
  });

  it('asks for pairing when there is no code and no session', async () => {
    const { app } = make();
    await app.start(null);
    expect(app.phase).toBe('needs_pairing');
    app.stop();
  });

  it('trades a code for a session, keeps it in the tab and reads the list', async () => {
    const { app, hub, session } = make();
    await app.start('ab'.repeat(16));
    expect(hub.exchanged).toEqual(['ab'.repeat(16)]);
    expect(session.get('tasks-desktop.session')).toBe('token-1');
    expect(app.phase).toBe('ready');
    expect(app.tasks.map((t) => t.id)).toEqual(['pub/a']);
    app.stop();
  });

  it('shows the cached list first and replaces it with the fresh one', async () => {
    const cached: CachedList = {
      vault: 'v',
      rev: 'rev:0',
      etag: 'old',
      savedAt: 5,
      tasks: [task('pub/old')],
    };
    const { app, hub } = make({ token: 't', cached });
    await app.start(null);
    // The conditional request carried the cached tag.
    expect(hub.snapshotCalls[0]).toBe('old');
    expect(app.tasks.map((t) => t.id)).toEqual(['pub/a']);
    expect(app.cachedAt).toBeNull();
    app.stop();
  });

  it('writes only what the classes allow into the cache', async () => {
    const { app, hub, saved } = make({ token: 't' });
    hub.doc = snapshot([task('pub/a'), task('priv/b')]);
    hub.areaList = [
      { name: 'pub', data_class: 'public' },
      { name: 'priv', data_class: 'private' },
    ];
    await app.start(null);
    expect(app.tasks.length).toBe(2);
    expect(saved[0]?.tasks.map((t) => t.id)).toEqual(['pub/a']);
    app.stop();
  });

  it('keeps the selection on the task id across a refresh and clears it when the task is gone', async () => {
    const { app, hub } = make({ token: 't' });
    hub.doc = snapshot([task('pub/a', { etag: 'e1' }), task('pub/b', { etag: 'e1' })], 'rev:1');
    await app.start(null);
    app.select('pub/b');
    hub.doc = snapshot([task('pub/b', { etag: 'e1' }), task('pub/a', { etag: 'e1' })], 'rev:2');
    await app.refresh();
    expect(app.selectedId).toBe('pub/b');
    hub.doc = snapshot([task('pub/a', { etag: 'e1' })], 'rev:3');
    await app.refresh();
    expect(app.selectedId).toBeNull();
    app.stop();
  });

  it('drops the session and the data when the hub says it is gone', async () => {
    const { app, hub, session } = make({ token: 't' });
    await app.start(null);
    expect(app.tasks.length).toBe(1);
    hub.onUnauthorized();
    expect(app.phase).toBe('needs_pairing');
    expect(app.tasks).toEqual([]);
    expect(session.has('tasks-desktop.session')).toBe(false);
    app.stop();
  });

  it('says so when the engine is not ready', async () => {
    const { app, hub } = make({ token: 't' });
    hub.engineReady = false;
    const started = app.start(null);
    await new Promise((r) => setTimeout(r, 20));
    expect(app.phase).toBe('unavailable');
    expect(app.problem).toBe('x');
    app.stop();
    hub.engineReady = true;
    await started;
  });

  it('asks the hub for a scan when the window gets the focus', async () => {
    const { app, hub } = make({ token: 't' });
    await app.start(null);
    await app.focused();
    expect(hub.rescans).toBe(1);
    app.stop();
  });
});
