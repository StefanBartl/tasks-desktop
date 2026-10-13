import { describe, expect, it } from 'vitest';
import { ApiError, type Hub, type HubArea, type OpsRequest } from './api';
import { App, type Env } from './app.svelte';
import type { CachedList, ListStore } from './cache';
import type { DonePreview, Result, Snapshot, TaskDocument, TaskEntry } from './contract';
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
  exchangeFails = false;
  rescans = 0;
  areasCalls = 0;
  nextCalls = 0;

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
    if (this.exchangeFails) throw new ApiError(401, 'bad_code', 'x');
    return 'token-1';
  }
  async snapshot(etag: string | null) {
    this.snapshotCalls.push(etag);
    if (!this.token) throw new ApiError(401, 'unauthorized', 'x');
    if (etag !== null && etag === this.doc.digest) return { kind: 'not_modified' as const };
    return { kind: 'fresh' as const, doc: this.doc, etag: this.doc.digest ?? null };
  }
  async areas() {
    this.areasCalls += 1;
    return { areas: this.areaList, unclassified: [], private: [] };
  }
  async next() {
    this.nextCalls += 1;
    return { alternatives: [], cdx: [], incomplete: [] };
  }
  taskSignals: AbortSignal[] = [];
  async task(id: string, signal?: AbortSignal): Promise<TaskDocument> {
    if (signal) this.taskSignals.push(signal);
    return { task: this.doc.tasks.find((t) => t.id === id), body: 'body', steps: [] } as never;
  }
  searches: string[] = [];
  searchStatus: 'ready' | 'building' = 'ready';
  async search(query: string) {
    this.searches.push(query);
    return {
      status: this.searchStatus,
      indexed: 1,
      total: 1,
      hits: [{ id: 'pub/a', score: 1, snippet: { text: 'x needle y', marks: [[2, 8]] as [number, number][], more_before: false, more_after: false } }],
    };
  }
  async rescan() {
    this.rescans += 1;
  }
  sent: OpsRequest[] = [];
  /** What the next write answers (an error to throw, or a result). */
  next_ops: Result | ApiError | null = null;
  previews = new Map<string, Partial<DonePreview>>();
  async ops(request: OpsRequest): Promise<Result> {
    this.sent.push(request);
    const answer = this.next_ops;
    this.next_ops = null;
    if (answer instanceof ApiError) throw answer;
    if (answer) return answer;
    return {
      kind: 'tasks.result',
      ok: true,
      dry_run: false,
      results: request.ops.map((op, i) => ({
        n: i + 1,
        op: op.op,
        id: op.op === 'new' ? 'pub/created' : op.id,
        ok: true,
        outcome: op.op === 'new' ? 'created' : 'changed',
        changed_ids: [],
        ...(op.op === 'set'
          ? { inverse: { op: 'set', id: op.id, patch: { status: 'open' }, if_match: 'e2' } }
          : {}),
      })),
    } as unknown as Result;
  }
  async donePreview(id: string): Promise<DonePreview> {
    return { kind: 'tasks.donepreview', id, to: 'DONE/x.md', confirm: 'tok', ...this.previews.get(id) } as DonePreview;
  }
}

function make(
  overrides: { token?: string; cached?: CachedList | null; prefs?: Map<string, string> } = {},
) {
  const prefs = overrides.prefs ?? new Map<string, string>();
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
    prefs: {
      getItem: (k) => prefs.get(k) ?? null,
      setItem: (k, v) => void prefs.set(k, v),
    },
    preferredLanguages: ['de'],
    now: () => 1000,
    // The stream is not under test here: it is refused, and the loop stops
    // because the test stops the app.
    fetchFn: (async () => new Response('', { status: 503 })) as typeof fetch,
    sleep: async () => {
      await new Promise((r) => setTimeout(r, 1));
    },
  };
  return { app: new App(env), hub, saved, session, prefs, cleared: () => cleared };
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
    // The cache holds a part of the document: the first read is not
    // conditional on its tag.
    expect(hub.snapshotCalls[0]).toBeNull();
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
    // The cache is written after the list is shown, once the classes are known.
    await new Promise((r) => setTimeout(r, 10));
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

  it('reveals a task a filter hides: the filter and its text search go, the list is shown', async () => {
    const { app, hub } = make({ token: 't' });
    hub.doc = snapshot([task('pub/a', { status: 'open' }), task('pub/b')], 'rev:1');
    await app.start(null);
    // The words of the filter and the result of their search, as the page holds them.
    app.filter = { ...app.filter, query: 'zzz' };
    app.textSearch = { query: 'zzz', result: { status: 'ready', indexed: 1, total: 1, hits: [] } };
    expect(app.shown.length).toBe(0);
    app.setView('today');
    app.reveal('pub/b');
    expect(app.filter.query).toBe('');
    expect(app.textSearch).toBeNull();
    expect(app.selectedId).toBe('pub/b');
    expect(app.view).toBe('list');
    app.stop();
  });

  it('does not search the text of words that a reveal took away', async () => {
    const { app, hub } = make({ token: 't' });
    hub.doc = snapshot([task('pub/a'), task('pub/b')], 'rev:1');
    await app.start(null);
    // The search of 'zzz' is armed (it starts a moment after the last key) ...
    app.setQuery('zzz');
    app.reveal('pub/b');
    // ... and does not start: its words are gone.
    await new Promise((r) => setTimeout(r, 400));
    expect(hub.searches).toEqual([]);
    expect(app.textSearch).toBeNull();
    app.stop();
  });

  it('leaves the filter and the text search alone when nothing hides the task', async () => {
    const { app, hub } = make({ token: 't' });
    hub.doc = snapshot([task('pub/a', { status: 'open' }), task('pub/b')], 'rev:1');
    await app.start(null);
    app.filter = { ...app.filter, statuses: ['open'], query: 'pub/a' };
    const found = { query: 'pub/a', result: { status: 'ready' as const, indexed: 1, total: 1, hits: [] } };
    app.textSearch = found;
    app.reveal('pub/a');
    expect(app.filter.statuses).toEqual(['open']);
    expect(app.filter.query).toBe('pub/a');
    expect(app.textSearch).toBe(found);
    expect(app.selectedId).toBe('pub/a');
    app.stop();
  });

  it('selects an id it does not know and shows the list, and leaves the filter as it is', async () => {
    const { app } = make({ token: 't' });
    await app.start(null);
    app.filter = { ...app.filter, statuses: ['doing'] };
    app.setView('today');
    app.reveal('pub/unknown');
    expect(app.filter.statuses).toEqual(['doing']);
    expect(app.selectedId).toBe('pub/unknown');
    expect(app.view).toBe('list');
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

describe('App, cache and hub', () => {
  it('does not let a not-modified answer leave the cached part standing for the list', async () => {
    const cached: CachedList = {
      vault: 'v',
      rev: 'rev:1',
      etag: 'rev:1',
      savedAt: 5,
      tasks: [task('pub/a', { etag: 'e1' })],
    };
    const { app, hub } = make({ token: 't', cached });
    // The hub's document has one task more than the cache (a private one).
    hub.doc = snapshot([task('pub/a', { etag: 'e1' }), task('priv/b', { etag: 'e2' })], 'rev:1');
    await app.start(null);
    expect(app.tasks.map((t) => t.id)).toEqual(['pub/a', 'priv/b']);
    expect(app.snapshot).not.toBeNull();
    // From now on the tag is sent, and the answer may be "not modified".
    await app.refresh();
    expect(hub.snapshotCalls.at(-1)).toBe('rev:1');
    expect(app.tasks.length).toBe(2);
    app.stop();
  });

  it('shows the cached list while the hub is not there', async () => {
    const cached: CachedList = {
      vault: 'v',
      rev: null,
      etag: null,
      savedAt: 5,
      tasks: [task('pub/old')],
    };
    const { app, hub } = make({ token: 't', cached });
    hub.hubDown = true;
    const started = app.start(null);
    await new Promise((r) => setTimeout(r, 30));
    expect(app.phase).toBe('ready');
    expect(app.cachedAt).toBe(5);
    expect(app.tasks.map((t) => t.id)).toEqual(['pub/old']);
    expect(app.connection).toBe('offline');
    app.stop();
    hub.hubDown = false;
    await started;
  });

  it('keeps the session of the tab when the code of the link is no good', async () => {
    const { app, hub } = make({ token: 'kept' });
    hub.exchangeFails = true;
    await app.start('ab'.repeat(16));
    expect(app.phase).toBe('ready');
    expect(hub.token).toBe('kept');
    app.stop();
  });

  it('reads the classes once and the next task once for one list', async () => {
    const { app, hub } = make({ token: 't' });
    await app.start(null);
    await new Promise((r) => setTimeout(r, 10));
    await app.refresh();
    await app.refresh();
    await new Promise((r) => setTimeout(r, 10));
    expect(hub.areasCalls).toBe(1);
    expect(hub.nextCalls).toBe(1);
    // A changed list is a new question for `next`.
    hub.doc = snapshot([task('pub/a', { etag: 'e2' })], 'rev:2');
    await app.refresh();
    await new Promise((r) => setTimeout(r, 10));
    expect(hub.nextCalls).toBe(2);
    expect(hub.areasCalls).toBe(1);
    app.stop();
  });

  it('shows the list before the classes and the next task are known', async () => {
    const { app, hub } = make({ token: 't' });
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    const original = hub.areas.bind(hub);
    hub.areas = async () => {
      await gate;
      return original();
    };
    await app.start(null);
    expect(app.tasks.length).toBe(1);
    expect(app.phase).toBe('ready');
    release();
    app.stop();
  });
});

describe('App, reading one task at a time', () => {
  it('drops the request of a task that was passed on the way', async () => {
    const { app, hub } = make({ token: 't' });
    hub.doc = snapshot([task('pub/a'), task('pub/b'), task('pub/c')], 'rev:1');
    await app.start(null);
    app.select('pub/a');
    app.select('pub/b');
    app.select('pub/c');
    await new Promise((r) => setTimeout(r, 10));
    expect(hub.taskSignals.map((signal) => signal.aborted)).toEqual([true, true, false]);
    expect(app.detail.state).toBe('ok');
    app.stop();
  });

  it('is not a failure when a read was dropped', async () => {
    const { app, hub } = make({ token: 't' });
    hub.doc = snapshot([task('pub/a'), task('pub/b')], 'rev:1');
    hub.task = async (_id: string, signal?: AbortSignal) => {
      await new Promise((r) => setTimeout(r, 20));
      if (signal?.aborted) throw new DOMException('aborted', 'AbortError');
      return { task: hub.doc.tasks[0], body: '', steps: [] } as never;
    };
    await app.start(null);
    app.select('pub/a');
    app.select('pub/b');
    app.select(null);
    await new Promise((r) => setTimeout(r, 60));
    expect(app.detail.state).toBe('none');
    app.stop();
  });
});

describe('App, the view', () => {
  it('opens on the view it was left on', async () => {
    const prefs = new Map<string, string>();
    const first = make({ token: 't', prefs });
    expect(first.app.view).toBe('today');
    first.app.setView('list');
    expect(prefs.get('tasks-desktop.view')).toBe('list');
    const second = make({ token: 't', prefs });
    expect(second.app.view).toBe('list');
    // Anything else in the store is not a view.
    prefs.set('tasks-desktop.view', '<img src=x>');
    expect(make({ token: 't', prefs }).app.view).toBe('today');
  });
});

describe('App, the text of the tasks', () => {
  it('filters at once and searches the text a moment later, once', async () => {
    const { app, hub } = make({ token: 't' });
    await app.start(null);
    app.setQuery('n');
    app.setQuery('ne');
    app.setQuery('nee');
    expect(app.filter.query).toBe('nee');
    // Not yet: the person is still typing.
    expect(hub.searches).toEqual([]);
    await new Promise((r) => setTimeout(r, 400));
    expect(hub.searches).toEqual(['nee']);
    expect(app.textSearch?.result.hits[0]?.id).toBe('pub/a');
    // Cleared: the result goes with it.
    app.setQuery('');
    expect(app.textSearch).toBeNull();
    app.stop();
  });

  it('does not search the text for one letter', async () => {
    const { app, hub } = make({ token: 't' });
    await app.start(null);
    app.setQuery('a');
    await new Promise((r) => setTimeout(r, 350));
    expect(hub.searches).toEqual([]);
    app.stop();
  });

  it('asks again while the hub is still reading the texts', async () => {
    const { app, hub } = make({ token: 't' });
    await app.start(null);
    hub.searchStatus = 'building';
    app.setQuery('needle');
    await new Promise((r) => setTimeout(r, 400));
    expect(app.textSearch?.result.status).toBe('building');
    hub.searchStatus = 'ready';
    await new Promise((r) => setTimeout(r, 1800));
    expect(app.textSearch?.result.status).toBe('ready');
    expect(hub.searches.length).toBe(2);
    app.stop();
  });
});

describe('writing', () => {
  async function ready() {
    const m = make({ token: 't' });
    await m.app.start(null);
    expect(m.app.phase).toBe('ready');
    m.app.stop();
    return m;
  }

  it('sets a key with the version of the file that was shown, and offers the way back', async () => {
    const { app, hub } = await ready();
    const reads = hub.snapshotCalls.length;
    await app.setField('pub/a', 'status', 'doing');
    expect(hub.sent).toHaveLength(1);
    expect(hub.sent[0]?.ops).toEqual([
      { op: 'set', id: 'pub/a', patch: { status: 'doing' }, if_match: 'e1' },
    ]);
    expect(hub.sent[0]?.client_op_id).toMatch(/^ui-/);
    expect(app.toast?.kind).toBe('ok');
    expect(app.toast?.undo).toEqual([
      { op: 'set', id: 'pub/a', patch: { status: 'open' }, if_match: 'e2' },
    ]);
    // The list is read again after a write, whatever the answer says.
    expect(hub.snapshotCalls.length).toBeGreaterThan(reads);
    expect(app.saving).toBe(false);
  });

  it('sends a list for tags and a number for the value, and clears a field with null', async () => {
    const { app, hub } = await ready();
    await app.setField('pub/a', 'tags', ['ui', 'docs']);
    await app.setField('pub/a', 'value', 4);
    await app.setField('pub/a', 'effort', null);
    expect(hub.sent.map((s) => s.ops[0])).toMatchObject([
      { op: 'set', id: 'pub/a', patch: { tags: ['ui', 'docs'] } },
      { op: 'set', id: 'pub/a', patch: { value: 4 } },
      { op: 'set', id: 'pub/a', patch: { effort: null } },
    ]);
  });

  it('sends the inverse on undo, once', async () => {
    const { app, hub } = await ready();
    await app.setField('pub/a', 'prio', 1);
    await app.undo();
    expect(hub.sent).toHaveLength(2);
    expect(hub.sent[1]?.ops[0]).toMatchObject({ op: 'set', id: 'pub/a', patch: { status: 'open' } });
    // Undoing is not undoable again.
    expect(app.toast?.undo).toBeUndefined();
  });

  it('says a conflict and keeps nothing it guessed', async () => {
    const { app, hub } = await ready();
    hub.next_ops = {
      kind: 'tasks.result',
      ok: false,
      dry_run: false,
      results: [
        {
          n: 1,
          op: 'set',
          id: 'pub/a',
          ok: false,
          outcome: 'failed',
          changed_ids: [],
          error: { code: 'conflict', message: 'x', retryable: false },
        },
      ],
    } as unknown as Result;
    await app.setField('pub/a', 'status', 'doing');
    expect(app.toast?.kind).toBe('error');
    expect(app.toast?.undo).toBeUndefined();
    expect(app.toast?.text).toMatch(/inzwischen|meanwhile/);
  });

  it('tells a write whose result is not known', async () => {
    const { app, hub } = await ready();
    hub.next_ops = new ApiError(502, 'outcome_unknown', 'x');
    await app.setField('pub/a', 'status', 'doing');
    expect(app.toast?.kind).toBe('error');
    expect(app.toast?.text).toMatch(/nicht bekannt|not known/);
  });

  it('selects the task it created and closes the capture', async () => {
    const { app, hub } = await ready();
    app.openCapture();
    expect(app.capturing).toBe(true);
    await app.createTask('pub', 'A new thing', { prio: 2 });
    expect(hub.sent[0]?.ops[0]).toEqual({ op: 'new', area: 'pub', title: 'A new thing', fields: { prio: 2 } });
    expect(app.capturing).toBe(false);
    expect(app.selectedId).toBe('pub/created');
    expect(app.view).toBe('list');
  });

  it('takes away a filter that hides the task it created', async () => {
    const { app, hub } = await ready();
    app.filter = { ...app.filter, statuses: ['doing'] };
    // The list read after the write holds the new task; it has no status, so the filter hides it.
    hub.doc = snapshot([task('pub/a', { status: 'doing' }), task('pub/created')], 'rev:2');
    await app.createTask('pub', 'A new thing');
    expect(app.tasks.map((t) => t.id)).toEqual(['pub/a', 'pub/created']);
    expect(app.filter.statuses).toEqual([]);
    expect(app.selectedId).toBe('pub/created');
    expect(app.shown.map((t) => t.id)).toContain('pub/created');
  });

  it('knows the task it created although a read was running when the write was answered', async () => {
    const { app, hub } = make({ token: 't' });
    hub.doc = snapshot([task('pub/a', { status: 'doing' })], 'rev:1');
    await app.start(null);
    app.filter = { ...app.filter, statuses: ['doing'] };
    // The event of the hub came first: a read is under way (it began before the
    // file existed) and holds its answer back.
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    const original = hub.snapshot.bind(hub);
    let reads = 0;
    hub.snapshot = async (etag: string | null) => {
      reads += 1;
      if (reads > 1) return original(etag);
      const stale = hub.doc;
      await gate;
      return { kind: 'fresh' as const, doc: stale, etag: stale.digest ?? null };
    };
    const reading = app.refresh();
    const creating = app.createTask('pub', 'A new thing');
    await new Promise((r) => setTimeout(r, 5));
    hub.doc = snapshot([task('pub/a', { status: 'doing' }), task('pub/created')], 'rev:2');
    release();
    await Promise.all([reading, creating]);
    // The write returned when the list was current, not before.
    expect(app.tasks.map((t) => t.id)).toEqual(['pub/a', 'pub/created']);
    expect(app.filter.statuses).toEqual([]);
    expect(app.selectedId).toBe('pub/created');
    app.stop();
  });

  it('finishes in two steps: the preview, then the token it gave', async () => {
    const { app, hub } = await ready();
    await app.startFinish('pub/a');
    expect(app.finishing?.id).toBe('pub/a');
    expect(hub.sent).toHaveLength(0);
    await app.confirmFinish();
    expect(hub.sent[0]?.ops).toEqual([{ op: 'done', id: 'pub/a', confirm: 'tok' }]);
    expect(app.finishing).toBeNull();
  });

  it('does not ask again for a task that is finished already', async () => {
    const { app, hub } = await ready();
    hub.previews.set('pub/a', { already: true });
    await app.startFinish('pub/a');
    expect(app.finishing).toBeNull();
    expect(app.toast?.kind).toBe('ok');
    expect(hub.sent).toHaveLength(0);
  });

  it('counts every ended write, so a control is drawn from the model again', async () => {
    const { app, hub } = await ready();
    expect(app.writes).toBe(0);
    hub.next_ops = new ApiError(409, 'conflict', 'x');
    await app.setField('pub/a', 'status', 'doing');
    expect(app.writes).toBe(1);
    await app.setField('pub/a', 'status', 'doing');
    expect(app.writes).toBe(2);
  });

  it('offers an area that has no open task for a new one', async () => {
    const { app, hub } = make({ token: 't' });
    hub.areaList = [
      { name: 'pub', data_class: 'public' },
      { name: 'empty.nvim', data_class: 'internal' },
    ];
    await app.start(null);
    // The classes of the areas are read after the first list is shown.
    for (let i = 0; i < 50 && app.hubAreas.length === 0; i += 1) {
      await new Promise((r) => setTimeout(r, 5));
    }
    app.stop();
    expect(app.areaNames).toEqual(['pub']);
    expect(app.allAreaNames.sort()).toEqual(['empty.nvim', 'pub']);
  });

  it('says that a name is taken', async () => {
    const { app, hub } = await ready();
    hub.next_ops = {
      kind: 'tasks.result',
      ok: false,
      dry_run: false,
      results: [
        { n: 1, op: 'new', ok: false, outcome: 'failed', changed_ids: [], error: { code: 'exists', message: 'x', retryable: false } },
      ],
    } as unknown as Result;
    await app.createTask('pub', 'Same', {});
    expect(app.toast?.kind).toBe('error');
    expect(app.toast?.text).toMatch(/schon|already/);
  });

  it('sets and takes away a reminder through set, in the words the engine reads', async () => {
    const { app, hub } = await ready();
    await app.setField('pub/a', 'remind', '+7d');
    expect(hub.sent[0]?.ops[0]).toMatchObject({ op: 'set', id: 'pub/a', patch: { remind: '+7d' } });
    await app.setField('pub/a', 'remind', null);
    expect(hub.sent[1]?.ops[0]).toMatchObject({ patch: { remind: null } });
  });

  it('finishes with a reminder when one is chosen, and without when not', async () => {
    const { app, hub } = await ready();
    await app.startFinish('pub/a');
    await app.confirmFinish('+14d');
    expect(hub.sent[0]?.ops).toEqual([{ op: 'done', id: 'pub/a', confirm: 'tok', remind: '+14d' }]);
    await app.startFinish('pub/a');
    await app.confirmFinish();
    expect(hub.sent[1]?.ops).toEqual([{ op: 'done', id: 'pub/a', confirm: 'tok' }]);
  });

  it('does nothing before the page is ready', async () => {
    const { app, hub } = make({ token: 't' });
    await app.setField('pub/a', 'status', 'doing');
    expect(hub.sent).toHaveLength(0);
    app.openCapture();
    expect(app.capturing).toBe(false);
  });
});
