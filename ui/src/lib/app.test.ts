import { describe, expect, it, vi } from 'vitest';
import { ApiError, type Hub, type HubArea, type OpsRequest, type VaultList } from './api';
import { App, type Env } from './app.svelte';
import type { CachedList, ListStore } from './cache';
import type { DonePreview, Groupings, Result, Snapshot, TaskDocument, TaskEntry, View, Views } from './contract';
import { task } from './fixtures';
import { MOVE_MAX } from './bulk';
import { translate } from './i18n';
import { emptyForm } from './planwizard';
import { paletteActions } from './paletteActions';
import { emptySelect, formOf, type ViewForm } from './views';
import type { Grouping } from './groups';
import { DRAFT_ID } from './state/views.svelte';

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
  capabilities: string[] | null = ['reorder', 'plan_new', 'eff_prio', 'estimate', 'plan_for', 'check'];
  hubDown = false;
  exchanged: string[] = [];
  exchangeFails = false;
  /** The next n trades are refused (a 401), the ones after are not. */
  failNext = 0;
  /** A trade that fails the way a dead network does, with no answer from the hub. */
  exchangeNetworkFail = false;
  /** A trade waits for this before it answers. */
  exchangeGate: Promise<void> | null = null;
  rescans = 0;
  areasCalls = 0;
  nextCalls = 0;
  /** The lists of the engine, as `lists` answers them (null: the hub has none). */
  engineListDoc: unknown = null;
  listsCalls = 0;
  /** The answers of `order` by word (a word without one is refused as the engine would). */
  orders = new Map<string, string[]>();
  orderCalls: string[] = [];

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
    return { instance: 'i', version: '0', engine: { ready: this.engineReady, problem: 'x', capabilities: this.capabilities } };
  }
  /** Each answer of `about` waits for the next of these gates first (none: it answers at once). */
  aboutGates: Promise<void>[] = [];
  aboutCalls = 0;
  async about() {
    this.aboutCalls += 1;
    const gate = this.aboutGates.shift();
    if (gate) await gate;
    if (this.hubDown) throw new Error('down');
    return {
      app: 'tasks-desktop',
      version: '0',
      build: null,
      os: 'test',
      arch: 'x',
      engine: this.engineReady ? { version: '0', git: 'abc1234', nvim: '0' } : null,
      engineProblem: null,
      pinned: { engine: 'abc1234abc1234abc1234abc1234abc1234abc12', lib: null },
    };
  }
  async exchange(code: string) {
    this.exchanged.push(code);
    if (this.exchangeGate) await this.exchangeGate;
    if (this.exchangeNetworkFail) throw new TypeError('network');
    if (this.failNext > 0) {
      this.failNext -= 1;
      throw new ApiError(401, 'bad_code', 'x');
    }
    if (this.exchangeFails) throw new ApiError(401, 'bad_code', 'x');
    return 'token-1';
  }
  /** What the check job answers, one answer for each start and each ask of the state, in the order given. */
  checkAnswers: unknown[] = [];
  checkStarts: { stale?: string }[] = [];
  checkStates = 0;
  checkError: ApiError | null = null;
  async checkState() {
    this.checkStates += 1;
    if (this.checkError) throw this.checkError;
    return (this.checkAnswers.shift() ?? { state: 'idle' }) as never;
  }
  async checkStart(request: { stale?: string }) {
    this.checkStarts.push(request);
    if (this.checkError) throw this.checkError;
    return (this.checkAnswers.shift() ?? { state: 'running', id: 1 }) as never;
  }
  graphs: { id: string; direction: string }[] = [];
  graphError: ApiError | null = null;
  /** Questions of the graph that wait for these promises, in the order asked. */
  graphHold: Promise<void>[] = [];
  async planFor(id: string, direction: 'needs' | 'unlocks') {
    this.graphs.push({ id, direction });
    const held = this.graphHold.shift();
    if (held) await held;
    if (this.graphError) throw this.graphError;
    return {
      kind: 'tasks.planfor',
      id,
      direction,
      total: 2,
      truncated: false,
      nodes: [
        { id, title: 'The task', status: 'open', distance: 0 },
        { id: direction === 'needs' ? 'pub/first' : 'pub/after', title: 'The other', status: 'open', distance: 1 },
      ],
      edges: [{ from: 'pub/first', to: id, kind: 'blocked_by' }],
      cycles: [],
      incomplete: [],
    } as never;
  }
  estimates: { ids?: string[]; assume?: { id: string; effort?: string; value?: number }[] }[] = [];
  /** What the next question of the matrix answers: a refusal to throw, or nothing (the default figures). */
  estimateError: ApiError | null = null;
  /** Questions that wait for these promises, one for each question, in the order asked. */
  estimateHold: Promise<void>[] = [];
  async estimate(request: { ids?: string[]; assume?: { id: string; effort?: string; value?: number }[] }) {
    this.estimates.push(request);
    const held = this.estimateHold.shift();
    if (held) await held;
    if (this.estimateError) throw this.estimateError;
    return {
      kind: 'tasks.estimate',
      tasks: request.ids?.length ?? 0,
      days: 4 + (request.assume?.length ?? 0),
      range: { low: 3, high: 6 },
      value: 7,
      n_with_effort: 1,
      n_with_value: 2,
      n_without_effort: 0,
      n_without_value: 0,
      quick_wins: [],
      unestimated: [],
      assumed: request.assume?.length ?? 0,
      incomplete: [],
    } as never;
  }
  /** While set, a read of the list does not answer (a slow engine, a busy machine). */
  holdSnapshot: Promise<void> | null = null;
  async snapshot(etag: string | null) {
    this.snapshotCalls.push(etag);
    if (this.holdSnapshot) await this.holdSnapshot;
    if (!this.token) throw new ApiError(401, 'unauthorized', 'x');
    if (etag !== null && etag === this.doc.digest) return { kind: 'not_modified' as const };
    return { kind: 'fresh' as const, doc: this.doc, etag: this.doc.digest ?? null };
  }
  /** While set, the links do not answer; `linksFail` makes them refuse (a busy engine). */
  linksHold: Promise<void> | null = null;
  linksFail = false;
  linksCalls = 0;
  async links() {
    this.linksCalls += 1;
    if (this.linksHold) await this.linksHold;
    if (this.linksFail) throw new ApiError(503, 'engine_busy', 'x');
    return {
      kind: 'tasks.links',
      rev: this.doc.rev,
      edge_count: 1,
      truncated: false,
      pairs: [],
      tasks: [{ id: 'pub/a', areas: ['lib', 'pub'] }],
    } as never;
  }
  async areas() {
    this.areasCalls += 1;
    return { areas: this.areaList, unclassified: [], private: [] };
  }
  /** The saved views the hub answers; `viewsHold` holds the answers back, one for each ask, in the order asked. */
  viewList: View[] = [];
  /** The rev the views answer (the `views_rev` of the snapshot, when a test names it). */
  viewsRev: string | null = null;
  viewsCalls = 0;
  viewsHold: Promise<void>[] = [];
  /** How many of the next reads of the views the engine refuses (busy). */
  viewsFail = 0;
  async views(): Promise<Views> {
    this.viewsCalls += 1;
    if (this.viewsFail > 0) {
      this.viewsFail -= 1;
      throw new ApiError(503, 'engine_busy', 'x');
    }
    const list = this.viewList;
    const held = this.viewsHold.shift();
    if (held) await held;
    return { kind: 'tasks.views', rev: this.viewsRev ?? `views:${list.length}`, views: list, problems: [] } as unknown as Views;
  }
  /** The groupings answer the rev of the list unless this names another (an answer of a state gone by). */
  groupingsRev: string | null = null;
  groupingsCalls = 0;
  groupingsHold: Promise<void>[] = [];
  async groupings(): Promise<Groupings> {
    this.groupingsCalls += 1;
    const rev = this.groupingsRev ?? this.doc.rev;
    const held = this.groupingsHold.shift();
    if (held) await held;
    return {
      kind: 'tasks.groupings',
      rev,
      fields: [
        { field: 'status', values: ['doing', 'open'], truncated: false, writable: true, value_type: 'string', mode: 'set' },
        { field: 'tags', values: ['ui'], truncated: false, writable: true, value_type: 'string', mode: 'tags', multi: true },
      ],
    } as unknown as Groupings;
  }
  enumsDoc: unknown = null;
  enumsCalls = 0;
  async enums() {
    this.enumsCalls += 1;
    if (this.enumsDoc === null) throw new ApiError(502, 'engine_failed', 'no ranges');
    return { enums: this.enumsDoc };
  }
  async lists() {
    this.listsCalls += 1;
    if (this.engineListDoc === null) throw new ApiError(404, 'not_found', 'no lists');
    return this.engineListDoc as never;
  }
  async order(sort: string) {
    this.orderCalls.push(sort);
    const ids = this.orders.get(sort);
    if (ids === undefined) throw new ApiError(400, 'invalid_argument', 'no such order');
    return { rev: this.doc.rev, ids };
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
  vaultDoc: VaultList | null = {
    active: 'main',
    vaults: [
      { name: 'main', label: 'tasks-vault', main: true },
      { name: 'native', label: 'wkdbook-native', main: false },
    ],
  };
  vaultCalls: string[] = [];
  vaultError: ApiError | null = null;
  vaultsCalls = 0;
  /** The next asks for the list of vaults fail with this status (an error of the hub, not "there is none"). */
  vaultsFailWith: number | null = null;
  /** While set, the hub does not name its vault yet. */
  holdVaults: Promise<void> | null = null;
  async vaults(): Promise<VaultList> {
    this.vaultsCalls += 1;
    if (this.holdVaults) await this.holdVaults;
    if (this.vaultsFailWith !== null) throw new ApiError(this.vaultsFailWith, 'broken', 'the hub errs');
    if (!this.vaultDoc) throw new ApiError(404, 'vaults_unavailable', 'no list');
    return this.vaultDoc;
  }
  async addVault(name: string, path: string): Promise<void> {
    this.vaultCalls.push(`add ${name} ${path}`);
    if (this.vaultError) throw this.vaultError;
    if (this.vaultDoc) {
      this.vaultDoc = { ...this.vaultDoc, vaults: [...this.vaultDoc.vaults, { name, label: 'x', main: false }] };
    }
  }
  async removeVault(name: string): Promise<void> {
    this.vaultCalls.push(`remove ${name}`);
    if (this.vaultError) throw this.vaultError;
    if (this.vaultDoc) {
      this.vaultDoc = { ...this.vaultDoc, vaults: this.vaultDoc.vaults.filter((v) => v.name !== name) };
    }
  }
  async openInEditor(id: string): Promise<void> {
    this.vaultCalls.push(`open ${id}`);
    if (this.vaultError) throw this.vaultError;
  }
  async selectVault(name: string): Promise<void> {
    this.vaultCalls.push(`select ${name}`);
    if (this.vaultError) throw this.vaultError;
  }
  sent: OpsRequest[] = [];
  /** What the next write answers (an error to throw, or a result). */
  next_ops: Result | ApiError | null = null;
  /** What the writes after `next_ops` answer, one each. */
  ops_queue: (Result | ApiError)[] = [];
  previews = new Map<string, Partial<DonePreview>>();
  async ops(request: OpsRequest): Promise<Result> {
    this.sent.push(request);
    const answer = this.next_ops ?? this.ops_queue.shift() ?? null;
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
        id:
          op.op === 'new'
            ? 'pub/created'
            : op.op === 'plan_new'
              ? `${op.area}/made-plan`
              : op.op === 'view_save'
                ? (op.id ?? `${op.area}/made-view`)
                : op.id,
        ok: true,
        outcome:
          op.op === 'new' || op.op === 'plan_new' || (op.op === 'view_save' && op.id === undefined)
            ? request.dry_run
              ? 'would_create'
              : 'created'
            : op.op === 'view_delete'
              ? 'deleted'
              : 'changed',
        changed_ids: [],
        ...(op.op === 'set'
          ? { inverse: { op: 'set', id: op.id, patch: { status: 'open' }, if_match: 'e2' } }
          : {}),
        // A view made is taken back by deleting it; a view changed or deleted by saving the old one (as the engine does).
        ...(op.op === 'view_save' && op.id === undefined
          ? { inverse: { op: 'view_delete', id: `${op.area}/made-view`, if_match: 'v-made' } }
          : {}),
        ...(op.op === 'view_save' && op.id !== undefined
          ? { inverse: { op: 'view_save', id: op.id, view: { title: 'Before', display: 'list', group_by: 'status' }, if_match: 'v-after' } }
          : {}),
        ...(op.op === 'view_delete'
          ? { inverse: { op: 'view_save', id: op.id, view: { title: 'Gone', display: 'columns', group_by: 'tags' } } }
          : {}),
      })),
    } as unknown as Result;
  }
  async donePreview(id: string): Promise<DonePreview> {
    return { kind: 'tasks.donepreview', id, to: 'DONE/x.md', confirm: 'tok', ...this.previews.get(id) } as DonePreview;
  }
}

function make(
  overrides: { token?: string; cached?: CachedList | null; prefs?: Map<string, string>; now?: number } = {},
) {
  const prefs = overrides.prefs ?? new Map<string, string>();
  const hub = new FakeHub();
  const saved: CachedList[] = [];
  let cleared = 0;
  let reloads = 0;
  const files: { name: string; text: string; type: string }[] = [];
  const copied: string[] = [];
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
    now: () => overrides.now ?? 1000,
    // The stream is not under test here: it is refused, and the loop stops
    // because the test stops the app.
    fetchFn: (async () => new Response('', { status: 503 })) as typeof fetch,
    sleep: async () => {
      await new Promise((r) => setTimeout(r, 1));
    },
    reload: () => void (reloads += 1),
    out: {
      save: (name, text, type) => {
        files.push({ name, text, type });
        return true;
      },
      copy: async (text) => {
        copied.push(text);
        return true;
      },
    },
  };
  return { app: new App(env), hub, saved, session, prefs, files, copied, cleared: () => cleared, reloads: () => reloads };
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

  it('says that a code was refused when there is no session to fall back on', async () => {
    const { app, hub } = make();
    hub.exchangeFails = true;
    await app.start('ab'.repeat(16));
    expect(app.phase).toBe('needs_pairing');
    expect(app.pairRefused).toBe(true);
    app.stop();
  });

  it('does not say it when there never was a code', async () => {
    const { app } = make();
    await app.start(null);
    expect(app.pairRefused).toBe(false);
    app.stop();
  });

  it('trades a code that is pasted into the open tab (only the fragment changed, no reload)', async () => {
    const { app, hub, session } = make();
    await app.start(null);
    expect(app.phase).toBe('needs_pairing');
    app.offerCode('cd'.repeat(16));
    await vi.waitFor(() => expect(app.phase).toBe('ready'));
    expect(hub.exchanged).toEqual(['cd'.repeat(16)]);
    expect(session.get('tasks-desktop.session')).toBe('token-1');
    expect(app.pairRefused).toBe(false);
    app.stop();
  });

  it('keeps the refusal visible when the pasted code is refused too, and clears it when a later one works', async () => {
    const { app, hub } = make();
    await app.start(null);
    hub.exchangeFails = true;
    app.offerCode('cd'.repeat(16));
    await vi.waitFor(() => expect(app.pairRefused).toBe(true));
    expect(app.phase).toBe('needs_pairing');
    hub.exchangeFails = false;
    app.offerCode('ef'.repeat(16));
    await vi.waitFor(() => expect(app.phase).toBe('ready'));
    expect(app.pairRefused).toBe(false);
    app.stop();
  });

  it('does not say a code was refused when the tab kept its session, or when the hub did not answer', async () => {
    const paired = make({ token: 't' });
    paired.hub.exchangeFails = true;
    await paired.app.start('ab'.repeat(16));
    expect(paired.app.phase).toBe('ready');
    expect(paired.app.pairRefused).toBe(false);
    paired.app.stop();

    // Not a refusal of the hub (no answer at all): the page does not claim the code was used up.
    const down = make();
    down.hub.exchangeNetworkFail = true;
    await down.app.start('ab'.repeat(16));
    expect(down.app.phase).toBe('needs_pairing');
    expect(down.app.pairRefused).toBe(false);
    down.app.stop();
  });

  it('drops a session the hub refused while the engine was not there, and goes on to the pairing', async () => {
    const m = make({ token: 't' });
    m.hub.engineReady = false;
    const started = m.app.start(null);
    await vi.waitFor(() => expect(m.app.phase).toBe('unavailable'));
    // The Info dialog is open to the page with a session; the hub refuses the old one.
    expect(m.app.canAbout).toBe(true);
    m.hub.onUnauthorized();
    expect(m.app.canAbout).toBe(false);
    expect(m.hub.token).toBeNull();
    // The engine comes: the refused session is not taken up again from the tab's memory.
    m.hub.engineReady = true;
    await started;
    expect(m.app.phase).toBe('needs_pairing');
    expect(m.hub.token).toBeNull();
    m.app.stop();
  });

  it('forgets a refusal when the session is lost later', async () => {
    const { app, hub } = make({ token: 't' });
    await app.start(null);
    app.pairRefused = true;
    hub.onUnauthorized();
    expect(app.phase).toBe('needs_pairing');
    expect(app.pairRefused).toBe(false);
    app.stop();
  });

  it('trades a code that arrives while the answer to the one before is awaited', async () => {
    const { app, hub } = make();
    let release: () => void = () => {};
    hub.exchangeGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    hub.failNext = 1; // the first code is refused
    const started = app.start('aa'.repeat(16));
    await vi.waitFor(() => expect(hub.exchanged).toEqual(['aa'.repeat(16)]));
    app.offerCode('bb'.repeat(16)); // pasted while the first is still out
    hub.exchangeGate = null;
    release();
    await started;
    expect(hub.exchanged).toEqual(['aa'.repeat(16), 'bb'.repeat(16)]);
    expect(app.phase).toBe('ready');
    expect(app.pairRefused).toBe(false);
    app.stop();
  });

  it('trades a code that is pasted while the page waits for the hub', async () => {
    const { app, hub } = make();
    hub.hubDown = true;
    const started = app.start(null);
    await vi.waitFor(() => expect(app.phase).toBe('offline'));
    app.offerCode('cc'.repeat(16));
    expect(hub.exchanged).toEqual([]); // the page is not paired yet: it keeps the code for when the hub answers
    hub.hubDown = false;
    await started;
    expect(hub.exchanged).toEqual(['cc'.repeat(16)]);
    expect(app.phase).toBe('ready');
    app.stop();
  });

  it('ignores a pasted code while the tab has a session', async () => {
    const { app, hub } = make({ token: 't' });
    await app.start(null);
    app.offerCode('cd'.repeat(16));
    expect(hub.exchanged).toEqual([]);
    expect(app.phase).toBe('ready');
    // nothing was kept back for a later start either: the session is not swapped for a stray code
    await app.start(null);
    expect(hub.exchanged).toEqual([]);
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

  it('looks at a task in a popup without leaving the view; showing it in the list closes the popup', async () => {
    const { app, hub } = make({ token: 't' });
    hub.doc = snapshot([task('pub/a', { etag: 'e1' }), task('pub/b', { etag: 'e2' })], 'rev:1');
    await app.start(null);
    app.setView('plan');
    app.peek('pub/b');
    // The view stays, the task is selected (its detail is read) and the popup is asked for.
    expect(app.view).toBe('plan');
    expect(app.selectedId).toBe('pub/b');
    expect(app.peeking).toBe(true);
    app.closePeek();
    expect(app.peeking).toBe(false);
    expect(app.selectedId).toBe('pub/b');
    // "Show in the list" is the old way: the list is shown, the popup is gone.
    app.peek('pub/a');
    app.reveal('pub/a');
    expect(app.peeking).toBe(false);
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

  it('shows the cached list only when the hub reads the vault it was saved of', async () => {
    const old = (hubVault: string | null | undefined): CachedList => ({
      vault: 'v',
      ...(hubVault === undefined ? {} : { hubVault }),
      rev: null,
      etag: null,
      savedAt: 5,
      tasks: [task('pub/old')],
    });
    // The engine is not there: the list can only come from the cache, nothing replaces it.
    const start = async (cached: CachedList, setup: (hub: FakeHub) => void = () => undefined) => {
      const m = make({ token: 't', cached });
      m.hub.engineReady = false;
      setup(m.hub);
      const started = m.app.start(null);
      // The cached list is drawn at once; the answer of the hub about its vault comes a moment later.
      await vi.waitFor(() => expect(m.hub.vaultsCalls).toBeGreaterThan(0));
      await new Promise((r) => setTimeout(r, 10));
      const shown = m.app.tasks.map((t) => t.id);
      m.app.stop();
      m.hub.engineReady = true;
      await started;
      return { shown, cleared: m.cleared() };
    };
    // The hub reads another vault now (chosen in another tab): the old list stays away and is forgotten.
    expect(await start(old('native'))).toEqual({ shown: [], cleared: 1 });
    // The same vault, a hub with one vault and no list, a list from before this was kept: shown.
    expect((await start(old('main'))).shown).toEqual(['pub/old']);
    expect((await start(old(null), (hub) => (hub.vaultDoc = null))).shown).toEqual(['pub/old']);
    expect((await start(old(undefined))).shown).toEqual(['pub/old']);
  });

  it('keeps the vault the hub reads with the list it saves', async () => {
    const m = make({ token: 't' });
    await m.app.start(null);
    await vi.waitFor(() => expect(m.saved.length).toBeGreaterThan(0));
    expect(m.saved.at(-1)?.hubVault).toBe('main');
    m.app.stop();
  });

  it('holds the session of the tab as soon as the cached list is drawn, before the hub has answered', async () => {
    const cached: CachedList = { vault: 'v', rev: null, etag: null, savedAt: 5, tasks: [task('pub/old')] };
    const { app, hub } = make({ token: 't', cached });
    hub.hubDown = true;
    const started = app.start(null);
    await vi.waitFor(() => expect(app.phase).toBe('ready'));
    // The view that was left open asks now; its question must not go out without the session.
    expect(hub.token).toBe('t');
    app.stop();
    hub.hubDown = false;
    await started;
  });

  it('keeps a pasted code while the session is only the stored one and the hub has not confirmed it', async () => {
    const cached: CachedList = { vault: 'v', rev: null, etag: null, savedAt: 5, tasks: [task('pub/old')] };
    const { app, hub } = make({ token: 't', cached });
    hub.hubDown = true;
    const started = app.start(null);
    await vi.waitFor(() => expect(app.phase).toBe('ready'));
    // The client holds the stored token already, but nothing has confirmed it: the code is not thrown away.
    app.offerCode('ef'.repeat(16));
    hub.hubDown = false;
    await started;
    expect(hub.exchanged).toEqual(['ef'.repeat(16)]);
    app.stop();
  });

  it('does not ask the hub for a scan on the focus before the hub has answered', async () => {
    const cached: CachedList = { vault: 'v', rev: null, etag: null, savedAt: 5, tasks: [task('pub/old')] };
    const { app, hub } = make({ token: 't', cached });
    hub.hubDown = true;
    const started = app.start(null);
    await vi.waitFor(() => expect(app.phase).toBe('ready'));
    await app.focused();
    expect(hub.rescans).toBe(0);
    expect(hub.snapshotCalls).toEqual([]);
    app.stop();
    hub.hubDown = false;
    await started;
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

  it('reads a task asked for again while its read is under way once more when the answer is older, without dropping it', async () => {
    const { app, hub } = make({ token: 't' });
    hub.doc = snapshot([task('pub/a', { etag: 'e1' }), task('pub/b')], 'rev:1');
    await app.start(null);
    const answers: (() => void)[] = [];
    // The hub reads the file when the request comes: the answer has the etag of that moment.
    hub.task = async (id: string, signal?: AbortSignal) => {
      if (signal) hub.taskSignals.push(signal);
      const entry = hub.doc.tasks.find((t) => t.id === id);
      await new Promise<void>((resolve) => answers.push(resolve));
      return { task: entry, body: `read at ${entry?.etag}`, steps: [] } as never;
    };
    const shown = () => (app.detail.state === 'ok' ? app.detail.doc.body : app.detail.state);
    app.select('pub/a');
    // A write changes the file while it is read; it and its event ask for the task twice meanwhile.
    hub.doc = snapshot([task('pub/a', { etag: 'e2' }), task('pub/b')], 'rev:2');
    await app.refresh();
    app.select('pub/a');
    app.select('pub/a');
    expect(answers).toHaveLength(1);
    answers[0]!();
    // The answer is older than the list: one read more (not two), and nothing was dropped.
    await vi.waitFor(() => expect(answers).toHaveLength(2));
    answers[1]!();
    await vi.waitFor(() => expect(shown()).toBe('read at e2'));
    await new Promise((r) => setTimeout(r, 10));
    expect(answers).toHaveLength(2);
    expect(hub.taskSignals.map((signal) => signal.aborted)).toEqual([false, false]);
    // An ask while the read is on its way whose answer is already the state of the list reads nothing more.
    app.select('pub/a');
    app.select('pub/a');
    expect(answers).toHaveLength(3);
    answers[2]!();
    await new Promise((r) => setTimeout(r, 10));
    expect(answers).toHaveLength(3);
    // Another task is still read at once, and the read under way is dropped (j j j).
    app.select('pub/a');
    app.select('pub/b');
    expect(hub.taskSignals.map((signal) => signal.aborted)).toEqual([false, false, false, true, false]);
    // A task chosen again after the selection was cleared is read again, not taken for the dropped read.
    app.select(null);
    app.select('pub/b');
    expect(hub.taskSignals).toHaveLength(6);
    answers.forEach((answer) => answer());
    app.stop();
  });

  it('reads a task once more when the list changed during its first read, and only once', async () => {
    const { app, hub } = make({ token: 't' });
    hub.doc = snapshot([task('pub/a', { etag: 'e1' })], 'rev:1');
    await app.start(null);
    const answers: (() => void)[] = [];
    hub.task = async (id: string, signal?: AbortSignal) => {
      if (signal) hub.taskSignals.push(signal);
      const entry = hub.doc.tasks.find((t) => t.id === id);
      await new Promise<void>((resolve) => answers.push(resolve));
      return { task: entry, body: `read at ${entry?.etag}`, steps: [] } as never;
    };
    app.select('pub/a');
    // The list changes while the detail is still loading: keepSelection asks nothing for a detail that is loading.
    hub.doc = snapshot([task('pub/a', { etag: 'e2' })], 'rev:2');
    await app.refresh();
    answers[0]!();
    await vi.waitFor(() => expect(answers).toHaveLength(2));
    answers[1]!();
    await vi.waitFor(() => expect(app.detail.state === 'ok' && app.detail.doc.body).toBe('read at e2'));
    // A list older than the answer (the read was quicker than the scan) costs one read more at most, never a loop.
    hub.doc = snapshot([task('pub/a', { etag: 'e3' })], 'rev:3');
    app.select(null);
    app.select('pub/a');
    hub.doc = snapshot([task('pub/a', { etag: 'e2' })], 'rev:2');
    answers[2]!();
    await vi.waitFor(() => expect(answers).toHaveLength(4));
    answers[3]!();
    await new Promise((r) => setTimeout(r, 20));
    expect(answers).toHaveLength(4);
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

describe('App, the export', () => {
  it('separates the columns by the locale of the system, not by the language shown', () => {
    const { app } = make(); // the browser prefers German
    app.setLang('en');
    expect(app.exportTasks('csv').text.split('\r\n')[0]).toContain('id;title;');
  });

  /** Noon of 2026-10-24 in UTC: the same day in every time zone from UTC-11 to UTC+11. */
  const NOON = Date.UTC(2026, 9, 24, 12);

  async function started(tasks: TaskEntry[], areas: HubArea[] = [{ name: 'pub', data_class: 'public' }], doc?: Partial<Snapshot>) {
    const made = make({ token: 't', now: NOON });
    made.hub.doc = { ...snapshot(tasks), ...doc };
    made.hub.areaList = areas;
    await made.app.start(null);
    // The classes of the areas come a moment after the list; until then nothing may leave (a test below shows it).
    await new Promise((r) => setTimeout(r, 10));
    return made;
  }

  it('lets nothing leave while the classes of the areas are not known yet, and says that, not that they are private', async () => {
    const { app, hub, copied } = make({ token: 't' });
    hub.doc = snapshot([task('pub/a')]);
    await app.start(null);
    app.setView('list');
    await app.exportView('csv', 'copy');
    expect(copied).toHaveLength(0);
    expect(app.toast).toMatchObject({ kind: 'error', text: translate('de', 'export.classes_unknown') });
    app.stop();
  });

  it('says the same when the hub could not tell the classes', async () => {
    const { app, hub, copied } = make({ token: 't' });
    hub.doc = snapshot([task('pub/a')]);
    hub.areas = async () => {
      throw new ApiError(502, 'engine_failed', 'no classes');
    };
    await app.start(null);
    await new Promise((r) => setTimeout(r, 10));
    app.setView('list');
    await app.exportView('csv', 'copy');
    expect(copied).toHaveLength(0);
    expect(app.toast?.text).toBe(translate('de', 'export.classes_unknown'));
    app.stop();
  });

  it('saves what the list shows as a file named by the view and the day, and says how many', async () => {
    const { app, files } = await started([task('pub/a', { title: 'A', status: 'open' }), task('pub/b', { title: 'B', status: 'doing' })]);
    app.setView('list');
    await app.exportView('json', 'save');
    expect(files).toHaveLength(1);
    expect(files[0]!.name).toBe('tasks-list-2026-10-24.json');
    expect(files[0]!.type).toBe('application/json;charset=utf-8');
    expect(JSON.parse(files[0]!.text).tasks.map((x: { id: string }) => x.id)).toEqual(['pub/a', 'pub/b']);
    expect(app.toast?.text).toBe(translate('de', 'export.saved', { n: 2 }));
    app.stop();
  });

  it('takes the board with its columns; the marks count in the list only, where they are seen', async () => {
    const { app, files, copied } = await started([task('pub/a', { status: 'open' }), task('pub/b', { status: 'doing' }), task('pub/c', { status: 'open' })]);
    app.setView('board');
    await app.exportView('csv', 'save');
    const lines = files[0]!.text.trimEnd().split('\r\n');
    expect(files[0]!.name).toBe('tasks-board-2026-10-24.csv');
    expect(lines[0]!.startsWith('group;id;')).toBe(true);
    // The board's columns in order: doing before open.
    expect(lines.slice(1).map((l) => l.split(';').slice(0, 2).join(' '))).toEqual(['doing pub/b', 'open pub/a', 'open pub/c']);
    app.toggleMark('pub/c');
    await app.exportView('csv', 'copy');
    expect(app.toast?.text).toBe(translate('de', 'export.copied', { n: 3 }));
    app.setView('list');
    await app.exportView('csv', 'copy');
    expect(app.toast?.text).toBe(translate('de', 'export.copied', { n: 1 }));
    expect(copied.at(-1)).toContain('pub/c');
    expect(copied.at(-1)).not.toContain('pub/a');
    app.stop();
  });

  it('takes the plan chosen with its stages in the page language; a plan of a private area is named neither in the file nor in its tasks', async () => {
    const plans = [{ id: 'priv/secret-plan' }, { id: 'pub/open-plan' }] as unknown as Snapshot['plans'];
    const tasks = [
      task('pub/a', { plan: 'priv/secret-plan', readiness: { stage: 0 } as TaskEntry['readiness'] }),
      task('pub/b', { plan: 'pub/open-plan', readiness: { stage: 1 } as TaskEntry['readiness'] }),
      task('pub/c'),
    ];
    const areas: HubArea[] = [
      { name: 'pub', data_class: 'public' },
      { name: 'priv', data_class: 'private' },
    ];
    const { app, files } = await started(tasks, areas, { plans });
    app.setView('plan');
    app.planChoice = 'pub/open-plan';
    await app.exportView('json', 'save');
    expect(files[0]!.name).toBe('tasks-plan-open-plan-2026-10-24.json');
    expect(JSON.parse(files[0]!.text)).toMatchObject({ view: 'plan-open-plan', tasks: [{ id: 'pub/b', group: translate('de', 'plan.stage', { n: 1 }) }] });
    app.planChoice = 'priv/secret-plan';
    await app.exportView('json', 'save');
    expect(files[1]!.name).toBe('tasks-plan-2026-10-24.json');
    expect(files[1]!.text).not.toContain('secret');
    expect(JSON.parse(files[1]!.text).tasks.map((x: { id: string }) => x.id)).toEqual(['pub/a']);
    // The whole vault: the task of the private plan keeps its place, without the id of that plan.
    app.planChoice = '';
    await app.exportView('csv', 'save');
    expect(files[2]!.text).not.toContain('secret');
    expect(files[2]!.text).toContain('pub/open-plan');
    app.stop();
  });

  it('leaves the tasks of a private or unclassified area in the app and says how many', async () => {
    const { app, files, copied } = await started([task('pub/a'), task('priv/b'), task('loose/c')], [
      { name: 'pub', data_class: 'public' },
      { name: 'priv', data_class: 'private' },
    ]);
    app.setView('list');
    await app.exportView('markdown', 'copy');
    expect(copied).toHaveLength(1);
    expect(copied[0]).toContain('`pub/a`');
    expect(copied[0]).not.toContain('priv/b');
    expect(copied[0]).not.toContain('loose/c');
    expect(app.toast?.text).toBe(translate('de', 'export.copied_kept', { n: 1, m: 2 }));
    // Only such tasks shown: nothing leaves, and it is said why.
    app.setQuery('priv/');
    await app.exportView('csv', 'save');
    expect(files).toHaveLength(0);
    expect(app.toast).toMatchObject({ kind: 'error', text: translate('de', 'export.only_kept', { m: 1 }) });
    app.stop();
  });

  it('writes nothing for a view that shows no task, and says so; a failed save is told', async () => {
    const { app, files } = await started([task('pub/a', { title: 'A' })]);
    app.setView('list');
    app.setQuery('nothing matches this');
    await app.exportView('csv', 'save');
    expect(files).toHaveLength(0);
    expect(app.toast).toMatchObject({ kind: 'error', text: translate('de', 'export.empty') });
    app.setQuery('');
    const failing = await started([task('pub/a')]);
    failing.app.setView('list');
    (failing.app as unknown as { env: Env }).env.out.save = () => false;
    await failing.app.exportView('csv', 'save');
    expect(failing.app.toast).toMatchObject({ kind: 'error', text: translate('de', 'export.failed', { n: 1 }) });
    failing.app.stop();
    app.stop();
  });

  it('offers every format and both ways in the palette', () => {
    const { app } = make();
    app.setView('list');
    const keys = paletteActions(app).map((a) => a.key);
    for (const format of ['csv', 'json', 'markdown']) {
      expect(keys).toContain(`export.save.${format}`);
      expect(keys).toContain(`export.copy.${format}`);
    }
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
  async function ready(tasks: ReturnType<typeof task>[] = [], opts: { capabilities?: string[] } = {}) {
    const m = make({ token: 't' });
    if (opts.capabilities) m.hub.capabilities = opts.capabilities;
    if (tasks.length > 0) m.hub.doc = snapshot(tasks);
    await m.app.start(null);
    expect(m.app.phase).toBe('ready');
    m.app.stop();
    return m;
  }

  describe('a task dropped on an area', () => {
    const dry = (conflicts: { message: string }[] = []) =>
      ({
        kind: 'tasks.result',
        ok: true,
        dry_run: true,
        results: [
          {
            n: 1,
            op: 'move_area',
            id: 'pub/a',
            ok: true,
            outcome: 'would_move',
            move: { from: 'pub/a', new_id: 'other/a', references: [{}, {}], conflicts },
          },
        ],
      }) as unknown as Result;
    const withMove = ['move_area', 'ops'];

    it('asks the engine first, writes nothing, and moves only when the person confirms', async () => {
      const { app, hub } = await ready([task('pub/a', { etag: 'e1' })], { capabilities: withMove });
      hub.next_ops = dry();
      await app.askDropMove('pub/a', 'other');
      expect(hub.sent).toHaveLength(1);
      expect(hub.sent[0]?.dry_run).toBe(true);
      expect(app.dropMove?.answer?.kind).toBe('ok');
      await app.confirmDropMove();
      expect(hub.sent).toHaveLength(2);
      expect(hub.sent[1]?.dry_run).not.toBe(true);
      expect(hub.sent[1]?.ops).toEqual([{ op: 'move_area', id: 'pub/a', to_area: 'other', if_match: 'e1' }]);
      expect(app.dropMove).toBeNull();
    });

    it('writes the move under the version that was shown, not under one the list has by now', async () => {
      const { app, hub } = await ready([task('pub/a', { etag: 'e1' })], { capabilities: withMove });
      hub.next_ops = dry();
      await app.askDropMove('pub/a', 'other');
      // The file changes while the dialog is open and the list is read again.
      hub.doc = snapshot([task('pub/a', { etag: 'e2' })], 'rev:2');
      await app.refresh();
      expect(app.tasks[0]?.etag).toBe('e2');
      await app.confirmDropMove();
      expect(hub.sent[1]?.ops).toEqual([{ op: 'move_area', id: 'pub/a', to_area: 'other', if_match: 'e1' }]);
    });

    it('writes nothing when the person gives up, when the area is the one the task is in, or when the engine names a conflict', async () => {
      const { app, hub } = await ready([task('pub/a', { etag: 'e1' })], { capabilities: withMove });
      hub.next_ops = dry();
      await app.askDropMove('pub/a', 'other');
      app.cancelDropMove();
      expect(app.dropMove).toBeNull();
      await app.askDropMove('pub/a', 'pub');
      expect(app.dropMove).toBeNull();
      hub.next_ops = dry([{ message: 'other/a is taken' }]);
      await app.askDropMove('pub/a', 'other');
      await app.confirmDropMove();
      expect(app.dropMove?.answer?.kind).toBe('ok');
      expect(hub.sent.filter((r) => r.dry_run !== true)).toEqual([]);
    });

    it('takes the marked tasks along when one of them is dropped, asks once for all and moves them in one request', async () => {
      const { app, hub } = await ready([task('pub/a', { etag: 'e1' }), task('pub/b', { etag: 'e2' }), task('pub/c', { etag: 'e3' })], {
        capabilities: withMove,
      });
      app.toggleMark('pub/a');
      app.toggleMark('pub/b');
      const would = (n: number, id: string) => ({
        n,
        op: 'move_area',
        id,
        ok: true,
        outcome: 'would_move',
        move: { from: id, new_id: id.replace('pub/', 'other/'), references: [], conflicts: [] },
      });
      hub.next_ops = { kind: 'tasks.result', ok: true, dry_run: true, results: [would(1, 'pub/a'), would(2, 'pub/b')] } as unknown as Result;
      // The third task is not marked, but the one dropped is: the two marked go, the unmarked stays.
      await app.askDropMove('pub/a', 'other');
      expect(app.dropMove?.count).toBe(2);
      expect(hub.sent).toHaveLength(1);
      expect(hub.sent[0]?.dry_run).toBe(true);
      expect(hub.sent[0]?.ops.map((o) => (o.op === 'move_area' ? o.id : ''))).toEqual(['pub/a', 'pub/b']);
      expect(app.dropMove?.checks?.map((c) => c.newId)).toEqual(['other/a', 'other/b']);
      const moved = (n: number, id: string) => ({
        n,
        op: 'move_area',
        id,
        ok: true,
        outcome: 'moved',
        new_id: id.replace('pub/', 'other/'),
        changed_ids: [id],
        inverse: { op: 'move_area', id: id.replace('pub/', 'other/'), to_area: 'pub' },
      });
      hub.next_ops = { kind: 'tasks.result', ok: true, dry_run: false, results: [moved(1, 'pub/a'), moved(2, 'pub/b')] } as unknown as Result;
      await app.confirmDropMove();
      expect(hub.sent).toHaveLength(2);
      expect(hub.sent[1]?.dry_run).not.toBe(true);
      expect(hub.sent[1]?.ops).toHaveLength(2);
      expect(app.dropMove).toBeNull();
    });

    it('moves only the dropped task when it is not one of the marked ones', async () => {
      const { app, hub } = await ready([task('pub/a', { etag: 'e1' }), task('pub/b', { etag: 'e2' }), task('pub/c', { etag: 'e3' })], {
        capabilities: withMove,
      });
      app.toggleMark('pub/a');
      app.toggleMark('pub/b');
      hub.next_ops = dry();
      await app.askDropMove('pub/c', 'other');
      expect(app.dropMove?.count).toBe(1);
      expect(hub.sent[0]?.ops).toHaveLength(1);
    });

    it('lets the person choose the area without a drag, and asks the same question after it', async () => {
      const { app, hub } = await ready([task('pub/a', { etag: 'e1' })], { capabilities: withMove });
      app.chooseDropMove('pub/a');
      expect(app.dropChoose).toBe('pub/a');
      expect(hub.sent).toEqual([]);
      hub.next_ops = dry();
      await app.askDropMove('pub/a', 'other');
      expect(app.dropChoose).toBeNull();
      expect(app.dropMove?.answer?.kind).toBe('ok');
      app.cancelDropMove();
      app.chooseDropMove('pub/a');
      app.cancelDropChoose();
      expect(app.dropChoose).toBeNull();
    });

    it('offers no choice of an area without the move in the engine, nor for a task that is not there', async () => {
      const { app } = await ready([task('pub/a', { etag: 'e1' })], { capabilities: ['ops'] });
      app.chooseDropMove('pub/a');
      expect(app.dropChoose).toBeNull();
      const other = await ready([task('pub/a', { etag: 'e1' })], { capabilities: withMove });
      other.app.chooseDropMove('pub/ghost');
      expect(other.app.dropChoose).toBeNull();
    });

    it('does not ask at all without the move in the engine', async () => {
      const { app, hub } = await ready([task('pub/a', { etag: 'e1' })], { capabilities: ['ops'] });
      await app.askDropMove('pub/a', 'other');
      expect(app.dropMove).toBeNull();
      expect(hub.sent).toEqual([]);
    });
  });

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

  it('changes every marked task in ONE request, each with its own version, and takes the marks away', async () => {
    const { app, hub } = await ready([
      task('pub/a', { etag: 'e1' }),
      task('pub/b', { etag: 'e2' }),
      task('pub/c', { etag: 'e3' }),
    ]);
    const ids = ['pub/c', 'pub/a'];
    for (const id of ids) expect(app.toggleMark(id)).toBe(true);
    expect(app.marks).toEqual(ids);
    await app.bulkSet({ status: 'doing', prio: 1 });
    expect(hub.sent).toHaveLength(1);
    expect(hub.sent[0]?.ops.map((o) => (o.op === 'set' ? o.id : ''))).toEqual(ids);
    expect(
      hub.sent[0]?.ops.every((o) => o.op === 'set' && o.patch.status === 'doing' && o.patch.prio === 1),
    ).toBe(true);
    expect(hub.sent[0]?.ops.map((o) => (o.op === 'set' ? o.if_match : ''))).toEqual(['e3', 'e1']);
    expect(app.marks).toEqual([]);
    expect(app.toast?.kind).toBe('ok');
    // The way back is the inverses in the opposite order, as one batch.
    expect(app.toast?.undo?.map((o) => (o.op === 'set' ? o.id : ''))).toEqual(['pub/a', 'pub/c']);
  });

  it('keeps the marks of moved tasks when a read that began before the move answers with the old list', async () => {
    // Red in CI before the fix: an event of the hub had started a read; it answered after the move with the list of
    // before, and the marks that had followed the new ids were pruned as gone.
    const { app, hub } = await ready([task('pub/a', { etag: 'e1' }), task('pub/b', { etag: 'e2' })]);
    app.markShown();
    const before = hub.doc;
    const after = snapshot([task('other/a', { etag: 'e3' }), task('other/b', { etag: 'e4' })], 'rev:2');
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let reads = 0;
    hub.snapshot = (async () => {
      reads += 1;
      if (reads === 1) {
        await gate;
        return { kind: 'fresh' as const, doc: before, etag: 'old' };
      }
      return { kind: 'fresh' as const, doc: after, etag: 'new' };
    }) as typeof hub.snapshot;
    const reading = app.refresh();
    const moved = (n: number, id: string, to: string) => ({
      n,
      op: 'move_area',
      id,
      ok: true,
      outcome: 'moved',
      new_id: to,
      changed_ids: [id, to],
      inverse: { op: 'move_area', id: to, to_area: 'pub' },
    });
    hub.next_ops = {
      kind: 'tasks.result',
      ok: true,
      dry_run: false,
      results: [moved(1, 'pub/a', 'other/a'), moved(2, 'pub/b', 'other/b')],
    } as unknown as Result;
    const checks = ['a', 'b'].map((s) => ({ id: `pub/${s}`, newId: `other/${s}`, reasons: [], references: 0, namedBy: [] }));
    const moving = app.bulkMove('other', checks);
    await vi.waitFor(() => expect(hub.sent).toHaveLength(1));
    release();
    expect(await moving).toBe(2);
    await reading;
    // The read that began before the answer showed the list of before: the marks are not taken for it.
    expect(app.tasks.map((t) => t.id)).toEqual(['pub/a', 'pub/b']);
    expect(app.marks).toEqual(['other/a', 'other/b']);
    app.keepMarksShown();
    expect(app.marks).toEqual(['other/a', 'other/b']);
    // A read that began after it knows the new ids, and from then on a mark of a task that is gone goes.
    await app.refresh();
    expect(app.tasks.map((t) => t.id)).toEqual(['other/a', 'other/b']);
    expect(app.marks).toEqual(['other/a', 'other/b']);
    hub.snapshot = (async () => ({
      kind: 'fresh' as const,
      doc: snapshot([task('other/a', { etag: 'e3' })], 'rev:3'),
      etag: 'newer',
    })) as typeof hub.snapshot;
    await app.refresh();
    expect(app.marks).toEqual(['other/a']);
  });

  it('tells the text of the engine when a move of the batch fails, also a rollback that is not complete', async () => {
    // Red before the fix: the toast said only "N not (changed meanwhile or refused)"; the paths the engine names in
    // "rollback incomplete" and the reason never reached the person.
    const { app, hub } = await ready([task('pub/a', { etag: 'e1' }), task('pub/b', { etag: 'e2' })]);
    app.markShown();
    const why = 'the move failed (rollback incomplete: other/b.md)';
    hub.next_ops = {
      kind: 'tasks.result',
      ok: false,
      dry_run: false,
      results: [
        {
          n: 1,
          op: 'move_area',
          id: 'pub/a',
          ok: true,
          outcome: 'moved',
          new_id: 'other/a',
          changed_ids: ['pub/a', 'other/a'],
          inverse: { op: 'move_area', id: 'other/a', to_area: 'pub' },
        },
        {
          n: 2,
          op: 'move_area',
          id: 'pub/b',
          ok: false,
          outcome: 'failed',
          changed_ids: [],
          error: { code: 'lock_stuck', message: why, retryable: false },
        },
      ],
    } as unknown as Result;
    const checks = ['a', 'b'].map((s) => ({ id: `pub/${s}`, newId: `other/${s}`, reasons: [], references: 0, namedBy: [] }));
    expect(await app.bulkMove('other', checks)).toBe(1);
    expect(app.toast).toMatchObject({ kind: 'error' });
    expect(app.toast?.text).toContain('rollback incomplete: other/b.md');
    expect(app.toast?.text).toContain(translate(app.lang, 'bulk.move_partial', { done: 1, failed: 1, why }));
  });

  it('takes the mark of a task a write made vanish once the write is over', async () => {
    const { app, hub } = await ready([task('pub/a', { etag: 'e1' }), task('pub/b', { etag: 'e2' })]);
    app.markShown();
    expect(app.marks).toEqual(['pub/a', 'pub/b']);
    // The write finishes pub/a: the list read after it no longer has it.
    hub.snapshot = (async () => ({ kind: 'fresh' as const, doc: snapshot([task('pub/b', { etag: 'e2' })], 'rev:2'), etag: 'n' })) as typeof hub.snapshot;
    await app.setField('pub/a', 'status', 'doing');
    expect(app.tasks.map((t) => t.id)).toEqual(['pub/b']);
    expect(app.marks).toEqual(['pub/b']);
  });

  it('knows the quick wins of the engine from the snapshot', async () => {
    const m = make({ token: 't' });
    const withFigure = snapshot([task('pub/a')]);
    (withFigure as unknown as { estimate: { quick_wins: string[] } }).estimate = { quick_wins: ['pub/a'] };
    m.hub.doc = withFigure;
    await m.app.start(null);
    expect(m.app.quickWinSet?.has('pub/a')).toBe(true);
    m.app.stop();
  });

  it('keeps the marks of tasks a write is moving when a list read in the middle of the write already lacks them', async () => {
    // The bulk move test failed on the Windows runner with one mark left of three: a read that ran while the engine was
    // moving the files returned the list without the old ids, and their marks went before the answer could name the
    // new ones.
    const { app, hub } = await ready([task('pub/a', { etag: 'e1' }), task('pub/b', { etag: 'e2' })]);
    app.markShown();
    const after = snapshot([task('other/a', { etag: 'e3' }), task('other/b', { etag: 'e4' })], 'rev:2');
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let asked = false;
    hub.ops = (async () => {
      asked = true;
      await gate;
      const moved = (n: number, id: string, to: string) => ({
        n,
        op: 'move_area',
        id,
        ok: true,
        outcome: 'moved',
        new_id: to,
        changed_ids: [id, to],
        inverse: { op: 'move_area', id: to, to_area: 'pub' },
      });
      return {
        kind: 'tasks.result',
        ok: true,
        dry_run: false,
        results: [moved(1, 'pub/a', 'other/a'), moved(2, 'pub/b', 'other/b')],
      } as unknown as Result;
    }) as typeof hub.ops;
    const checks = ['a', 'b'].map((x) => ({ id: `pub/${x}`, newId: `other/${x}`, reasons: [], references: 0, namedBy: [] }));
    const moving = app.bulkMove('other', checks);
    await vi.waitFor(() => expect(asked).toBe(true));
    // In the middle of the write a read already sees the files in their new places.
    hub.snapshot = (async () => ({ kind: 'fresh' as const, doc: after, etag: 'mid' })) as typeof hub.snapshot;
    await app.refresh();
    expect(app.tasks.map((t) => t.id)).toEqual(['other/a', 'other/b']);
    expect(app.marks).toEqual(['pub/a', 'pub/b']);
    release();
    expect(await moving).toBe(2);
    await app.refresh();
    expect(app.marks).toEqual(['other/a', 'other/b']);
  });

  it('keeps the marks of moved tasks when a read that began AFTER the move still answers with the list of before', async () => {
    // The hub may answer from the state before the move for a moment (CI, the bulk move test, twice): the marks that
    // followed the new ids must not go because of one stale list.
    const { app, hub } = await ready([task('pub/a', { etag: 'e1' }), task('pub/b', { etag: 'e2' })]);
    app.markShown();
    const before = hub.doc;
    const after = snapshot([task('other/a', { etag: 'e3' }), task('other/b', { etag: 'e4' })], 'rev:2');
    let stale = 0;
    hub.snapshot = (async () => {
      // The first read after the write is stale (the one the write makes itself), the next one knows the move.
      if (hub.sent.length > 0 && stale === 0) {
        stale += 1;
        return { kind: 'fresh' as const, doc: before, etag: 'old' };
      }
      return hub.sent.length > 0
        ? { kind: 'fresh' as const, doc: after, etag: 'new' }
        : { kind: 'fresh' as const, doc: before, etag: 'old' };
    }) as typeof hub.snapshot;
    const moved = (n: number, id: string, to: string) => ({
      n,
      op: 'move_area',
      id,
      ok: true,
      outcome: 'moved',
      new_id: to,
      changed_ids: [id, to],
      inverse: { op: 'move_area', id: to, to_area: 'pub' },
    });
    hub.next_ops = {
      kind: 'tasks.result',
      ok: true,
      dry_run: false,
      results: [moved(1, 'pub/a', 'other/a'), moved(2, 'pub/b', 'other/b')],
    } as unknown as Result;
    const checks = ['a', 'b'].map((s) => ({ id: `pub/${s}`, newId: `other/${s}`, reasons: [], references: 0, namedBy: [] }));
    expect(await app.bulkMove('other', checks)).toBe(2);
    // The read that began after the answer brought the list of before: the marks stay on the new ids.
    await vi.waitFor(() => expect(stale).toBe(1));
    expect(app.tasks.map((t) => t.id)).toEqual(['pub/a', 'pub/b']);
    expect(app.marks).toEqual(['other/a', 'other/b']);
    // The next one knows the new ids: the marks stand, and a mark of a task that is gone goes from now on.
    await app.refresh();
    expect(app.tasks.map((t) => t.id)).toEqual(['other/a', 'other/b']);
    expect(app.marks).toEqual(['other/a', 'other/b']);
  });

  it('does not keep the marks of moved tasks for ever when the list never knows them', async () => {
    const { app, hub } = await ready([task('pub/a', { etag: 'e1' })]);
    app.markShown();
    hub.snapshot = (async () => ({ kind: 'fresh' as const, doc: snapshot([task('pub/a', { etag: 'e1' })]), etag: 'same' })) as typeof hub.snapshot;
    hub.next_ops = {
      kind: 'tasks.result',
      ok: true,
      dry_run: false,
      results: [
        { n: 1, op: 'move_area', id: 'pub/a', ok: true, outcome: 'moved', new_id: 'other/a', changed_ids: ['pub/a'], inverse: { op: 'move_area', id: 'other/a', to_area: 'pub' } },
      ],
    } as unknown as Result;
    await app.bulkMove('other', [{ id: 'pub/a', newId: 'other/a', reasons: [], references: 0, namedBy: [] }]);
    for (let i = 0; i < 4; i++) await app.refresh();
    expect(app.marks).toEqual([]);
  });

  it('takes a batch of moves back and the selection returns to the id of ITS task, not to the first one moved back', async () => {
    // The undo of a batch is the inverses of its moves, in an order they can all be made in; the answer names them by
    // place. The task that was selected is the middle one: looking for "the first move that came back" selects the
    // wrong task.
    const { app, hub } = await ready([task('pub/a', { etag: 'e1' }), task('pub/b', { etag: 'e2' }), task('pub/c', { etag: 'e3' })]);
    app.markShown();
    app.select('pub/b');
    const moved = (n: number, id: string, to: string, back: string) => ({
      n,
      op: 'move_area',
      id,
      ok: true,
      outcome: 'moved',
      new_id: to,
      changed_ids: [id, to],
      inverse: { op: 'move_area', id: to, to_area: back, if_match: `m${n}` },
    });
    const answer = (...results: unknown[]) => ({ kind: 'tasks.result', ok: true, dry_run: false, results }) as unknown as Result;
    const where = { current: ['pub/a', 'pub/b', 'pub/c'] };
    hub.snapshot = (async () => ({
      kind: 'fresh' as const,
      doc: snapshot(where.current.map((id) => task(id, { etag: `${id}-v` })), `rev:${where.current.join()}`),
      etag: where.current.join(),
    })) as typeof hub.snapshot;

    hub.next_ops = answer(moved(1, 'pub/a', 'other/a', 'pub'), moved(2, 'pub/b', 'other/b', 'pub'), moved(3, 'pub/c', 'other/c', 'pub'));
    where.current = ['other/a', 'other/b', 'other/c'];
    const checks = ['a', 'b', 'c'].map((s) => ({ id: `pub/${s}`, newId: `other/${s}`, reasons: [], references: 0, namedBy: [] }));
    expect(await app.bulkMove('other', checks)).toBe(3);
    await vi.waitFor(() => expect(app.selectedId).toBe('other/b'));
    expect(app.toast?.undo?.map((o) => (o.op === 'move_area' ? o.id : ''))).toEqual(['other/a', 'other/b', 'other/c']);

    // The answers come in the order of the inverses: the selected task is the second of them.
    hub.next_ops = answer(moved(1, 'other/a', 'pub/a', 'other'), moved(2, 'other/b', 'pub/b', 'other'), moved(3, 'other/c', 'pub/c', 'other'));
    where.current = ['pub/a', 'pub/b', 'pub/c'];
    await app.undo();
    expect(app.selectedId).toBe('pub/b');
  });

  it('moves at most MOVE_MAX marked tasks in one batch: past it nothing is sent and the limit is told', async () => {
    const many = Array.from({ length: MOVE_MAX + 1 }, (_, i) => task(`pub/m${String(i).padStart(3, '0')}`, { etag: `e${i}` }));
    const { app, hub } = await ready(many);
    app.markShown();
    expect(app.marks).toHaveLength(MOVE_MAX + 1);
    const told = translate(app.lang, 'bulk.move_limit', { n: MOVE_MAX });
    expect(await app.previewBulkMove('other')).toBeNull();
    expect(app.toast).toMatchObject({ kind: 'error', text: told });
    app.toast = null;
    // The move itself keeps the limit too, even with a dry run that let every task through.
    const checks = many.map((t) => ({ id: t.id, newId: `other/${t.id}`, reasons: [], references: 0, namedBy: [] }));
    expect(await app.bulkMove('other', checks)).toBe(0);
    expect(app.toast).toMatchObject({ kind: 'error', text: told });
    expect(hub.sent).toHaveLength(0);
    // One fewer is asked, in ONE dry run.
    app.toggleMark(app.marks[0] as string);
    await app.previewBulkMove('other');
    expect(hub.sent).toHaveLength(1);
    expect(hub.sent[0]?.dry_run).toBe(true);
    expect(hub.sent[0]?.ops).toHaveLength(MOVE_MAX);
  });

  // The engine names a failed entry by its position `n` and, for a conflict, in `error.details.id` - not by `id`.
  const engineFailure = (n: number, id?: string) => ({
    n,
    op: 'set',
    ok: false,
    outcome: 'failed',
    changed_ids: [],
    error: { code: 'conflict', message: 'x', retryable: false, ...(id ? { details: { id } } : {}) },
  });
  const okEntry = (n: number, id: string) => ({
    n,
    op: 'set',
    id,
    ok: true,
    outcome: 'changed',
    changed_ids: [],
    inverse: { op: 'set', id, patch: { prio: null }, if_match: 'new' },
  });

  it('keeps the marks of the tasks that failed - found by position - and offers the way back for the rest', async () => {
    const { app, hub } = await ready([
      task('pub/a', { etag: 'e1' }),
      task('pub/b', { etag: 'e2' }),
      task('pub/c', { etag: 'e3' }),
    ]);
    for (const id of ['pub/a', 'pub/b', 'pub/c']) app.toggleMark(id);
    hub.next_ops = {
      kind: 'tasks.result',
      ok: false,
      dry_run: false,
      results: [okEntry(1, 'pub/a'), engineFailure(2), okEntry(3, 'pub/c')],
    } as unknown as Result;
    await app.bulkSet({ prio: 1 });
    expect(app.marks).toEqual(['pub/b']);
    expect(app.toast?.kind).toBe('error');
    expect(app.toast?.text).toMatch(/2\D+1/);
    expect(app.toast?.undo?.map((o) => (o.op === 'set' ? o.id : ''))).toEqual(['pub/c', 'pub/a']);
  });

  it('says what came of a batch at once, without waiting for the list to be read again', async () => {
    const { app, hub } = await ready([task('pub/a', { etag: 'e1' }), task('pub/b', { etag: 'e2' }), task('pub/c', { etag: 'e3' })]);
    for (const id of ['pub/a', 'pub/b', 'pub/c']) app.toggleMark(id);
    hub.next_ops = {
      kind: 'tasks.result',
      ok: false,
      dry_run: false,
      results: [okEntry(1, 'pub/a'), engineFailure(2), okEntry(3, 'pub/c')],
    } as unknown as Result;
    let release!: () => void;
    hub.holdSnapshot = new Promise<void>((resolve) => (release = resolve));
    const done = app.bulkSet({ prio: 1 });
    // The answer is known; the re-read is held. The toast and the marks must not depend on it.
    await vi.waitFor(() => expect(app.toast?.text).toMatch(/2\D+1/));
    expect(app.marks).toEqual(['pub/b']);
    expect(app.toast?.undo?.length).toBe(2);
    release();
    await done;
    expect(app.toast?.text).toMatch(/2\D+1/);
  });

  it('says "undone" at once, without waiting for the list to be read again', async () => {
    const { app, hub } = await ready([task('pub/a', { etag: 'e1' })]);
    await app.setField('pub/a', 'status', 'doing');
    expect(app.toast?.undo).toBeDefined();
    let release!: () => void;
    hub.holdSnapshot = new Promise<void>((resolve) => (release = resolve));
    const done = app.undo();
    await vi.waitFor(() => expect(app.toast?.text).toBe('Rückgängig gemacht.'));
    release();
    await done;
    expect(app.toast?.text).toBe('Rückgängig gemacht.');
  });

  it('finds a failed task by error.details.id when the position does not say', async () => {
    const { app, hub } = await ready([task('pub/a', { etag: 'e1' }), task('pub/b', { etag: 'e2' })]);
    for (const id of ['pub/a', 'pub/b']) app.toggleMark(id);
    hub.next_ops = {
      kind: 'tasks.result',
      ok: false,
      dry_run: false,
      results: [okEntry(1, 'pub/a'), engineFailure(9, 'pub/b')],
    } as unknown as Result;
    await app.bulkSet({ prio: 1 });
    expect(app.marks).toEqual(['pub/b']);
  });

  it('takes no mark away when it cannot tell which task failed', async () => {
    const { app, hub } = await ready([task('pub/a', { etag: 'e1' }), task('pub/b', { etag: 'e2' })]);
    for (const id of ['pub/a', 'pub/b']) app.toggleMark(id);
    hub.next_ops = {
      kind: 'tasks.result',
      ok: false,
      dry_run: false,
      results: [okEntry(1, 'pub/a'), engineFailure(9)],
    } as unknown as Result;
    await app.bulkSet({ prio: 1 });
    expect(app.marks).toEqual(['pub/a', 'pub/b']);
    expect(app.toast?.kind).toBe('error');
  });

  it('keeps every mark when the hub fails, and a mark made while it saved', async () => {
    const { app, hub } = await ready([task('pub/a', { etag: 'e1' }), task('pub/b', { etag: 'e2' }), task('pub/c')]);
    app.toggleMark('pub/a');
    app.toggleMark('pub/b');
    hub.next_ops = new ApiError(409, 'conflict', 'x');
    await app.bulkSet({ prio: 1 });
    expect(app.marks).toEqual(['pub/a', 'pub/b']);
    expect(app.toast?.kind).toBe('error');

    // A mark made while the request is under way survives its success.
    const done = app.bulkSet({ prio: 2 });
    app.toggleMark('pub/c');
    await done;
    expect(app.marks).toEqual(['pub/c']);
  });

  it('forgets the marks of a task that is gone, and of one the list does not show', async () => {
    const { app, hub } = await ready([task('pub/a'), task('pub/b')]);
    app.toggleMark('pub/a');
    app.toggleMark('pub/b');
    hub.doc = snapshot([task('pub/a')], 'rev:2');
    await app.refresh();
    expect(app.marks).toEqual(['pub/a']);

    app.filter = { ...app.filter, query: 'no such title anywhere' };
    app.keepMarksShown();
    expect(app.marks).toEqual([]);
  });

  it('refuses a mark past one batch and says so, also for "mark all"', async () => {
    const many = Array.from({ length: 101 }, (_, i) => task(`pub/t${i}`));
    const { app } = await ready(many);
    app.marks = many.slice(0, 100).map((t) => t.id);
    expect(app.toggleMark('pub/t100')).toBe(false);
    expect(app.marks).toHaveLength(100);
    expect(app.toast?.kind).toBe('error');

    app.clearMarks();
    app.dismissToast();
    app.markShown();
    expect(app.marks).toHaveLength(100);
    expect(app.toast?.kind).toBe('error');
  });

  describe('what the engine can do', () => {
    it('does not open the board or the plan wizard on an engine without reorder and plan_new', async () => {
      const m = make({ token: 't' });
      m.hub.capabilities = ['hello'];
      await m.app.start(null);
      m.app.stop();
      m.app.setView('board');
      expect(m.app.view).not.toBe('board');
      m.app.openPlanWizard();
      expect(m.app.planning).toBe(false);
    });

    it('leaves a board that was left open when the engine cannot reorder', async () => {
      const prefs = new Map([['tasks-desktop.view', 'board']]);
      const m = make({ token: 't', prefs });
      m.hub.capabilities = ['hello'];
      expect(m.app.view).toBe('board');
      await m.app.start(null);
      m.app.stop();
      expect(m.app.view).toBe('today');
    });

    it('holds nothing back from an engine that is not there or does not say', async () => {
      const prefs = new Map([['tasks-desktop.view', 'board']]);
      const m = make({ token: 't', prefs });
      m.hub.engineReady = false;
      m.hub.capabilities = [];
      const started = m.app.start(null);
      await vi.waitFor(() => expect(m.app.phase).toBe('unavailable'));
      // No engine tells nothing about what it can do.
      expect(m.app.capabilities).toBeNull();
      expect(m.app.view).toBe('board');
      m.hub.engineReady = true;
      m.hub.capabilities = null;
      await started;
      m.app.stop();
      expect(m.app.can('reorder')).toBe(true);
      expect(m.app.view).toBe('board');
    });

    describe('the links between areas', () => {
      it('shows nothing from the list while the answer of the engine is on its way', async () => {
        const m = make({ token: 't' });
        m.hub.capabilities = ['links'];
        let release: () => void = () => {};
        m.hub.linksHold = new Promise<void>((r) => (release = r));
        await m.app.start(null);
        m.app.stop();
        expect(m.app.linksPending).toBe(true);
        expect(m.app.crossIndex.size).toBe(0);
        release();
        await vi.waitFor(() => expect(m.app.linksNow).not.toBeNull());
        expect(m.app.linksPending).toBe(false);
        expect(m.app.crossAreas('pub/a')).toEqual(['lib', 'pub']);
      });

      it('asks once for a state while the answer is on its way', async () => {
        const m = make({ token: 't' });
        m.hub.capabilities = ['links'];
        let release: () => void = () => {};
        m.hub.linksHold = new Promise<void>((r) => (release = r));
        await m.app.start(null);
        m.app.stop();
        await m.app.refresh();
        await m.app.refresh();
        expect(m.hub.linksCalls).toBe(1);
        release();
        await vi.waitFor(() => expect(m.app.linksNow).not.toBeNull());
        expect(m.hub.linksCalls).toBe(1);
      });

      it('does not keep the links of an older state when the engine cannot answer for the new one', async () => {
        const m = make({ token: 't' });
        m.hub.capabilities = ['links'];
        await m.app.start(null);
        m.app.stop();
        await vi.waitFor(() => expect(m.app.linksNow).not.toBeNull());
        expect(m.app.crossAreas('pub/a')).toEqual(['lib', 'pub']);
        m.hub.linksFail = true;
        m.hub.doc = snapshot([task('pub/a', { etag: 'e2' })], 'rev:2');
        await m.app.refresh();
        await vi.waitFor(() => expect(m.app.linksFailed).toBe(true));
        expect(m.app.linksNow).toBeNull();
        expect(m.app.linksPending).toBe(false);
        // Read from the list now: the old answer would still say that the task touches `lib`.
        expect(m.app.crossAreas('pub/a')).toEqual([]);
      });
    });

    it('offers both where the engine names them', async () => {
      const { app } = await ready();
      app.setView('board');
      expect(app.view).toBe('board');
      app.openPlanWizard();
      expect(app.planning).toBe(true);
    });
  });

  describe('board', () => {
    const open = (id: string, group: string, etag: string) =>
      task(id, { etag, status: 'open', group } as Partial<TaskEntry>);

    it('moves a card inside its group with one reorder that carries the version shown', async () => {
      const { app, hub } = await ready([
        open('pub/a', 'open|1', 'e1'),
        open('pub/b', 'open|1', 'e2'),
        open('pub/c', 'open|2', 'e3'),
      ]);
      await app.stepCard('pub/a', 1);
      expect(hub.sent).toHaveLength(1);
      expect(hub.sent[0]?.ops).toEqual([
        { op: 'reorder', id: 'pub/a', after: 'pub/b', group: 'open|1', if_match: 'e1' },
      ]);
      await app.dropNear('pub/b', { id: 'pub/a', place: 'before' });
      expect(hub.sent[1]?.ops[0]).toMatchObject({ op: 'reorder', id: 'pub/b', before: 'pub/a' });
    });

    it('does not send a move across a priority border, and says why', async () => {
      const { app, hub } = await ready([open('pub/a', 'open|1', 'e1'), open('pub/c', 'open|2', 'e3')]);
      await app.dropNear('pub/a', { id: 'pub/c', place: 'after' });
      expect(hub.sent).toHaveLength(0);
      expect(app.toast?.kind).toBe('error');
      // The edge of a group is told, too.
      app.dismissToast();
      await app.stepCard('pub/a', -1);
      expect(hub.sent).toHaveLength(0);
      expect(app.toast?.kind).toBe('error');
    });

    it('takes a move that numbered its neighbours back with every file, not only the place', async () => {
      const { app, hub } = await ready([open('pub/a', 'open|1', 'e1'), open('pub/b', 'open|1', 'e2')]);
      hub.next_ops = {
        kind: 'tasks.result',
        ok: true,
        dry_run: false,
        results: [
          {
            n: 1,
            op: 'reorder',
            id: 'pub/a',
            ok: true,
            outcome: 'changed',
            changed_ids: ['pub/b', 'pub/a'],
            writes: 2,
            inverse: { op: 'reorder', id: 'pub/a', before: 'pub/b', if_match: 'n1' },
            restore: [
              { op: 'set', id: 'pub/b', patch: { order: null }, if_match: 'n2' },
              { op: 'set', id: 'pub/a', patch: { order: '5' }, if_match: 'n1' },
            ],
          },
        ],
      } as unknown as Result;
      await app.stepCard('pub/a', 1);
      await app.undo();
      expect(hub.sent[1]?.ops).toEqual([
        { op: 'set', id: 'pub/a', patch: { order: '5' }, if_match: 'n1' },
        { op: 'set', id: 'pub/b', patch: { order: null }, if_match: 'n2' },
      ]);
    });

    it('asks before it sets the priority of a card dropped among cards of another one', async () => {
      const staged = (id: string, group: string, etag: string) =>
        task(id, { etag, status: 'open', group, readiness: { state: 'ready', stage: 0, eff_prio: Number(group.split('|')[1]) } } as Partial<TaskEntry>);
      const { app, hub } = await ready([staged('pub/a', 'open|1', 'e1'), staged('pub/c', 'open|2', 'e3')]);
      await app.dropNear('pub/a', { id: 'pub/c', place: 'after' });
      // Nothing is sent before the answer.
      expect(hub.sent).toHaveLength(0);
      expect(app.repriority).toMatchObject({ id: 'pub/a', from: '1', prio: 2 });
      app.cancelRepriority();
      expect(app.repriority).toBeNull();
      expect(hub.sent).toHaveLength(0);
      await app.dropNear('pub/a', { id: 'pub/c', place: 'after' });
      await app.confirmRepriority();
      // One batch: the priority, then the place, and the way back covers both.
      expect(hub.sent).toHaveLength(1);
      expect(hub.sent[0]?.ops).toEqual([
        { op: 'set', id: 'pub/a', patch: { prio: 2 }, if_match: 'e1' },
        { op: 'reorder', id: 'pub/a', after: 'pub/c', group: 'open|2' },
      ]);
      expect(app.repriority).toBeNull();
    });

    it('carries no priority along when the engine does not promise the number (capability eff_prio)', async () => {
      const staged = (id: string, group: string, etag: string) =>
        task(id, { etag, status: 'open', group, readiness: { state: 'ready', stage: 0, eff_prio: Number(group.split('|')[1]) } } as Partial<TaskEntry>);
      const { app, hub } = await ready([staged('pub/a', 'open|1', 'e1'), staged('pub/c', 'open|2', 'e3')], {
        capabilities: ['reorder', 'plan_new'],
      });
      await app.dropNear('pub/a', { id: 'pub/c', place: 'after' });
      expect(app.repriority).toBeNull();
      expect(hub.sent).toHaveLength(0);
    });

    it('asks for the blocker when a card goes to the blocked column, and sends the status with it', async () => {
      const { app, hub } = await ready([open('pub/a', 'open|1', 'e1'), open('pub/b', 'open|1', 'e2')]);
      await app.dropOnColumn('pub/a', 'blocked');
      expect(hub.sent).toHaveLength(0);
      expect(app.blocking).toEqual({ id: 'pub/a' });
      app.cancelBlock();
      expect(app.blocking).toBeNull();
      expect(hub.sent).toHaveLength(0);
      // A name that is no task, and the card itself, are told before anything is sent.
      await app.dropOnColumn('pub/a', 'blocked');
      expect(app.unknownBlockers(['pub/b', 'pub/zzz', 'pub/a'])).toEqual(['pub/zzz', 'pub/a']);
      await app.confirmBlock(['pub/b', 'pub/b']);
      expect(hub.sent).toHaveLength(1);
      expect(hub.sent[0]?.ops).toEqual([
        { op: 'set', id: 'pub/a', patch: { status: 'blocked', blocked_by: ['pub/b'] }, if_match: 'e1' },
      ]);
      // Without a blocker the status alone goes.
      await app.dropOnColumn('pub/b', 'blocked');
      await app.confirmBlock([]);
      expect(hub.sent[1]?.ops[0]).toMatchObject({ patch: { status: 'blocked' } });
      expect(hub.sent[1]?.ops[0]).not.toHaveProperty('patch.blocked_by');
    });

    it('does not ask again for a card that has a blocker already', async () => {
      const { app, hub } = await ready([
        task('pub/a', { etag: 'e1', status: 'open', group: 'open|1', blocked_by: ['pub/b'] } as Partial<TaskEntry>),
        open('pub/b', 'open|1', 'e2'),
      ]);
      await app.dropOnColumn('pub/a', 'blocked');
      expect(app.blocking).toBeNull();
      expect(hub.sent[0]?.ops[0]).toMatchObject({ patch: { status: 'blocked' } });
    });

    it('opens the preview of finishing when a card is dropped on the done zone', async () => {
      const { app, hub } = await ready([open('pub/a', 'open|1', 'e1')]);
      await app.dropOnDone('pub/a');
      expect(app.finishing?.id).toBe('pub/a');
      expect(hub.sent).toHaveLength(0);
    });

    it('sets the status when a card goes to another column, and nothing when it stays', async () => {
      const { app, hub } = await ready([open('pub/a', 'open|1', 'e1')]);
      await app.dropOnColumn('pub/a', 'open');
      expect(hub.sent).toHaveLength(0);
      await app.dropOnColumn('pub/a', 'doing');
      expect(hub.sent[0]?.ops).toEqual([
        { op: 'set', id: 'pub/a', patch: { status: 'doing' }, if_match: 'e1' },
      ]);
      await app.shiftColumn('pub/a', 1);
      expect(hub.sent[1]?.ops[0]).toMatchObject({ patch: { status: 'parked' } });
      expect(hub.sent).toHaveLength(2);
    });

    it('past the last column, the shift opens the preview of finishing (what the strip does for the mouse)', async () => {
      const parked = task('pub/a', { etag: 'e1', status: 'parked', group: 'parked|1' } as Partial<TaskEntry>);
      const { app, hub } = await ready([parked]);
      await app.shiftColumn('pub/a', 1);
      expect(hub.sent).toHaveLength(0);
      expect(app.finishing?.id).toBe('pub/a');
      // The other way is the neighbouring column, as before.
      app.cancelFinish();
      await app.shiftColumn('pub/a', -1);
      expect(hub.sent[0]?.ops[0]).toMatchObject({ patch: { status: 'open' } });
    });

    it('tells a move that numbered the neighbours: more than one file was written', async () => {
      const { app, hub } = await ready([open('pub/a', 'open|1', 'e1'), open('pub/b', 'open|1', 'e2')]);
      hub.next_ops = {
        kind: 'tasks.result',
        ok: true,
        dry_run: false,
        results: [{ n: 1, op: 'reorder', id: 'pub/a', ok: true, outcome: 'changed', writes: 11, changed_ids: ['pub/a'] }],
      } as unknown as Result;
      await app.stepCard('pub/a', 1);
      expect(app.toast?.text).toContain('11');
      hub.next_ops = {
        kind: 'tasks.result',
        ok: true,
        dry_run: false,
        results: [{ n: 1, op: 'reorder', id: 'pub/a', ok: true, outcome: 'changed', writes: 1, changed_ids: ['pub/a'] }],
      } as unknown as Result;
      await app.stepCard('pub/a', 1);
      expect(app.toast?.text).not.toContain('11');
    });

    it('does not move a card the filter hides', async () => {
      const { app, hub } = await ready([open('pub/a', 'open|1', 'e1'), open('pub/b', 'open|1', 'e2')]);
      app.filter = { ...app.filter, query: 'no such title anywhere' };
      await app.stepCard('pub/a', 1);
      await app.shiftColumn('pub/a', 1);
      expect(hub.sent).toHaveLength(0);
    });

    it('refuses a move while a write is under way, aloud, and does not keep it for later', async () => {
      const { app, hub } = await ready([open('pub/a', 'open|1', 'e1'), open('pub/b', 'open|1', 'e2')]);
      // The answer of the first write hangs until it is released.
      let release!: () => void;
      const gate = new Promise<void>((resolve) => (release = resolve));
      const answer = hub.ops.bind(hub);
      hub.ops = async (request: OpsRequest) => {
        await gate;
        return answer(request);
      };
      const first = app.shiftColumn('pub/a', 1);
      expect(app.saving).toBe(true);
      const moves: [string, () => Promise<void>][] = [
        ['shift', () => app.shiftColumn('pub/b', 1)],
        ['step', () => app.stepCard('pub/b', 1)],
        ['column', () => app.dropOnColumn('pub/b', 'doing')],
        ['near', () => app.dropNear('pub/b', { id: 'pub/a', place: 'before' })],
        ['done', () => app.dropOnDone('pub/b')],
      ];
      for (const [name, move] of moves) {
        app.dismissToast();
        await move();
        expect(app.toast, name).toEqual({ kind: 'error', text: translate(app.lang, 'write.busy') });
      }
      release();
      await first;
      // Only the first write was sent, and no refused move comes after it.
      expect(hub.sent).toHaveLength(1);
      expect(hub.sent[0]?.ops[0]).toMatchObject({ id: 'pub/a', patch: { status: 'parked' } });
      expect(app.finishing).toBeNull();
      expect(app.toast?.kind).toBe('ok');
      await Promise.resolve();
      expect(hub.sent).toHaveLength(1);
    });

    it('takes a reorder back with the reorder the engine named', async () => {
      const { app, hub } = await ready([open('pub/a', 'open|1', 'e1'), open('pub/b', 'open|1', 'e2')]);
      hub.next_ops = {
        kind: 'tasks.result',
        ok: true,
        dry_run: false,
        results: [
          {
            n: 1,
            op: 'reorder',
            id: 'pub/a',
            ok: true,
            outcome: 'changed',
            changed_ids: ['pub/a'],
            inverse: { op: 'reorder', id: 'pub/a', before: 'pub/b', if_match: 'e1b' },
          },
        ],
      } as unknown as Result;
      await app.stepCard('pub/a', 1);
      expect(app.toast?.undo).toEqual([{ op: 'reorder', id: 'pub/a', before: 'pub/b', if_match: 'e1b' }]);
      await app.undo();
      expect(hub.sent[1]?.ops).toEqual([{ op: 'reorder', id: 'pub/a', before: 'pub/b', if_match: 'e1b' }]);
    });

    it('moves the selection inside a column and across to the next one that has cards', async () => {
      const { app } = await ready([
        task('pub/a', { status: 'doing' } as Partial<TaskEntry>),
        task('pub/b', { status: 'open' } as Partial<TaskEntry>),
        task('pub/c', { status: 'open' } as Partial<TaskEntry>),
        task('pub/d', { status: 'parked' } as Partial<TaskEntry>),
      ]);
      app.select('pub/b');
      app.moveSelectionInColumn(1);
      expect(app.selectedId).toBe('pub/c');
      app.moveSelectionInColumn(1);
      expect(app.selectedId).toBe('pub/c');
      app.moveSelectionAcross(1);
      expect(app.selectedId).toBe('pub/d');
      // the same height in the column on the left: the parked column has one card, d is on its first row
      app.moveSelectionAcross(-1);
      expect(app.selectedId).toBe('pub/b');
      app.select('pub/b');
      // decision and blocked are empty: left of open is doing
      app.moveSelectionAcross(-1);
      expect(app.selectedId).toBe('pub/a');
    });
  });

  describe('plan wizard', () => {
    const form = { ...emptyForm('pub'), title: 'A plan', phases: 'design, build' };

    it('asks the engine for a dry run and shows its name; an empty form asks nothing', async () => {
      const { app, hub } = await ready();
      expect(await app.previewPlan({ ...form, title: '  ' })).toEqual({ kind: 'unknown' });
      expect(hub.sent).toHaveLength(0);
      const answer = await app.previewPlan(form);
      expect(answer).toEqual({ kind: 'ok', id: 'pub/made-plan', renamed: false });
      expect(hub.sent).toHaveLength(1);
      expect(hub.sent[0]?.dry_run).toBe(true);
      expect(hub.sent[0]?.ops).toEqual([
        { op: 'plan_new', area: 'pub', title: 'A plan', areas: ['pub'], phases: ['design', 'build'] },
      ]);
      // A dry run is neither a write nor a scan: no toast, no busy state.
      expect(app.toast).toBeNull();
      expect(app.saving).toBe(false);
    });

    it('says what the engine refused, and tells a name that was taken', async () => {
      const { app, hub } = await ready();
      hub.next_ops = {
        kind: 'tasks.result',
        ok: false,
        dry_run: true,
        results: [
          {
            n: 1,
            op: 'plan_new',
            ok: false,
            outcome: 'failed',
            changed_ids: [],
            error: { code: 'invalid_argument', message: 'phases: x is no kebab-case word', retryable: false },
          },
        ],
      } as unknown as Result;
      expect(await app.previewPlan(form)).toEqual({
        kind: 'refused',
        message: 'phases: x is no kebab-case word',
      });
      hub.next_ops = new ApiError(400, 'bad_request', 'the request is not valid');
      expect(await app.previewPlan(form)).toEqual({ kind: 'refused', message: 'the request is not valid' });
      hub.next_ops = new ApiError(502, 'engine_unavailable', 'x');
      expect(await app.previewPlan(form)).toEqual({ kind: 'unknown' });
      hub.next_ops = {
        kind: 'tasks.result',
        ok: true,
        dry_run: true,
        results: [
          { n: 1, op: 'plan_new', id: 'pub/a-plan-2', ok: true, outcome: 'would_create', renamed: true, changed_ids: [] },
        ],
      } as unknown as Result;
      expect(await app.previewPlan(form)).toEqual({ kind: 'ok', id: 'pub/a-plan-2', renamed: true });
    });

    it('makes the plan, chooses it in the plan view and closes the wizard', async () => {
      const { app, hub } = await ready();
      app.setView('list');
      app.openPlanWizard();
      expect(app.planning).toBe(true);
      await app.createPlan(form);
      expect(hub.sent).toHaveLength(1);
      expect(hub.sent[0]?.dry_run).toBeUndefined();
      expect(hub.sent[0]?.ops[0]).toMatchObject({ op: 'plan_new', title: 'A plan' });
      expect(app.planning).toBe(false);
      expect(app.view).toBe('plan');
      expect(app.planChoice).toBe('pub/made-plan');
      // A plan is not taken back with a rename of the file: no way back is offered.
      expect(app.toast?.undo).toBeUndefined();
    });

    it('keeps the wizard open when the engine refuses the plan', async () => {
      const { app, hub } = await ready();
      app.openPlanWizard();
      hub.next_ops = {
        kind: 'tasks.result',
        ok: false,
        dry_run: false,
        results: [
          {
            n: 1,
            op: 'plan_new',
            ok: false,
            outcome: 'failed',
            changed_ids: [],
            error: { code: 'invalid_argument', message: 'gate must be `hard` or absent', retryable: false },
          },
        ],
      } as unknown as Result;
      await app.createPlan(form);
      expect(app.planning).toBe(true);
      expect(app.view).not.toBe('plan');
      expect(app.toast?.kind).toBe('error');
    });
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

  it('queues an undo that comes while the write still re-reads the list', async () => {
    const { app, hub } = await ready();
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    const read = hub.snapshot.bind(hub);
    hub.snapshot = async (etag: string | null) => {
      await held;
      return read(etag);
    };
    const first = app.setField('pub/a', 'prio', 1);
    await vi.waitFor(() => expect(app.toast?.undo).toBeDefined());
    const undone = app.undo();
    expect(hub.sent).toHaveLength(1);
    release();
    await first;
    await undone;
    expect(hub.sent).toHaveLength(2);
    expect(hub.sent[1]?.ops[0]).toMatchObject({ op: 'set', id: 'pub/a', patch: { status: 'open' } });
  });

  it('does not undo the toast of an earlier write while a newer one waits for its answer', async () => {
    const { app, hub } = await ready();
    await app.setField('pub/a', 'prio', 1);
    expect(app.toast?.undo).toBeDefined();
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    const send = hub.ops.bind(hub);
    hub.ops = async (request) => {
      await held;
      return send(request);
    };
    const second = app.setField('pub/a', 'prio', 2);
    await vi.waitFor(() => expect(app.answering).toBe(true));
    await app.undo();
    // Refused and kept: nothing was sent for it, the toast stays.
    expect(hub.sent).toHaveLength(1);
    expect(app.toast?.undo).toBeDefined();
    release();
    await second;
    expect(app.answering).toBe(false);
  });

  it('says so when an undo that was queued cannot be sent any more', async () => {
    const { app, hub } = await ready();
    await app.setField('pub/a', 'prio', 1);
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    hub.snapshot = async () => {
      await held;
      throw new ApiError(503, 'engine_unavailable', 'x');
    };
    const second = app.setField('pub/a', 'prio', 2);
    await vi.waitFor(() => expect(hub.sent).toHaveLength(2));
    const undone = app.undo();
    release();
    await second;
    await undone;
    expect(hub.sent).toHaveLength(2);
    expect(app.toast?.kind).toBe('error');
  });

  describe('the memory of the palette', () => {
    it('keeps the id of a task only when the class of its area may be kept in the browser', async () => {
      const entry = (id: string, area: string) => task(id, { area } as Partial<TaskEntry>);
      const m = make({ token: 't' });
      m.hub.areaList = [
        { name: 'pub', data_class: 'public' },
        { name: 'inner', data_class: 'internal' },
        { name: 'secret', data_class: 'private' },
      ];
      m.hub.doc = snapshot([entry('pub/a', 'pub'), entry('inner/b', 'inner'), entry('secret/c', 'secret'), entry('new/d', 'new')]);
      await m.app.start(null);
      m.app.stop();
      // The classes are read after the list; before that nothing is kept (closed, not open).
      await vi.waitFor(() => expect(m.app.hubAreas).toHaveLength(3));
      for (const id of ['pub/a', 'inner/b', 'secret/c', 'new/d']) m.app.chose(`task:${id}`, id);
      m.app.chose('action:go.today');
      // Private and unclassified are not put into the profile; an action has no task to hide.
      expect(Object.keys(m.app.frecency).sort()).toEqual(['action:go.today', 'task:inner/b', 'task:pub/a']);
      expect(JSON.stringify([...m.prefs.values()])).not.toContain('secret/c');
    });
  });

  describe('the conflict center', () => {
    it('shows every conflict until the person chooses one at a time, and remembers the choice', () => {
      const prefs = new Map<string, string>();
      const first = make({ prefs });
      expect(first.app.conflictMode).toBe('list');
      first.app.setConflictMode('single');
      expect(prefs.get('tasks-desktop.conflict-mode')).toBe('single');
      expect(make({ prefs }).app.conflictMode).toBe('single');
      // Anything else in the profile is the default again.
      prefs.set('tasks-desktop.conflict-mode', '<img src=x>');
      expect(make({ prefs }).app.conflictMode).toBe('list');
    });

    const refused = (code: string): Result =>
      ({
        kind: 'tasks.result',
        ok: false,
        dry_run: false,
        results: [
          { n: 1, op: 'set', id: 'pub/a', ok: false, outcome: 'failed', changed_ids: [], error: { code, message: 'x', retryable: false } },
        ],
      }) as unknown as Result;

    it('keeps a refused change, with what was wanted, and tries it again on the version that is there', async () => {
      const { app, hub } = await ready();
      hub.next_ops = refused('conflict');
      await app.setField('pub/a', 'status', 'doing');
      expect(app.conflicts).toHaveLength(1);
      expect(app.conflicts[0]).toMatchObject({ id: 'pub/a', code: 'conflict', op: { patch: { status: 'doing' } } });
      const key = app.conflicts[0]?.key as string;
      await app.retryConflict(key);
      // It left the list, and went out with the version the list has now.
      expect(app.conflicts).toHaveLength(0);
      expect(hub.sent).toHaveLength(2);
      expect(hub.sent[1]?.ops[0]).toMatchObject({ op: 'set', id: 'pub/a', patch: { status: 'doing' } });
    });

    it('does not drop an entry when the page is not connected, and tries again for a bulk tag change on the tags it has then', async () => {
      const tagged = (id: string, etag: string, tags: string[]) => task(id, { etag, status: 'open', group: 'open|1', tags } as Partial<TaskEntry>);
      const { app, hub } = await ready([tagged('pub/a', 'e1', ['x', 'y'])]);
      app.toggleMark('pub/a');
      hub.next_ops = refused('conflict');
      await app.bulkSet({}, { add: ['n'], remove: ['y'] });
      expect(app.conflicts).toHaveLength(1);
      expect(app.conflicts[0]?.tags).toEqual({ add: ['n'], remove: ['y'] });
      // Not connected: nothing is sent and the entry stays.
      app.phase = 'offline';
      await app.retryConflict(app.conflicts[0]?.key as string);
      expect(hub.sent).toHaveLength(1);
      expect(app.conflicts).toHaveLength(1);
      // Connected again, and somebody added a tag meanwhile: the retry keeps it.
      app.phase = 'ready';
      hub.doc = snapshot([tagged('pub/a', 'e2', ['x', 'y', 'm'])], 'rev:2');
      await app.refresh();
      await app.retryConflict(app.conflicts[0]?.key as string);
      expect(hub.sent[1]?.ops[0]).toMatchObject({ patch: { tags: ['x', 'm', 'n'] }, if_match: 'e2' });
    });

    it('puts a change that is refused again back as one entry, and lets go of it on request', async () => {
      const { app, hub } = await ready();
      hub.next_ops = refused('conflict');
      await app.setField('pub/a', 'status', 'doing');
      hub.next_ops = refused('conflict');
      await app.retryConflict(app.conflicts[0]?.key as string);
      expect(app.conflicts).toHaveLength(1);
      app.openConflicts();
      expect(app.conflictsOpen).toBe(true);
      app.discardConflict(app.conflicts[0]?.key as string);
      expect(app.conflicts).toHaveLength(0);
      expect(app.conflictsOpen).toBe(false);
    });

    it('does not keep what is refused as wrong, and keeps every change of a request refused as a whole', async () => {
      const { app, hub } = await ready();
      hub.next_ops = refused('invalid_argument');
      await app.setField('pub/a', 'prio', 9);
      expect(app.conflicts).toHaveLength(0);
      hub.next_ops = new ApiError(409, 'conflict', 'x');
      await app.setField('pub/a', 'prio', 1);
      expect(app.conflicts.map((c) => c.id)).toEqual(['pub/a']);
    });

    it('does not offer a try again for a change of the order', async () => {
      const card = (id: string, etag: string) => task(id, { etag, status: 'open', group: 'open|1' } as Partial<TaskEntry>);
      const { app, hub } = await ready([card('pub/a', 'e1'), card('pub/b', 'e2')]);
      hub.next_ops = {
        kind: 'tasks.result',
        ok: false,
        results: [{ n: 1, op: 'reorder', id: 'pub/a', ok: false, outcome: 'failed', changed_ids: [], error: { code: 'conflict', message: 'x', retryable: false } }],
      } as unknown as Result;
      await app.stepCard('pub/a', 1);
      expect(app.conflicts).toHaveLength(1);
      await app.retryConflict(app.conflicts[0]?.key as string);
      expect(hub.sent).toHaveLength(1);
      expect(app.conflicts).toHaveLength(1);
    });
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

  describe('the text of a task: a step and a note', () => {
    const entry = (op: string, extra: Record<string, unknown> = {}) => ({
      n: 1,
      op,
      id: 'pub/a',
      ok: true,
      outcome: 'changed',
      changed_ids: ['pub/a'],
      ...extra,
    });
    const answer = (...entries: unknown[]) =>
      ({ kind: 'tasks.result', ok: entries.every((e) => (e as { ok: boolean }).ok), dry_run: false, results: entries }) as unknown as Result;

    it('ticks a step with the version the steps were read from, and takes it back with the inverse', async () => {
      const { app, hub } = await ready([task('pub/a', { etag: 'e1' })]);
      hub.next_ops = answer(
        entry('tick_step', { inverse: { op: 'tick_step', id: 'pub/a', n: 2, done: false, if_match: 'e2' } }),
      );
      await app.tickStep('pub/a', 2, true, 'e1');
      expect(hub.sent[0]?.ops).toEqual([{ op: 'tick_step', id: 'pub/a', n: 2, done: true, if_match: 'e1' }]);
      expect(app.toast?.kind).toBe('ok');
      expect(app.toast?.undo).toEqual([{ op: 'tick_step', id: 'pub/a', n: 2, done: false, if_match: 'e2' }]);
      await app.undo();
      expect(hub.sent[1]?.ops).toEqual([{ op: 'tick_step', id: 'pub/a', n: 2, done: false, if_match: 'e2' }]);
      expect(app.toast?.undo).toBeUndefined();
    });

    it('offers no undo for a tick whose inverse lacks the step number', async () => {
      const { app, hub } = await ready([task('pub/a', { etag: 'e1' })]);
      hub.next_ops = answer(entry('tick_step', { inverse: { op: 'tick_step', id: 'pub/a', done: false } }));
      await app.tickStep('pub/a', 1, true);
      expect(app.toast?.undo).toBeUndefined();
      // No version was known: none is sent (the engine then writes on whatever it finds).
      expect(hub.sent[0]?.ops[0]).not.toHaveProperty('if_match');
    });

    it('says a refused tick and keeps no entry of it in the conflict center', async () => {
      const { app, hub } = await ready([task('pub/a', { etag: 'e1' })]);
      hub.next_ops = answer({
        n: 1,
        op: 'tick_step',
        id: 'pub/a',
        ok: false,
        outcome: 'failed',
        changed_ids: [],
        error: { code: 'conflict', message: 'x', retryable: false },
      });
      await app.tickStep('pub/a', 1, true, 'e1');
      expect(app.toast?.kind).toBe('error');
      expect(app.conflicts).toEqual([]);
    });

    it('adds a note once, with no way back, and says whether it was written', async () => {
      const { app, hub } = await ready([task('pub/a', { etag: 'e1' })]);
      hub.next_ops = answer(entry('append_note'));
      expect(await app.addNote('pub/a', 'a line', 'e1')).toBe(true);
      expect(hub.sent[0]?.ops).toEqual([{ op: 'append_note', id: 'pub/a', text: 'a line', if_match: 'e1' }]);
      expect(app.toast?.undo).toBeUndefined();
      hub.next_ops = answer({
        n: 1,
        op: 'append_note',
        id: 'pub/a',
        ok: false,
        outcome: 'failed',
        changed_ids: [],
        error: { code: 'invalid_argument', message: 'the note is empty', retryable: false },
      });
      expect(await app.addNote('pub/a', '  ', 'e1')).toBe(false);
      expect(app.toast?.text).toContain('the note is empty');
    });

    it('discards a task by parking it, and writes the note only when the status was written', async () => {
      const { app, hub } = await ready([task('pub/a', { etag: 'e1' })]);
      app.setLang('en');
      expect(await app.discard('pub/a', '   ', 'e1')).toBe(false);
      expect(hub.sent).toHaveLength(0);
      expect(await app.discard('pub/a', ' not needed any more ', 'e1')).toBe(true);
      expect(hub.sent.map((r) => r.ops)).toEqual([
        [{ op: 'set', id: 'pub/a', patch: { status: 'parked' }, if_match: 'e1' }],
        [{ op: 'append_note', id: 'pub/a', text: 'Discarded: not needed any more' }],
      ]);
      // A conflict on the status: the note is not written at all.
      hub.next_ops = answer({
        n: 1,
        op: 'set',
        id: 'pub/a',
        ok: false,
        outcome: 'failed',
        changed_ids: [],
        error: { code: 'conflict', message: 'x', retryable: false },
      });
      expect(await app.discard('pub/a', 'x', 'e1')).toBe(false);
      expect(hub.sent).toHaveLength(3);
      // A line the engine would refuse is told before the status is written.
      expect(await app.discard('pub/a', 'y'.repeat(1000), 'e1')).toBe(false);
      expect(hub.sent).toHaveLength(3);
      expect(app.toast?.kind).toBe('error');
    });

    it('moves a task to another area with the version it was read from, follows it and takes it back', async () => {
      const { app, hub } = await ready([task('pub/a', { etag: 'e1' })]);
      app.select('pub/a');
      hub.next_ops = answer(entry('move_area', { outcome: 'moved', new_id: 'inner/a', inverse: { op: 'move_area', id: 'inner/a', to_area: 'pub', if_match: 'e2' } }));
      // The list is read again after the write: it holds the task under its new id.
      hub.doc = snapshot([task('inner/a', { etag: 'e2' })]);
      expect(await app.moveArea('pub/a', 'inner', 'e1')).toBe(true);
      expect(hub.sent[0]?.ops).toEqual([{ op: 'move_area', id: 'pub/a', to_area: 'inner', if_match: 'e1' }]);
      expect(app.selectedId).toBe('inner/a');
      expect(app.toast?.undo).toEqual([{ op: 'move_area', id: 'inner/a', to_area: 'pub', if_match: 'e2' }]);
      // Taking it back: the selection returns to the old id.
      hub.doc = snapshot([task('pub/a', { etag: 'e3' })]);
      hub.next_ops = answer(entry('move_area', { id: 'inner/a', outcome: 'moved', new_id: 'pub/a' }));
      await app.undo();
      expect(hub.sent[1]?.ops).toEqual([{ op: 'move_area', id: 'inner/a', to_area: 'pub', if_match: 'e2' }]);
      expect(app.selectedId).toBe('pub/a');
      // A refusal is not a move.
      hub.next_ops = answer({ n: 1, op: 'move_area', id: 'pub/a', ok: false, outcome: 'failed', changed_ids: [], error: { code: 'invalid_argument', message: 'taken', retryable: false } });
      expect(await app.moveArea('pub/a', 'inner', 'e1')).toBe(false);
      expect(app.selectedId).toBe('pub/a');
    });

    it('asks what a move would break as a dry run and writes nothing', async () => {
      const { app, hub } = await ready([task('pub/a', { etag: 'e1' })]);
      const move = { new_id: 'inner/a', to_area: 'inner', from: 'x', to: 'y', folder: false, conflicts: [], references: [{ kind: 'blocked_by', id: 'pub/b' }], notes: [] };
      hub.next_ops = answer(entry('move_area', { outcome: 'would_move', move, changed_ids: [] }));
      expect(await app.previewMove('pub/a', 'inner')).toEqual({ kind: 'ok', move });
      expect(hub.sent[0]?.dry_run).toBe(true);
      expect(app.toast).toBeNull();
    });

    it('sets the text with the version it was read from, takes it back with the old text, and says whether it was written', async () => {
      const { app, hub } = await ready([task('pub/a', { etag: 'e1' })]);
      hub.next_ops = answer(entry('set_body', { inverse: { op: 'set_body', id: 'pub/a', body: 'The old text.', if_match: 'e2' } }));
      expect(await app.setBody('pub/a', 'The new text.', 'e1')).toBe(true);
      expect(hub.sent[0]?.ops).toEqual([{ op: 'set_body', id: 'pub/a', body: 'The new text.', if_match: 'e1' }]);
      expect(app.toast?.undo).toEqual([{ op: 'set_body', id: 'pub/a', body: 'The old text.', if_match: 'e2' }]);
      await app.undo();
      expect(hub.sent[1]?.ops).toEqual([{ op: 'set_body', id: 'pub/a', body: 'The old text.', if_match: 'e2' }]);

      // No inverse (an old text too long to be sent again): no undo; a conflict: not written.
      hub.next_ops = answer(entry('set_body'));
      expect(await app.setBody('pub/a', 'x', 'e1')).toBe(true);
      expect(app.toast?.undo).toBeUndefined();
      hub.next_ops = answer({
        n: 1,
        op: 'set_body',
        id: 'pub/a',
        ok: false,
        outcome: 'failed',
        changed_ids: [],
        error: { code: 'conflict', message: 'x', retryable: false },
      });
      expect(await app.setBody('pub/a', 'y', 'e1')).toBe(false);
    });

    it('does not claim a note that never left the page', async () => {
      const { app, hub } = await ready([task('pub/a', { etag: 'e1' })]);
      hub.next_ops = new ApiError(502, 'outcome_unknown', 'x');
      expect(await app.addNote('pub/a', 'a line')).toBe(false);
    });
  });

  describe('opening a task in Neovim', () => {
    it('asks the hub for the task by its id and says so', async () => {
      const { app, hub } = await ready();
      await app.openInEditor('pub/a');
      expect(hub.vaultCalls).toEqual(['open pub/a']);
      expect(app.toast?.kind).toBe('ok');
    });

    it('tells the reason when the hub cannot', async () => {
      const { app, hub } = await ready();
      hub.vaultError = new ApiError(502, 'open_failed', 'no way to open a window with Neovim is known on this system');
      await app.openInEditor('pub/a');
      expect(app.toast?.kind).toBe('error');
      expect(app.toast?.text).toContain('no way to open a window');
    });
  });

  describe('finishing and bringing a task back', () => {
    const doneEntry = (extra: Record<string, unknown> = {}) =>
      ({
        kind: 'tasks.result',
        ok: true,
        dry_run: false,
        results: [{ n: 1, op: 'done', id: 'pub/a', ok: true, outcome: 'done', changed_ids: ['pub/a'], ...extra }],
      }) as unknown as Result;

    it('offers to bring the task back after finishing it, and sends reopen on undo', async () => {
      const { app, hub } = await ready([task('pub/a', { etag: 'e1' })]);
      await app.startFinish('pub/a');
      hub.next_ops = doneEntry();
      await app.confirmFinish();
      expect(app.toast?.undo).toEqual([{ op: 'reopen', id: 'pub/a' }]);
      await app.undo();
      expect(hub.sent[1]?.ops).toEqual([{ op: 'reopen', id: 'pub/a' }]);
    });

    it('offers no way back when finishing ticked steps or closed a plan: reopen would leave those as they are', async () => {
      const { app, hub } = await ready([task('pub/a', { etag: 'e1' })]);
      await app.startFinish('pub/a');
      hub.next_ops = doneEntry({ steps_ticked: 2 });
      await app.confirmFinish();
      expect(app.toast?.undo).toBeUndefined();
      await app.startFinish('pub/a');
      hub.next_ops = doneEntry({ plans_closed: ['pub/plan'] });
      await app.confirmFinish();
      expect(app.toast?.undo).toBeUndefined();
    });

    it('brings a finished task back from a reminder, with no undo of its own', async () => {
      const { app, hub } = await ready();
      await app.reopen('pub/old');
      expect(hub.sent[0]?.ops).toEqual([{ op: 'reopen', id: 'pub/old' }]);
      expect(app.toast?.undo).toBeUndefined();
    });
  });

  describe('a task made with a text', () => {
    it('sends the text, trimmed, and none when there is none', async () => {
      const { app, hub } = await ready();
      await app.createTask('pub', 'With text', {}, '  First line.\n\nMore.\n ');
      expect(hub.sent[0]?.ops[0]).toEqual({
        op: 'new',
        area: 'pub',
        title: 'With text',
        body: 'First line.\n\nMore.',
      });
      await app.createTask('pub', 'No text', { prio: 1 }, '   \n ');
      expect(hub.sent[1]?.ops[0]).toEqual({ op: 'new', area: 'pub', title: 'No text', fields: { prio: 1 } });
    });
  });

  describe('the numbers of the overview', () => {
    it('opens and closes the tasks behind a number, one at a time', async () => {
      const { app } = await ready();
      expect(app.countOpen).toBeNull();
      app.toggleCount('doing');
      expect(app.countOpen).toBe('doing');
      app.toggleCount('blocked');
      expect(app.countOpen).toBe('blocked');
      app.toggleCount('blocked');
      expect(app.countOpen).toBeNull();
    });

    it('keeps the view of each number, walks the views with the key, and reads the choice back', async () => {
      const { app, prefs } = await ready();
      expect(app.countView('blocked')).toBe('list');
      // The first press opens the number in the view it has; the next goes on.
      app.cycleCountView('blocked');
      expect(app.countOpen).toBe('blocked');
      expect(app.countView('blocked')).toBe('list');
      app.cycleCountView('blocked');
      expect(app.countView('blocked')).toBe('blocker');
      expect(app.countView('ready')).toBe('list');
      app.setCountView('ready', 'area');
      const saved = prefs.get('tasks-desktop.count-views') ?? '';
      expect(JSON.parse(saved)).toEqual({ blocked: 'blocker', ready: 'area' });
      const again = make({ prefs });
      expect(again.app.countView('blocked')).toBe('blocker');
      expect(again.app.countView('ready')).toBe('area');
    });

    it('opens the doing and blocked tasks in the list with their status, and has no list filter for the others', async () => {
      const { app } = await ready();
      app.openCountInList('blocked');
      expect(app.filter.statuses).toEqual(['blocked']);
      expect(app.view).toBe('list');
      app.setView('today');
      app.openCountInList('ready');
      expect(app.view).toBe('today');
    });
  });

  describe('the vaults', () => {
    /** The list is read after the page is shown, in the background: wait for it. */
    async function readyVaults() {
      const m = await ready();
      await vi.waitFor(() => expect(m.app.vaultList).not.toBeNull());
      return m;
    }

    it('reads the list after the page is ready, and has none when the hub has none', async () => {
      const { app } = await readyVaults();
      expect(app.vaultList?.active).toBe('main');
      expect(app.vaultList?.vaults.map((v) => v.name)).toEqual(['main', 'native']);
      const none = make({ token: 't' });
      none.hub.vaultDoc = null;
      await none.app.start(null);
      none.app.stop();
      await vi.waitFor(() => expect(none.hub.snapshotCalls.length).toBeGreaterThan(0));
      await new Promise((r) => setTimeout(r, 20));
      expect(none.app.vaultList).toBeNull();
      none.app.openVaults();
      expect(none.app.managingVaults).toBe(false);
    });

    it('chooses another vault: the hub is asked, the cached list of the old one goes, the page loads again', async () => {
      const { app, hub, cleared, reloads, prefs } = await readyVaults();
      const before = cleared();
      // A filter of the vault that is left (its areas, tags, plans) is not taken to the next one.
      app.filter = { ...app.filter, areas: ['only-in-main'] };
      await app.selectVault('native');
      expect(app.filter.areas).toEqual([]);
      // What is read after the reload is the empty filter, not the one of the vault that was left, and it names the
      // vault it was chosen for.
      expect(make({ token: 't', prefs }).app.filter.areas).toEqual([]);
      expect(JSON.parse(prefs.get('tasks-desktop.filter') ?? '{}')).toMatchObject({ vault: 'native' });
      expect(hub.vaultCalls).toEqual(['select native']);
      expect(cleared()).toBe(before + 1);
      expect(reloads()).toBe(1);
    });

    it('does nothing for the vault that is read, and leaves the page alone when the hub refuses', async () => {
      const { app, hub, cleared, reloads } = await readyVaults();
      await app.selectVault('main');
      expect(hub.vaultCalls).toEqual([]);
      const before = cleared();
      hub.vaultError = new ApiError(400, 'vault_refused', 'this vault cannot be read (vault_empty)');
      await app.selectVault('native');
      expect(reloads()).toBe(0);
      expect(cleared()).toBe(before);
      expect(app.toast?.kind).toBe('error');
      expect(app.toast?.text).toContain('vault_empty');
      expect(app.vaultBusy).toBe(false);
    });

    it('adds a vault with its name and folder, reads the list again, and says when the hub refuses', async () => {
      const { app, hub } = await readyVaults();
      expect(await app.addVault(' work ', ' C:/repos/work ')).toBe(true);
      expect(hub.vaultCalls).toEqual(['add work C:/repos/work']);
      expect(app.vaultList?.vaults.map((v) => v.name)).toContain('work');
      expect(app.toast?.kind).toBe('ok');
      hub.vaultError = new ApiError(400, 'vault_refused', 'there is no such folder');
      expect(await app.addVault('gone', 'C:/nope')).toBe(false);
      expect(app.toast?.kind).toBe('error');
      expect(app.toast?.text).toContain('there is no such folder');
    });

    it('forgets a vault and reads the list again', async () => {
      const { app, hub } = await readyVaults();
      await app.removeVault('native');
      expect(hub.vaultCalls).toEqual(['remove native']);
      expect(app.vaultList?.vaults.map((v) => v.name)).toEqual(['main']);
    });
  });
});

describe('the inbox', () => {
  const unsorted = (id: string, extra: Partial<TaskEntry> = {}) => task(id, { etag: `e-${id}`, ...extra });
  const sorted = { prio: 2, effort: 'S', actor: 'me', actor_written: true } as Partial<TaskEntry>;

  async function inboxApp(tasks: TaskEntry[]) {
    const m = make({ token: 't' });
    m.hub.doc = snapshot(tasks);
    await m.app.start(null);
    m.app.stop();
    m.app.setView('inbox');
    return m;
  }

  it('holds the tasks that lack something, and a key writes the field it names on the selected task', async () => {
    const { app, hub } = await inboxApp([unsorted('pub/a'), unsorted('pub/b', sorted), unsorted('pub/c', { prio: 1 })]);
    expect(app.inbox.map((t) => t.id)).toEqual(['pub/a', 'pub/c']);
    // Entering the view puts the selection on the first row.
    expect(app.selectedId).toBe('pub/a');
    await app.triage('1', false);
    expect(hub.sent).toHaveLength(1);
    expect(hub.sent[0]?.ops).toEqual([{ op: 'set', id: 'pub/a', patch: { prio: 1 }, if_match: 'e-pub/a' }]);
    await app.triage('F', true);
    expect(hub.sent[1]?.ops).toEqual([{ op: 'set', id: 'pub/a', patch: { effort: 'XL' }, if_match: 'e-pub/a' }]);
    await app.triage('i', false);
    expect(hub.sent[2]?.ops).toEqual([{ op: 'set', id: 'pub/a', patch: { actor: 'cdx' }, if_match: 'e-pub/a' }]);
  });

  it('sends nothing for a key that names nothing, without a selection, or while a write is under way', async () => {
    const { app, hub } = await inboxApp([unsorted('pub/a'), unsorted('pub/b')]);
    app.select(null);
    await app.triage('1', false);
    expect(hub.sent).toHaveLength(0);
    app.moveSelectionInbox(1);
    await app.triage('x', false);
    await app.triage('4', false);
    expect(hub.sent).toHaveLength(0);
    const first = app.triage('2', false);
    const second = app.triage('3', false);
    // Refused aloud, not dropped without a word (and not kept for later).
    expect(app.toast).toEqual({ kind: 'error', text: translate(app.lang, 'write.busy') });
    await second;
    await first;
    expect(hub.sent).toHaveLength(1);
    expect(hub.sent[0]?.ops[0]).toMatchObject({ patch: { prio: 2 } });
  });

  it('keeps the selection at the same place when the task is sorted and leaves', async () => {
    const { app, hub } = await inboxApp([unsorted('pub/a', { prio: 2, effort: 'S' }), unsorted('pub/b'), unsorted('pub/c')]);
    app.select('pub/a');
    // The engine writes the actor: the list that is read next has the task sorted.
    const ops = hub.ops.bind(hub);
    hub.ops = async (request) => {
      const result = await ops(request);
      hub.doc = snapshot([unsorted('pub/a', sorted), unsorted('pub/b'), unsorted('pub/c')], 'rev:2');
      return result;
    };
    await app.triage('m', false);
    expect(app.inbox.map((t) => t.id)).toEqual(['pub/b', 'pub/c']);
    expect(app.selectedId).toBe('pub/b');
  });
});

describe('the estimate matrix', () => {
  const planned = (id: string, extra: Partial<TaskEntry> = {}) => task(id, { etag: `e-${id}`, ...extra });

  async function matrixApp(tasks: TaskEntry[]) {
    const m = make({ token: 't' });
    m.hub.doc = snapshot(tasks);
    await m.app.start(null);
    m.app.stop();
    return m;
  }

  it('opens on the marked tasks, else on the shown ones, and asks the engine for the figures', async () => {
    const { app, hub } = await matrixApp([planned('pub/a'), planned('pub/b'), planned('pub/c')]);
    app.toggleMark('pub/b');
    app.openMatrix();
    expect(app.matrix?.ids).toEqual(['pub/b']);
    await vi.waitFor(() => expect(app.matrixFigures).not.toBeNull());
    expect(hub.estimates[0]).toEqual({ ids: ['pub/b'] });
    app.closeMatrix();
    expect(app.matrix).toBeNull();
    app.clearMarks();
    app.openMatrix();
    expect(app.matrix?.ids).toEqual(['pub/a', 'pub/b', 'pub/c']);
  });

  it('asks again for the draft a moment after a cell was chosen, with only the chosen cells', async () => {
    const { app, hub } = await matrixApp([planned('pub/a'), planned('pub/b')]);
    app.openMatrix();
    await vi.waitFor(() => expect(app.matrixFigures).not.toBeNull());
    app.setCell('pub/a', 'effort', 'M');
    app.setCell('pub/a', 'value', 4);
    await vi.waitFor(() => expect(hub.estimates).toHaveLength(2));
    expect(hub.estimates[1]).toEqual({ ids: ['pub/a', 'pub/b'], assume: [{ id: 'pub/a', effort: 'M', value: 4 }] });
    // The figures are the engine's: the page does not reckon.
    expect(app.matrixFigures?.days).toBe(5);
    // Put back, the question has no assumptions.
    app.setCell('pub/a', 'effort', undefined);
    app.setCell('pub/a', 'value', undefined);
    await vi.waitFor(() => expect(hub.estimates).toHaveLength(3));
    expect(hub.estimates[2]).toEqual({ ids: ['pub/a', 'pub/b'] });
  });

  it('does not let an older, slower answer replace a newer one', async () => {
    const { app, hub } = await matrixApp([planned('pub/a')]);
    app.openMatrix();
    await vi.waitFor(() => expect(app.matrixFigures).not.toBeNull());
    let release!: () => void;
    // The next question is held; the one after it is answered at once.
    hub.estimateHold = [new Promise<void>((resolve) => (release = resolve))];
    app.setCell('pub/a', 'value', 1);
    await vi.waitFor(() => expect(hub.estimates).toHaveLength(2));
    app.setCell('pub/a', 'value', 2);
    await vi.waitFor(() => expect(hub.estimates).toHaveLength(3));
    await vi.waitFor(() => expect(app.matrixFigures?.assumed).toBe(1));
    const newer = app.matrixFigures;
    release();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(app.matrixFigures).toBe(newer);
  });

  it('shows the words of the engine when it refuses what was chosen', async () => {
    const { app, hub } = await matrixApp([planned('pub/a')]);
    app.openMatrix();
    await vi.waitFor(() => expect(app.matrixFigures).not.toBeNull());
    hub.estimateError = new ApiError(400, 'bad_request', "assume[1].effort: 'huge' is not an effort (XS S M L XL or <n>d)");
    app.setCell('pub/a', 'effort', 'huge');
    await vi.waitFor(() => expect(app.matrixProblem).toMatch(/is not an effort/));
  });

  it('writes one batch with only the cells that differ, and closes when all went through', async () => {
    const { app, hub } = await matrixApp([planned('pub/a', { effort: 'S' }), planned('pub/b'), planned('pub/c')]);
    app.openMatrix();
    app.setCell('pub/a', 'effort', 'S');
    app.setCell('pub/b', 'effort', 'M');
    app.setCell('pub/b', 'value', 3);
    await app.applyMatrix();
    expect(hub.sent).toHaveLength(1);
    expect(hub.sent[0]?.ops).toEqual([{ op: 'set', id: 'pub/b', patch: { effort: 'M', value: 3 }, if_match: 'e-pub/b' }]);
    expect(app.matrix).toBeNull();
    expect(app.toast?.kind).toBe('ok');
  });

  it('keeps the task that failed with its cells in the matrix and takes the others out of the draft', async () => {
    const { app, hub } = await matrixApp([planned('pub/a'), planned('pub/b')]);
    app.openMatrix();
    app.setCell('pub/a', 'value', 2);
    app.setCell('pub/b', 'value', 5);
    hub.next_ops = {
      kind: 'tasks.result',
      ok: false,
      dry_run: false,
      results: [
        { n: 1, op: 'set', id: 'pub/a', ok: true, outcome: 'changed', changed_ids: ['pub/a'], inverse: { op: 'set', id: 'pub/a', patch: {}, if_match: 'e2' } },
        { n: 2, op: 'set', id: 'pub/b', ok: false, error: { code: 'conflict', message: 'changed meanwhile', retryable: false } },
      ],
    } as unknown as Result;
    await app.applyMatrix();
    expect(app.matrix).not.toBeNull();
    // The cell that stays has no old version: it is written with the one that is current at the next Apply.
    expect(app.matrixDraft).toEqual({ 'pub/b': { value: 5 } });
    expect(app.toast?.kind).toBe('error');
    expect(app.toast?.text).toMatch(/1\D+1/);
  });

  it('writes nothing when nothing differs, and does not open without the capability', async () => {
    const { app, hub } = await matrixApp([planned('pub/a', { effort: 'S' })]);
    app.openMatrix();
    app.setCell('pub/a', 'effort', 'S');
    await app.applyMatrix();
    expect(hub.sent).toHaveLength(0);
    app.closeMatrix();
    hub.capabilities = ['reorder'];
    const other = await matrixApp([planned('pub/a')]);
    other.hub.capabilities = ['reorder'];
    other.app.capabilities = ['reorder'];
    other.app.openMatrix();
    expect(other.app.matrix).toBeNull();
  });
});

describe('the graph of a task', () => {
  async function graphApp(capabilities?: string[]) {
    const m = make({ token: 't' });
    if (capabilities) m.hub.capabilities = capabilities;
    m.hub.doc = snapshot([task('pub/a', { etag: 'e1' })]);
    await m.app.start(null);
    m.app.stop();
    return m;
  }

  it('is asked for in the plan view and shows what the engine gives', async () => {
    const { app, hub } = await graphApp();
    app.openGraph('pub/a');
    expect(app.view).toBe('plan');
    expect(app.graph).toEqual({ id: 'pub/a', direction: 'needs' });
    await vi.waitFor(() => expect(app.graphDoc).not.toBeNull());
    expect(hub.graphs).toEqual([{ id: 'pub/a', direction: 'needs' }]);
    expect(app.graphDoc?.nodes.map((n) => n.id)).toEqual(['pub/a', 'pub/first']);
    app.openGraph('pub/a', 'unlocks');
    await vi.waitFor(() => expect(hub.graphs).toHaveLength(2));
    expect(hub.graphs[1]).toEqual({ id: 'pub/a', direction: 'unlocks' });
    app.closeGraph();
    expect(app.graph).toBeNull();
    expect(app.graphDoc).toBeNull();
  });

  it('shows the words of the engine when it refuses, and does not open without the capability', async () => {
    const { app, hub } = await graphApp();
    hub.graphError = new ApiError(404, 'not_found', 'no such open task: pub/a');
    app.openGraph('pub/a');
    await vi.waitFor(() => expect(app.graphProblem).toBe('no such open task: pub/a'));
    const other = await graphApp(['reorder']);
    other.app.capabilities = ['reorder'];
    other.app.openGraph('pub/a');
    expect(other.app.graph).toBeNull();
  });

  it('does not let an older, slower answer replace a newer one', async () => {
    const { app, hub } = await graphApp();
    let release!: () => void;
    hub.graphHold = [new Promise<void>((resolve) => (release = resolve))];
    app.openGraph('pub/a', 'needs');
    await vi.waitFor(() => expect(hub.graphs).toHaveLength(1));
    app.openGraph('pub/a', 'unlocks');
    await vi.waitFor(() => expect(app.graphDoc?.direction).toBe('unlocks'));
    release();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(app.graphDoc?.direction).toBe('unlocks');
  });

  it('asks again after the vault changed, only when a graph is there', async () => {
    const { app, hub } = await graphApp();
    app.reloadGraph();
    expect(hub.graphs).toHaveLength(0);
    app.openGraph('pub/a');
    await vi.waitFor(() => expect(app.graphDoc).not.toBeNull());
    hub.doc = snapshot([task('pub/a', { etag: 'e1' }), task('pub/z')], 'rev:2');
    await app.refresh();
    app.reloadGraph();
    await vi.waitFor(() => expect(hub.graphs).toHaveLength(2));
  });
});

describe('the check of the vault', () => {
  const finding = (id: string, severity = 'warn') => ({ code: 'doing-while-blocked', severity, area: 'pub', id, file: `pub/ROADMAP/tasks/${id.split('/')[1]}.md`, message: 'status is doing but x is still open' });
  const done = (rev: string, findings: unknown[]) => ({
    state: 'done',
    id: 1,
    result: { kind: 'tasks.check', rev, findings, errors: 0, warnings: findings.length, tasks: 3, total: findings.length, truncated: false, notes: [] },
  });

  async function checkApp(capabilities?: string[]) {
    const m = make({ token: 't' });
    if (capabilities) m.hub.capabilities = capabilities;
    m.hub.doc = snapshot([task('pub/a', { etag: 'e1' }), task('pub/b', { etag: 'e2' })]);
    await m.app.start(null);
    m.app.stop();
    return m;
  }

  it('opens on the state the hub has, and does not open without the capability', async () => {
    const { app, hub } = await checkApp();
    hub.checkAnswers = [done('rev:1', [finding('pub/a')])];
    await app.openChecks();
    expect(app.checking).toBe(true);
    expect(hub.checkStates).toBe(1);
    expect(app.findingsFor('pub/a')).toHaveLength(1);
    expect(app.findingsFor('pub/b')).toEqual([]);
    const other = await checkApp(['reorder']);
    other.app.capabilities = ['reorder'];
    await other.app.openChecks();
    expect(other.app.checking).toBe(false);
  });

  it('starts the job and asks for its state while it runs, a second later each time', async () => {
    vi.useFakeTimers();
    try {
      const { app, hub } = await checkApp();
      hub.checkAnswers = [{ state: 'running', id: 1 }, { state: 'running', id: 1 }, done('rev:1', [finding('pub/b', 'error')])];
      await app.runCheck(true);
      expect(hub.checkStarts).toEqual([{ stale: 'refs' }]);
      expect(app.checkJob?.state).toBe('running');
      await vi.advanceTimersByTimeAsync(1000);
      expect(hub.checkStates).toBe(1);
      expect(app.checkJob?.state).toBe('running');
      await vi.advanceTimersByTimeAsync(1000);
      expect(app.checkJob?.state).toBe('done');
      // Done: no more asking.
      await vi.advanceTimersByTimeAsync(5000);
      expect(hub.checkStates).toBe(2);
      expect(app.findingsFor('pub/b').map((f) => f.severity)).toEqual(['error']);
      await app.runCheck(false);
      expect(hub.checkStarts[1]).toEqual({});
    } finally {
      vi.useRealTimers();
    }
  });

  it('shows no finding of a check that was made for a state the page never held', async () => {
    const { app, hub } = await checkApp();
    hub.checkAnswers = [done('rev:old', [finding('pub/a')])];
    await app.openChecks();
    expect(app.checkOutdated).toBe(true);
    expect(app.checkFindings).toEqual([]);
    expect(app.findingsFor('pub/a')).toEqual([]);
  });

  it('judges each finding by its task: one that is as it was holds, one that changed is greyed, one that is gone drops', async () => {
    const { app, hub } = await checkApp();
    const file = { ...finding('pub/a', 'error'), id: undefined, code: 'index-stale', file: 'pub/ROADMAP/TASKS.md' };
    const unlisted = { ...finding('pub/odd', 'error'), code: 'unknown-status' };
    hub.checkAnswers = [done('rev:3', [finding('pub/a'), finding('pub/b'), finding('pub/c'), file, unlisted])];
    hub.doc = snapshot([task('pub/a', { etag: 'e1' }), task('pub/b', { etag: 'e2' }), task('pub/c', { etag: 'e3' })], 'rev:3');
    await app.refresh();
    await app.openChecks();
    expect(app.checkOutdated).toBe(false);
    expect(app.checkChanged).toBe(0);
    expect(app.checkFindings).toHaveLength(5);
    // pub/b is written (a key of the inbox, Neovim), pub/c is finished: the others are untouched.
    hub.doc = snapshot([task('pub/a', { etag: 'e1' }), task('pub/b', { etag: 'e2-new' })], 'rev:2');
    await app.refresh();
    expect(app.checkOutdated).toBe(false);
    expect(app.findingsFor('pub/a')).toHaveLength(1);
    expect(app.findingsFor('pub/b')).toEqual([]);
    expect(app.findingsFor('pub/c')).toEqual([]);
    expect(app.checkStale.map((f) => f.id)).toEqual(['pub/b']);
    expect(app.checkChanged).toBe(2);
    // A finding about a file or an unlisted task has no version to go by: it stands.
    expect(app.checkFindings.map((f) => f.code)).toEqual(['doing-while-blocked', 'index-stale', 'unknown-status']);
    // The judged list is made once for a state, not once for every row that asks.
    expect(app.findingsFor('pub/a')).toBe(app.findingsFor('pub/a'));
  });

  it('grounds a check whose state the page reads only afterwards, and a new run starts from its own ground', async () => {
    const { app, hub } = await checkApp();
    // The job is done for rev:2 before the page has read that list.
    hub.checkAnswers = [done('rev:2', [finding('pub/a')])];
    await app.openChecks();
    expect(app.checkOutdated).toBe(true);
    hub.doc = snapshot([task('pub/a', { etag: 'e1-new' }), task('pub/b', { etag: 'e2' })], 'rev:2');
    await app.refresh();
    expect(app.checkOutdated).toBe(false);
    expect(app.findingsFor('pub/a')).toHaveLength(1);
    // A second run: its findings are judged on the versions of its own time, not the first run's.
    hub.doc = snapshot([task('pub/a', { etag: 'e1-newer' }), task('pub/b', { etag: 'e2' })], 'rev:3');
    await app.refresh();
    expect(app.findingsFor('pub/a')).toEqual([]);
    hub.checkAnswers = [{ ...done('rev:3', [finding('pub/a'), finding('pub/b')]), id: 2 }];
    await app.runCheck(false);
    expect(app.checkOutdated).toBe(false);
    expect(app.checkChanged).toBe(0);
    expect(app.findingsFor('pub/a')).toHaveLength(1);
    expect(app.findingsFor('pub/b')).toHaveLength(1);
  });

  it('grounds a check on the list the page held when it started, though a newer one was read before the job was seen done', async () => {
    const { app, hub } = await checkApp();
    hub.checkAnswers = [{ state: 'running', id: 1 }, done('rev:1', [finding('pub/a'), finding('pub/b')])];
    await app.runCheck(false);
    // A write (a key of the inbox) changes pub/b and the page reads the new list, then the job is seen done.
    hub.doc = snapshot([task('pub/a', { etag: 'e1' }), task('pub/b', { etag: 'e2-new' })], 'rev:9');
    await app.refresh();
    await app.openChecks();
    expect(app.checkOutdated).toBe(false);
    expect(app.findingsFor('pub/a')).toHaveLength(1);
    expect(app.findingsFor('pub/b')).toEqual([]);
    expect(app.checkChanged).toBe(1);
  });

  it('looks now and then for the check the hub starts by itself after a change, and stops looking after a while', async () => {
    vi.useFakeTimers();
    try {
      const { app, hub } = await checkApp();
      hub.checkAnswers = [done('rev:1', [finding('pub/a')])];
      await app.openChecks();
      expect(hub.checkStates).toBe(1);
      // The vault changes: the check on show is older than the list. The hub runs the next one after its quiet time.
      hub.doc = snapshot([task('pub/a', { etag: 'e1' }), task('pub/b', { etag: 'e2-new' })], 'rev:2');
      await app.refresh();
      hub.checkAnswers = [done('rev:1', [finding('pub/a')]), { ...done('rev:2', [finding('pub/a'), finding('pub/b')]), id: 2 }];
      await vi.advanceTimersByTimeAsync(15_000);
      expect(hub.checkStates).toBe(2);
      expect(app.checkJob).toMatchObject({ state: 'done', id: 1 });
      await vi.advanceTimersByTimeAsync(15_000);
      expect(app.checkJob).toMatchObject({ state: 'done', id: 2 });
      expect(app.checkOutdated).toBe(false);
      expect(app.findingsFor('pub/b')).toHaveLength(1);
      // The list is the check's: no more asking.
      await vi.advanceTimersByTimeAsync(60_000);
      expect(hub.checkStates).toBe(3);

      // A hub that does not run it (no client at the time, a check with refs): twelve looks, then none.
      hub.doc = snapshot([task('pub/a', { etag: 'e1' }), task('pub/b', { etag: 'e2-newer' })], 'rev:3');
      await app.refresh();
      hub.checkAnswers = Array.from({ length: 20 }, () => ({ ...done('rev:2', [finding('pub/a')]), id: 2 }));
      await vi.advanceTimersByTimeAsync(15_000 * 20);
      expect(hub.checkStates).toBe(3 + 12);
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps the words of a job that failed and of a hub that did not answer', async () => {
    const { app, hub } = await checkApp();
    hub.checkAnswers = [{ state: 'failed', id: 1, error: { code: 'timeout', message: 'the engine did not answer in time' } }];
    await app.openChecks();
    expect(app.checkJob).toMatchObject({ state: 'failed', error: { message: 'the engine did not answer in time' } });
    hub.checkError = new ApiError(503, 'engine_unavailable', 'the engine is not available');
    await app.runCheck(false);
    expect(app.checkProblem).toBe('the engine is not available');
  });
});

describe('what the reviews of the matrix, the inbox and the check found', () => {
  const planned = (id: string, extra: Partial<TaskEntry> = {}) => task(id, { etag: `e-${id}`, ...extra });
  async function started(tasks: TaskEntry[]) {
    const m = make({ token: 't' });
    m.hub.doc = snapshot(tasks);
    await m.app.start(null);
    m.app.stop();
    return m;
  }

  it('writes a cell with the version of the file as it was when the cell was chosen, not as it is now', async () => {
    const { app, hub } = await started([planned('pub/a'), planned('pub/b')]);
    app.openMatrix();
    app.setCell('pub/a', 'value', 3);
    // Someone changes the file of the task meanwhile: the list that is read next carries its new version.
    hub.doc = snapshot([planned('pub/a', { etag: 'e-new' }), planned('pub/b')], 'rev:2');
    await app.refresh();
    await app.applyMatrix();
    expect(hub.sent[0]?.ops).toEqual([{ op: 'set', id: 'pub/a', patch: { value: 3 }, if_match: 'e-pub/a' }]);
  });

  it('leaves a task that is gone out of the question and the draft, so the engine is not refused for ever', async () => {
    const { app, hub } = await started([planned('pub/a'), planned('pub/b')]);
    app.openMatrix();
    await vi.waitFor(() => expect(app.matrixFigures).not.toBeNull());
    app.setCell('pub/a', 'value', 2);
    app.setCell('pub/b', 'value', 4);
    // pub/b is finished in Neovim while the dialog is open.
    hub.doc = snapshot([planned('pub/a')], 'rev:2');
    await app.refresh();
    app.setCell('pub/a', 'effort', 'M');
    await vi.waitFor(() => expect(hub.estimates.at(-1)?.ids).toEqual(['pub/a']));
    expect(hub.estimates.at(-1)?.assume).toEqual([{ id: 'pub/a', effort: 'M', value: 2 }]);
    expect(Object.keys(app.matrixDraft)).toEqual(['pub/a']);
    expect(app.matrixChanges).toBe(1);
  });

  it('counts the tasks that change, not the cells that were touched', async () => {
    const { app } = await started([planned('pub/a', { effort: 'S' })]);
    app.openMatrix();
    app.setCell('pub/a', 'effort', 'S');
    expect(app.matrixChanges).toBe(0);
    app.setCell('pub/a', 'value', 2);
    expect(app.matrixChanges).toBe(1);
  });

  it('keeps the draft when it is opened a second time, and says the figures are pending until they come', async () => {
    const { app } = await started([planned('pub/a')]);
    app.openMatrix();
    await vi.waitFor(() => expect(app.matrixPending).toBe(false));
    app.setCell('pub/a', 'value', 2);
    expect(app.matrixPending).toBe(true);
    app.openMatrix();
    expect(app.matrixDraft).toEqual({ 'pub/a': { value: 2, etag: 'e-pub/a' } });
    await vi.waitFor(() => expect(app.matrixPending).toBe(false));
  });

  it('tells when the matrix holds fewer tasks than were asked for', async () => {
    const many = Array.from({ length: 105 }, (_, i) => planned(`pub/t${i}`));
    const { app } = await started(many);
    app.openMatrix();
    expect(app.matrix?.ids).toHaveLength(100);
    expect(app.toast?.text).toMatch(/100\D+105/);
  });

  it('keeps the selection the person made during the write of the inbox', async () => {
    const { app, hub } = await started([planned('pub/a', { prio: 1, effort: 'S' }), planned('pub/b'), planned('pub/c')]);
    app.setView('inbox');
    expect(app.selectedId).toBe('pub/a');
    const ops = hub.ops.bind(hub);
    hub.ops = async (request) => {
      const result = await ops(request);
      hub.doc = snapshot([planned('pub/a', { prio: 1, effort: 'S', actor: 'me', actor_written: true }), planned('pub/b'), planned('pub/c')], 'rev:2');
      // The person clicks another row while the write is under way.
      app.select('pub/c');
      return result;
    };
    await app.triage('m', false);
    expect(app.selectedId).toBe('pub/c');
  });

  it('puts the selection on a row of the inbox when the selected task is not in it', async () => {
    const { app } = await started([planned('pub/a', { prio: 1, effort: 'S', actor: 'me', actor_written: true }), planned('pub/b')]);
    app.select('pub/a');
    app.setView('inbox');
    expect(app.selectedId).toBe('pub/b');
  });

  it('forgets the graph, the matrix and the check when the session is lost', async () => {
    const { app, hub } = await started([planned('pub/a')]);
    app.openGraph('pub/a');
    app.openMatrix();
    hub.checkAnswers = [{ state: 'running', id: 1 }];
    await app.openChecks();
    expect(app.graph).not.toBeNull();
    hub.onUnauthorized();
    expect(app.graph).toBeNull();
    expect(app.matrix).toBeNull();
    expect(app.checking).toBe(false);
    expect(app.checkJob).toBeNull();
  });

  it('shows no list of a graph that could not be read again', async () => {
    const { app, hub } = await started([planned('pub/a')]);
    app.openGraph('pub/a');
    await vi.waitFor(() => expect(app.graphDoc).not.toBeNull());
    hub.graphError = new ApiError(404, 'not_found', 'no such open task: pub/a');
    hub.doc = snapshot([planned('pub/a'), planned('pub/z')], 'rev:2');
    await app.refresh();
    app.reloadGraph();
    await vi.waitFor(() => expect(app.graphProblem).toBe('no such open task: pub/a'));
    expect(app.graphDoc).toBeNull();
  });

  it('asks for the state of a running check again after one ask failed, and lets the person run it', async () => {
    vi.useFakeTimers();
    try {
      const { app, hub } = await started([planned('pub/a')]);
      hub.checkAnswers = [{ state: 'running', id: 1 }];
      await app.openChecks();
      expect(app.checkJob?.state).toBe('running');
      hub.checkError = new ApiError(503, 'busy', 'the engine queue is full');
      await vi.advanceTimersByTimeAsync(1000);
      expect(app.checkProblem).toBe('the engine queue is full');
      // The job may still run: it is asked again a little later, and now the answer comes.
      hub.checkError = null;
      hub.checkAnswers = [{ state: 'running', id: 1 }];
      await vi.advanceTimersByTimeAsync(3000);
      expect(app.checkProblem).toBeNull();
      expect(app.checkJob?.state).toBe('running');
    } finally {
      vi.useRealTimers();
    }
  });

  it('leaves no timer of the check behind when the app is stopped while an ask is out', async () => {
    vi.useFakeTimers();
    try {
      const { app, hub } = await started([planned('pub/a')]);
      let release!: () => void;
      const held = new Promise<void>((resolve) => (release = resolve));
      const state = hub.checkState.bind(hub);
      hub.checkState = async () => {
        await held;
        return state();
      };
      hub.checkAnswers = [{ state: 'running', id: 1 }];
      const opening = app.openChecks();
      app.stop();
      release();
      await opening;
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('what the second review of the matrix, the inbox and the graph found', () => {
  const planned = (id: string, extra: Partial<TaskEntry> = {}) => task(id, { etag: `e-${id}`, ...extra });
  const done = { prio: 1, effort: 'S' } as Partial<TaskEntry>;
  async function started(tasks: TaskEntry[]) {
    const m = make({ token: 't' });
    m.hub.doc = snapshot(tasks);
    await m.app.start(null);
    m.app.stop();
    return m;
  }

  it('keeps the selection of the write at its place when the effect of the view fires during the write', async () => {
    const { app, hub } = await started([planned('pub/x0'), planned('pub/x1', done), planned('pub/x2'), planned('pub/x3')]);
    app.setView('inbox');
    app.select('pub/x1');
    const ops = hub.ops.bind(hub);
    hub.ops = async (request) => {
      const result = await ops(request);
      hub.doc = snapshot(
        [planned('pub/x0'), planned('pub/x1', { ...done, actor: 'me', actor_written: true }), planned('pub/x2'), planned('pub/x3')],
        'rev:2',
      );
      await app.refresh();
      // The rows changed under the write: the effect of the view runs now, before the write has returned.
      app.ensureInboxSelection();
      return result;
    };
    await app.triage('m', false);
    expect(app.selectedId).toBe('pub/x2');
  });

  it('leaves a selection of none alone when the rows change, and fixes one that points at a task that left', async () => {
    const { app, hub } = await started([planned('pub/a'), planned('pub/b')]);
    app.setView('inbox');
    app.select(null);
    hub.doc = snapshot([planned('pub/a'), planned('pub/b'), planned('pub/c')], 'rev:2');
    await app.refresh();
    app.ensureInboxSelection();
    expect(app.selectedId).toBeNull();
    // Entering the view puts it on the first row.
    app.ensureInboxSelection(true);
    expect(app.selectedId).toBe('pub/a');
    // The selected task is sorted elsewhere: the selection moves to a row.
    hub.doc = snapshot([planned('pub/a', { ...done, actor: 'me', actor_written: true }), planned('pub/b'), planned('pub/c')], 'rev:3');
    await app.refresh();
    app.ensureInboxSelection();
    expect(app.selectedId).toBe('pub/b');
  });

  it('writes a cell that stayed after a conflict with the version of the file that is current then', async () => {
    const { app, hub } = await started([planned('pub/a')]);
    app.openMatrix();
    app.setCell('pub/a', 'value', 4);
    hub.next_ops = {
      kind: 'tasks.result',
      ok: false,
      dry_run: false,
      results: [{ n: 1, op: 'set', id: 'pub/a', ok: false, error: { code: 'conflict', message: 'changed meanwhile', retryable: false } }],
    } as unknown as Result;
    await app.applyMatrix();
    expect(hub.sent[0]?.ops[0]).toMatchObject({ if_match: 'e-pub/a' });
    expect(app.matrixDraft).toEqual({ 'pub/a': { value: 4 } });
    // The list is read again with the new version of the file; the second Apply is written with that.
    hub.doc = snapshot([planned('pub/a', { etag: 'e-new' })], 'rev:2');
    await app.refresh();
    await app.applyMatrix();
    expect(hub.sent[1]?.ops[0]).toMatchObject({ patch: { value: 4 }, if_match: 'e-new' });
  });

  it('asks for the graph again only when the vault changed since it was asked for', async () => {
    const { app, hub } = await started([planned('pub/a')]);
    app.openGraph('pub/a');
    await vi.waitFor(() => expect(app.graphDoc).not.toBeNull());
    app.reloadGraph();
    app.reloadGraph();
    expect(hub.graphs).toHaveLength(1);
    // The view is left and entered again, the vault changed meanwhile: the first call asks.
    hub.doc = snapshot([planned('pub/a'), planned('pub/b')], 'rev:2');
    await app.refresh();
    app.reloadGraph();
    await vi.waitFor(() => expect(hub.graphs).toHaveLength(2));
    await vi.waitFor(() => expect(app.graphDoc).not.toBeNull());
    app.reloadGraph();
    expect(hub.graphs).toHaveLength(2);
  });
});

describe('the order of the tiles of the overview', () => {
  it('is remembered, taken from a damaged memory as the standard, and reset', async () => {
    const { app, prefs } = make({ token: 't' });
    app.moveTile('cdx', 'next', false, ['next', 'waiting', 'remind', 'cdx']);
    expect(app.tileOrder).toEqual(['cdx', 'next', 'waiting', 'remind']);
    expect(app.tileOrderChanged).toBe(true);
    expect(app.tileNote).toBe('Eine KI-Sitzung könnte übernehmen ist jetzt Nummer 1 von 4');
    expect(prefs.get('tasks-desktop.tiles-order')).toBe('["cdx","next","waiting","remind"]');
    app.resetTileOrder();
    expect(app.tileOrder).toEqual(['next', 'waiting', 'remind', 'cdx']);
    expect(app.tileOrderChanged).toBe(false);

    const kept = make({ token: 't', prefs: new Map([['tasks-desktop.tiles-order', '["waiting","x","waiting"]']]) });
    expect(kept.app.tileOrder).toEqual(['waiting', 'next', 'remind', 'cdx']);
    const broken = make({ token: 't', prefs: new Map([['tasks-desktop.tiles-order', '{']]) });
    expect(broken.app.tileOrder).toEqual(['next', 'waiting', 'remind', 'cdx']);
  });
});

describe('the Info dialog', () => {
  async function ready() {
    const m = make({ token: 't' });
    await m.app.start(null);
    expect(m.app.phase).toBe('ready');
    m.app.stop();
    return m;
  }

  it('shows the words of the hub, with the focus the person came for, and says why when the hub did not answer', async () => {
    const { app, hub } = await ready();
    app.openAbout('report');
    expect(app.about).toEqual({ state: 'loading', focus: 'report' });
    await vi.waitFor(() => expect(app.about.state).toBe('ok'));
    expect(app.about).toMatchObject({ state: 'ok', focus: 'report', doc: { engine: { git: 'abc1234' } } });
    expect(hub.aboutCalls).toBe(1);
    hub.hubDown = true;
    app.openAbout();
    await vi.waitFor(() => expect(app.about.state).toBe('failed'));
    expect(app.about).toEqual({ state: 'failed', message: 'down' });
  });

  it('throws an answer away that belongs to an opening that was closed, and an older one never wins', async () => {
    const { app, hub } = await ready();
    let releaseA = (): void => undefined;
    let releaseB = (): void => undefined;
    hub.aboutGates = [new Promise<void>((r) => (releaseA = r)), new Promise<void>((r) => (releaseB = r))];
    app.openAbout('report');
    app.closeAbout();
    expect(app.about).toEqual({ state: 'closed' });
    releaseA();
    await new Promise((r) => setTimeout(r, 0));
    // The first answer came after the dialog was closed: it does not open it again.
    expect(app.about).toEqual({ state: 'closed' });
    hub.aboutGates = [new Promise<void>((r) => (releaseA = r)), new Promise<void>((r) => (releaseB = r))];
    app.openAbout('report');
    app.closeAbout();
    app.openAbout('info');
    releaseA();
    await new Promise((r) => setTimeout(r, 0));
    // The answer of the first opening arrived first: the second opening keeps waiting for its own.
    expect(app.about).toEqual({ state: 'loading', focus: 'info' });
    releaseB();
    await vi.waitFor(() => expect(app.about.state).toBe('ok'));
    expect(app.about).toMatchObject({ state: 'ok', focus: 'info' });
  });

  it('is there for the page whose engine is not, with the session of the tab, and not before the pairing', async () => {
    const m = make({ token: 't' });
    m.hub.engineReady = false;
    const started = m.app.start(null);
    await vi.waitFor(() => expect(m.app.phase).toBe('unavailable'));
    expect(m.app.canAbout).toBe(true);
    m.app.openAbout('report');
    await vi.waitFor(() => expect(m.app.about.state).toBe('ok'));
    expect(m.app.about).toMatchObject({ state: 'ok', focus: 'report', doc: { engine: null } });
    m.app.stop();
    m.hub.engineReady = true;
    await started;

    const unpaired = make();
    await unpaired.app.start(null);
    expect(unpaired.app.phase).toBe('needs_pairing');
    expect(unpaired.app.canAbout).toBe(false);
    unpaired.app.openAbout();
    expect(unpaired.app.about).toEqual({ state: 'closed' });
    unpaired.app.stop();
  });
});

describe('the filter outlives a reload and holds in every view', () => {
  it('is not taken over from another vault, and an older memory becomes one of the vault that is read', async () => {
    // Made in "native" (chosen in another tab, or in the settings of the hub); the hub reads "main" now.
    const other = new Map([['tasks-desktop.filter', JSON.stringify({ areas: ['only-in-native'], vault: 'native' })]]);
    const a = make({ token: 't', prefs: other });
    expect(a.app.filter.areas).toEqual(['only-in-native']);
    await a.app.start(null);
    a.app.stop();
    await vi.waitFor(() => expect(a.app.vaultList).not.toBeNull());
    expect(a.app.filter.areas).toEqual([]);
    // What is saved is left alone: it may be the filter another tab made for "native" a moment ago.
    expect(JSON.parse(other.get('tasks-desktop.filter') ?? '{}')).toMatchObject({ areas: ['only-in-native'], vault: 'native' });

    // An older memory names no vault: it is kept, and is now the filter of "main".
    const older = new Map([['tasks-desktop.filter', JSON.stringify({ areas: ['kept'] })]]);
    const b = make({ token: 't', prefs: older });
    await b.app.start(null);
    b.app.stop();
    await vi.waitFor(() => expect(b.app.vaultList).not.toBeNull());
    expect(b.app.filter.areas).toEqual(['kept']);
    expect(JSON.parse(older.get('tasks-desktop.filter') ?? '{}')).toMatchObject({ areas: ['kept'], vault: 'main' });

    // The filter of the vault that is read stays.
    const same = new Map([['tasks-desktop.filter', JSON.stringify({ areas: ['mine'], vault: 'main' })]]);
    const c = make({ token: 't', prefs: same });
    await c.app.start(null);
    c.app.stop();
    await vi.waitFor(() => expect(c.app.vaultList).not.toBeNull());
    expect(c.app.filter.areas).toEqual(['mine']);
  });

  it('puts no list on the page before the hub has named its vault when the memory names another one', async () => {
    // Red before the fix: the list was drawn at once and the filter of the other vault was put on its tasks ("0 of N")
    // until the vault was named a moment later.
    const prefs = new Map([['tasks-desktop.filter', JSON.stringify({ areas: ['only-in-native'], vault: 'native' })]]);
    const m = make({ token: 't', prefs });
    let release!: () => void;
    m.hub.holdVaults = new Promise<void>((resolve) => (release = resolve));
    const starting = m.app.start(null);
    await vi.waitFor(() => expect(m.hub.snapshotCalls.length).toBeGreaterThan(0));
    await vi.waitFor(() => expect(m.hub.vaultsCalls).toBeGreaterThan(0));
    expect(m.app.tasks).toEqual([]);
    release();
    await starting;
    m.app.stop();
    expect(m.app.filter.areas).toEqual([]);
    expect(m.app.shown.map((t) => t.id)).toEqual(['pub/a']);
  });

  it('keeps the remembered filter when the hub has no list of vaults to name one', async () => {
    const prefs = new Map([['tasks-desktop.filter', JSON.stringify({ areas: ['mine'], vault: 'main' })]]);
    const m = make({ token: 't', prefs });
    m.hub.vaultDoc = null;
    await m.app.start(null);
    m.app.stop();
    await vi.waitFor(() => expect(m.hub.vaultsCalls).toBeGreaterThan(0));
    expect(m.app.filter.areas).toEqual(['mine']);
  });

  it('does not take the filter over from a stale tab either: a page that learns of another vault empties its own filter and the words', async () => {
    const m = make({ token: 't' });
    await m.app.start(null);
    m.app.stop();
    await vi.waitFor(() => expect(m.app.vaultList?.active).toBe('main'));
    m.app.filter = { ...m.app.filter, areas: ['of-main'] };
    m.app.setQuery('words');
    // The hub reads "native" now (chosen in another tab); the other tab saved a filter for it.
    const saved = JSON.stringify({ areas: ['of-native'], vault: 'native' });
    m.prefs.set('tasks-desktop.filter', saved);
    m.hub.vaultDoc = { ...(m.hub.vaultDoc as VaultList), active: 'native' };
    await m.app.loadVaults();
    expect(m.app.filter.areas).toEqual([]);
    expect(m.app.filter.query).toBe('');
    // Nothing of the other tab's filter was overwritten.
    expect(m.prefs.get('tasks-desktop.filter')).toBe(saved);
  });

  it('is remembered without the search words, and read back from the prefs', async () => {
    const { app, prefs } = make({ token: 't' });
    app.filter = { ...app.filter, statuses: ['doing'], ranges: { prio: { max: { label: '2', n: 2 } } } };
    app.setQuery('hello');
    expect(JSON.parse(prefs.get('tasks-desktop.filter') ?? '{}')).toMatchObject({
      statuses: ['doing'],
      ranges: { prio: { max: { label: '2', n: 2 } } },
    });
    expect(prefs.get('tasks-desktop.filter')).not.toContain('hello');
    const again = make({ token: 't', prefs });
    expect(again.app.filter.statuses).toEqual(['doing']);
    expect(again.app.filter.ranges.prio?.max?.n).toBe(2);
    expect(again.app.filter.query).toBe('');
    again.app.resetFilter();
    expect(JSON.parse(prefs.get('tasks-desktop.filter') ?? '{}').statuses).toEqual([]);
  });

  it('narrows the inbox as it narrows the list', async () => {
    const m = make({ token: 't' });
    m.hub.doc = snapshot([
      task('pub/a', { prio: 1, effort: 'S', actor: 'me', actor_written: true }),
      task('pub/b', { prio: 3 }),
      task('pub/c', { prio: 2 }),
    ]);
    await m.app.start(null);
    m.app.stop();
    expect(m.app.inbox.map((t) => t.id)).toEqual(['pub/b', 'pub/c']);
    m.app.filter = { ...m.app.filter, ranges: { prio: { min: { label: '3', n: 3 } } } };
    expect(m.app.inbox.map((t) => t.id)).toEqual(['pub/b']);
  });
});

describe('the order of the list', () => {
  const three = [task('pub/a'), task('pub/b'), task('pub/c')];

  it('shows the plan order until another is chosen, then the order of the engine, and remembers the choice', async () => {
    const m = make({ token: 't' });
    m.hub.doc = snapshot(three);
    m.hub.orders.set('roi', ['pub/c', 'pub/a', 'pub/b']);
    await m.app.start(null);
    expect(m.app.shown.map((t) => t.id)).toEqual(['pub/a', 'pub/b', 'pub/c']);
    m.app.setSort('roi');
    await vi.waitFor(() => expect(m.app.shown.map((t) => t.id)).toEqual(['pub/c', 'pub/a', 'pub/b']));
    expect(m.prefs.get('tasks-desktop.sort')).toBe('roi');
    m.app.setSort('default');
    expect(m.app.shown.map((t) => t.id)).toEqual(['pub/a', 'pub/b', 'pub/c']);
    m.app.stop();
  });

  it('takes the remembered order when the list arrives', async () => {
    const prefs = new Map([['tasks-desktop.sort', 'severity']]);
    const m = make({ token: 't', prefs });
    m.hub.doc = snapshot(three);
    m.hub.orders.set('severity', ['pub/b', 'pub/c', 'pub/a']);
    await m.app.start(null);
    await vi.waitFor(() => expect(m.app.shown.map((t) => t.id)).toEqual(['pub/b', 'pub/c', 'pub/a']));
    m.app.stop();
  });

  it('goes back to the plan order, and says so, when the engine refuses the word', async () => {
    const m = make({ token: 't' });
    m.hub.doc = snapshot(three);
    await m.app.start(null);
    m.app.setSort('frecency');
    await vi.waitFor(() => expect(m.app.sort).toBe('default'));
    expect(m.app.shown.map((t) => t.id)).toEqual(['pub/a', 'pub/b', 'pub/c']);
    expect(m.prefs.get('tasks-desktop.sort')).toBe('default');
    m.app.stop();
  });

  describe('the ranges of the fields', () => {
    it('are asked once and replace the defaults the form starts with', async () => {
      const m = make({ token: 't' });
      m.hub.doc = snapshot([task('pub/a')]);
      m.hub.enumsDoc = { kind: ['feature', 'novelty'], effort: ['S', 'M', '<n>d'], value: [1, 2] };
      expect(m.app.ranges.kinds).toContain('research');
      await m.app.start(null);
      await vi.waitFor(() => expect(m.app.ranges.kinds).toEqual(['feature', 'novelty']));
      expect(m.app.ranges.efforts).toEqual(['S', 'M']);
      expect(m.app.ranges.values).toEqual([1, 2]);
      await m.app.refresh();
      await m.app.refresh();
      expect(m.hub.enumsCalls).toBe(1);
      m.app.stop();
    });

    it('a status, a priority and a who the engine names are offered, a word without a text as it is', async () => {
      const m = make({ token: 't' });
      m.hub.doc = snapshot([task('pub/a', { status: 'open', etag: 'e1' })]);
      m.hub.enumsDoc = { status: ['open', 'doing', 'review'], prio: [1, 2, 3, 4], actor: ['me', 'bot'] };
      await m.app.start(null);
      await vi.waitFor(() => expect(m.app.ranges.statuses).toContain('review'));
      m.app.select('pub/a');
      const actions = paletteActions(m.app);
      const review = actions.find((a) => a.key === 'task.status.review');
      // No text for `review`: the word of the engine, never an empty place.
      expect(review?.label).toBe(translate(m.app.lang, 'palette.status', { status: 'review' }));
      expect(actions.some((a) => a.key === 'task.prio.4')).toBe(true);
      // The statuses the engine does not name are not offered (parked is a default of the page only).
      expect(actions.some((a) => a.key === 'task.status.parked')).toBe(false);
      // A status that is no column of the board is a field: one set, not a drop.
      await review?.run();
      await vi.waitFor(() => expect(m.hub.sent.at(-1)?.ops[0]).toMatchObject({ op: 'set', id: 'pub/a', patch: { status: 'review' } }));
      expect(m.app.ranges.actors).toEqual(['me', 'bot']);
      m.app.stop();
    });

    it('stay the defaults when the hub or the engine cannot say', async () => {
      const m = make({ token: 't' });
      m.hub.doc = snapshot([task('pub/a')]);
      await m.app.start(null);
      await vi.waitFor(() => expect(m.hub.enumsCalls).toBe(1));
      expect(m.app.ranges.kinds).toContain('research');
      expect(m.app.ranges.values).toEqual([1, 2, 3, 4, 5]);
      m.app.stop();
    });
  });

  describe('the lists of the engine', () => {
    const three = [task('pub/a', { status: 'open' }), task('pub/b', { status: 'doing' }), task('pub/c', { status: 'doing' })];
    const doc = (lists: unknown[]) => ({ kind: 'tasks.lists', lists, notes: [] });
    const entry = (name: string, options: Record<string, unknown>) => ({ name, source: 'saved', summary: name, options });

    it('asks once and shows what the engine has, next to the lists of the page', async () => {
      const m = make({ token: 't' });
      m.hub.capabilities = ['lists'];
      m.hub.doc = snapshot(three);
      m.hub.engineListDoc = doc([entry('E1', { status: 'doing' })]);
      await m.app.start(null);
      await vi.waitFor(() => expect(m.app.engineLists.map((l) => l.name)).toEqual(['E1']));
      await m.app.refresh();
      await m.app.refresh();
      expect(m.hub.listsCalls).toBe(1);
      m.app.stop();
    });

    it('applies the filter and the order, keeps the search words, and tells what it could not say', async () => {
      const m = make({ token: 't' });
      m.hub.capabilities = ['lists'];
      m.hub.doc = snapshot(three);
      m.hub.orders.set('roi', ['pub/c', 'pub/b', 'pub/a']);
      m.hub.engineListDoc = doc([entry('E1', { status: 'doing', sort: 'roi', stale: '30' })]);
      await m.app.start(null);
      await vi.waitFor(() => expect(m.app.engineLists).toHaveLength(1));
      m.app.filter = { ...m.app.filter, query: 'typed' };
      m.app.applyEngineList('E1');
      expect(m.app.filter.statuses).toEqual(['doing']);
      expect(m.app.filter.query).toBe('typed');
      expect(m.app.sort).toBe('roi');
      expect(m.app.toast).toMatchObject({ kind: 'error' });
      expect(m.app.toast?.text).toContain('stale: 30');
      // It is not one of the page's lists: nothing is saved by it.
      expect(m.app.lists).toEqual([]);
      m.app.stop();
    });

    it('applies readiness and a quick win as the engine means them, with the quick wins of the snapshot', async () => {
      const m = make({ token: 't' });
      m.hub.capabilities = ['lists'];
      const withEstimate = snapshot(three);
      (withEstimate as unknown as { estimate: { quick_wins: string[] } }).estimate = { quick_wins: ['pub/b'] };
      m.hub.doc = withEstimate;
      m.hub.engineListDoc = doc([
        entry('QW', { quick_win: true, readiness: 'ready' }),
      ]);
      await m.app.start(null);
      await vi.waitFor(() => expect(m.app.engineLists).toHaveLength(1));
      m.app.applyEngineList('QW');
      expect(m.app.toast).toBeNull();
      expect(m.app.filter.quickWin).toBe(true);
      expect(m.app.filter.fields.state).toEqual(['ready', 'decision']);
      // Only what the engine counted as a quick win is shown (and is in one of the states).
      expect(m.app.shown.map((t) => t.id)).toEqual([]);
      m.app.filter = { ...m.app.filter, fields: {} };
      expect(m.app.shown.map((t) => t.id)).toEqual(['pub/b']);
      m.app.stop();
    });

    it('names a quick win when the snapshot has no figure of the engine for it', async () => {
      const m = make({ token: 't' });
      m.hub.capabilities = ['lists'];
      m.hub.doc = snapshot(three);
      m.hub.engineListDoc = doc([entry('QW', { quick_win: true })]);
      await m.app.start(null);
      await vi.waitFor(() => expect(m.app.engineLists).toHaveLength(1));
      m.app.applyEngineList('QW');
      expect(m.app.filter.quickWin).toBe(false);
      expect(m.app.toast?.text).toContain('quick_win');
      m.app.stop();
    });

    it('shows none, quietly, when the hub or the engine has no lists', async () => {
      const m = make({ token: 't' });
      m.hub.capabilities = ['lists'];
      m.hub.doc = snapshot(three);
      await m.app.start(null);
      await vi.waitFor(() => expect(m.hub.listsCalls).toBe(1));
      expect(m.app.engineLists).toEqual([]);
      m.app.applyEngineList('nothing');
      expect(m.app.toast).toBeNull();
      m.app.stop();
      const without = make({ token: 't' });
      without.hub.capabilities = ['reorder'];
      without.hub.doc = snapshot(three);
      without.hub.engineListDoc = doc([entry('E1', {})]);
      await without.app.start(null);
      expect(without.hub.listsCalls).toBe(0);
      without.app.stop();
    });
  });

  describe('named lists', () => {
    const three = [task('pub/a', { status: 'open' }), task('pub/b', { status: 'doing' }), task('pub/c', { status: 'doing' })];

    it('keeps the filter and the order under a name, shows them again later, and remembers them across a reload', async () => {
      const prefs = new Map<string, string>();
      const m = make({ token: 't', prefs });
      m.hub.doc = snapshot(three);
      m.hub.orders.set('roi', ['pub/c', 'pub/b', 'pub/a']);
      await m.app.start(null);
      m.app.filter = { ...m.app.filter, statuses: ['doing'], query: 'not kept' };
      m.app.setSort('roi');
      expect(m.app.saveList('  Doing   by return ')).toBe('saved');
      expect(m.app.lists.map((l) => l.name)).toEqual(['Doing by return']);
      expect(m.app.shownList?.name).toBe('Doing by return');
      // Another filter and the plan order, then the list brings both back (the words in the search box stay).
      m.app.filter = { ...m.app.filter, statuses: [], query: 'typed' };
      m.app.setSort('default');
      expect(m.app.shownList).toBeUndefined();
      m.app.applyList('Doing by return');
      expect(m.app.filter.statuses).toEqual(['doing']);
      expect(m.app.filter.query).toBe('typed');
      expect(m.app.sort).toBe('roi');
      m.app.stop();
      // A new page reads the memory.
      const again = make({ token: 't', prefs });
      again.hub.doc = snapshot(three);
      await again.app.start(null);
      expect(again.app.lists.map((l) => l.name)).toEqual(['Doing by return']);
      again.app.stop();
    });

    it('keeps nothing before the hub has named its vault, and keeps it under the name after', async () => {
      const prefs = new Map<string, string>();
      const m = make({ token: 't', prefs });
      m.hub.doc = snapshot(three);
      m.hub.vaultDoc = { active: 'work', vaults: [{ name: 'work', label: 'work', main: true }] };
      // The page has not started: the vault is not known.
      expect(m.app.saveList('Early')).toBe('wait');
      expect(m.app.toast).toMatchObject({ kind: 'error' });
      expect(prefs.get('tasks-desktop.lists')).toBeUndefined();
      await m.app.start(null);
      expect(m.app.saveList('Later')).toBe('saved');
      expect(JSON.parse(prefs.get('tasks-desktop.lists') ?? '{}')).toHaveProperty('work');
      expect(JSON.parse(prefs.get('tasks-desktop.lists') ?? '{}')['']).toBeUndefined();
      m.app.stop();
    });

    it('says that the hub does not answer for the vaults, keeps nothing, and keeps the list once it does', async () => {
      const prefs = new Map<string, string>();
      const m = make({ token: 't', prefs });
      m.hub.doc = snapshot(three);
      m.hub.vaultsFailWith = 500;
      m.hub.vaultDoc = { active: 'work', vaults: [{ name: 'work', label: 'work', main: true }] };
      await m.app.start(null);
      expect(m.app.vaultsFailed).toBe(true);
      expect(m.app.saveList('Early')).toBe('wait');
      expect(m.app.toast?.text).toBe(translate(m.app.lang, 'lists.wait_failed'));
      expect(prefs.get('tasks-desktop.lists')).toBeUndefined();
      // The hub recovers: the next read asks again and the vault is known.
      m.hub.vaultsFailWith = null;
      m.hub.doc = snapshot(three, 'rev:2');
      await m.app.refresh();
      expect(m.app.vaultsFailed).toBe(false);
      expect(m.app.saveList('Later')).toBe('saved');
      expect(JSON.parse(prefs.get('tasks-desktop.lists') ?? '{}')).toHaveProperty('work');
      m.app.stop();
    });

    it('refuses a name it cannot keep, and says so', async () => {
      const m = make({ token: 't' });
      m.hub.capabilities = ['lists'];
      m.hub.doc = snapshot(three);
      await m.app.start(null);
      expect(m.app.saveList('   ')).toBe('bad_name');
      expect(m.app.toast).toMatchObject({ kind: 'error' });
      expect(m.app.lists).toEqual([]);
      m.app.stop();
    });

    it('forgets a list when it is deleted, and leaves the others', async () => {
      const prefs = new Map<string, string>();
      const m = make({ token: 't', prefs });
      m.hub.doc = snapshot(three);
      await m.app.start(null);
      m.app.saveList('One');
      m.app.filter = { ...m.app.filter, statuses: ['open'] };
      m.app.saveList('Two');
      m.app.deleteList('One');
      expect(m.app.lists.map((l) => l.name)).toEqual(['Two']);
      m.app.deleteList('Two');
      expect(prefs.get('tasks-desktop.lists')).toBe('{}');
      m.app.deleteList('nothing');
      m.app.stop();
    });

    it('keeps the lists of one vault out of another', async () => {
      const prefs = new Map<string, string>([
        ['tasks-desktop.lists', JSON.stringify({ work: [{ name: 'Work only', filter: '{}', sort: 'default' }] })],
      ]);
      const m = make({ token: 't', prefs });
      m.hub.doc = snapshot(three);
      m.hub.vaultDoc = { active: 'home', vaults: [{ name: 'home', label: 'home', main: true }] };
      await m.app.start(null);
      expect(m.app.lists).toEqual([]);
      m.app.stop();
      const work = make({ token: 't', prefs });
      work.hub.doc = snapshot(three);
      work.hub.vaultDoc = { active: 'work', vaults: [{ name: 'work', label: 'work', main: true }] };
      await work.app.start(null);
      expect(work.app.lists.map((l) => l.name)).toEqual(['Work only']);
      work.app.stop();
    });
  });

  describe('the lists in the palette', () => {
    it('offers one entry for each list, the own ones and the ones of the engine, and applies them', async () => {
      const m = make({ token: 't' });
      m.hub.capabilities = ['lists'];
      m.hub.doc = snapshot([task('pub/a', { status: 'open' }), task('pub/b', { status: 'doing' })]);
      m.hub.engineListDoc = {
        kind: 'tasks.lists',
        notes: [],
        lists: [{ name: 'E1', source: 'builtin', summary: 'E1 summary', options: { status: 'doing' } }],
      };
      await m.app.start(null);
      await vi.waitFor(() => expect(m.app.engineLists).toHaveLength(1));
      m.app.filter = { ...m.app.filter, statuses: ['open'] };
      m.app.saveList('Mine');
      m.app.resetFilter();
      const actions = paletteActions(m.app);
      const own = actions.find((a) => a.key === 'list.mine.Mine');
      const engine = actions.find((a) => a.key === 'list.engine.E1');
      expect(own?.label).toBe(translate(m.app.lang, 'palette.list', { name: 'Mine' }));
      expect(engine?.label).toBe(translate(m.app.lang, 'palette.list_engine', { name: 'E1' }));
      expect(engine?.hint).toBe('E1 summary');
      await own?.run();
      expect(m.app.filter.statuses).toEqual(['open']);
      expect(m.app.view).toBe('list');
      m.app.setView('today');
      await engine?.run();
      expect(m.app.filter.statuses).toEqual(['doing']);
      expect(m.app.view).toBe('list');
      m.app.stop();
    });

    it('offers none when there are no lists', async () => {
      const m = make({ token: 't' });
      m.hub.doc = snapshot([task('pub/a')]);
      await m.app.start(null);
      expect(paletteActions(m.app).some((a) => a.key.startsWith('list.'))).toBe(false);
      m.app.stop();
    });
  });
});

describe('the saved views', () => {
  const view = (id: string, extra: Partial<View> = {}): View =>
    ({
      id,
      area: id.split('/')[0]!,
      title: `View ${id}`,
      display: 'columns',
      group_by: 'status',
      collapsed: [],
      select: emptySelect(),
      etag: `etag-${id}`,
      ...extra,
    }) as View;
  const made = (caps: string[] = ['views', 'groupings'], prefs?: Map<string, string>) => {
    const m = make({ token: 't', ...(prefs ? { prefs } : {}) });
    m.hub.capabilities = [...m.hub.capabilities!, ...caps];
    m.hub.doc = snapshot([task('pub/a', { status: 'open', etag: 'e1' }), task('pub/b', { status: 'doing', tags: ['ui'] })]);
    return m;
  };
  const last = (m: ReturnType<typeof make>) => m.hub.sent.at(-1)!.ops;
  const form = (): ViewForm => ({ title: 'Mine', display: 'columns', group_by: 'status', collapsed: [], select: emptySelect() });

  /** A view opened in its tab, with the groupings it is drawn with read. */
  async function opened(m: ReturnType<typeof made>, id: string) {
    await m.app.start(null);
    await vi.waitFor(() => expect(m.app.viewsState.list.some((v) => v.id === id)).toBe(true));
    m.app.openView(id);
    await vi.waitFor(() => expect(m.app.viewsState.groupingsShown).not.toBeNull());
    // The classes of the areas come a moment after the list.
    await new Promise((r) => setTimeout(r, 10));
  }

  it('export their groups, as the view draws them, the group of no value named', async () => {
    const m = made();
    m.hub.viewList = [view('pub/mine', { group_by: 'tags' })];
    await opened(m, 'pub/mine');
    const { view: name, rows } = m.app.exportRows();
    expect(name).toBe('view-mine');
    expect(rows.map((r) => `${r.group} ${r.task.id}`)).toEqual(['ui pub/b', `${translate('de', 'views.none')} pub/a`]);
    m.app.stop();
  });

  it('export a matrix cell by cell, the column as the group and the row beside it', async () => {
    const m = made();
    m.hub.viewList = [view('pub/grid', { display: 'matrix', group_by: 'status', group_by2: 'tags' })];
    await opened(m, 'pub/grid');
    const rows = m.app.exportRows().rows.map((r) => `${r.row} | ${r.group} | ${r.task.id}`);
    // The rows are the second field (tags), the columns the first (status): as the view draws them.
    expect(rows).toEqual(['ui | doing | pub/b', `${translate('de', 'views.none')} | open | pub/a`]);
    m.app.stop();
  });

  it('export nothing where the view draws only a note, and a view of a private area is not named', async () => {
    const m = made();
    m.hub.areaList = [
      { name: 'pub', data_class: 'public' },
      { name: 'priv', data_class: 'private' },
    ];
    m.hub.viewList = [view('pub/half', { display: 'matrix', group_by: 'status' }), view('priv/secret-view'), view('pub/odd', { group_by: 'nope' as View['group_by'] })];
    await opened(m, 'pub/half');
    expect(m.app.exportRows().rows).toEqual([]);
    m.app.openView('pub/odd');
    expect(m.app.exportRows().rows).toEqual([]);
    m.app.openView('priv/secret-view');
    const { view: name, rows } = m.app.exportRows();
    expect(name).toBe('view');
    expect(rows.length).toBeGreaterThan(0);
    m.app.stop();
  });

  it('are the only tab besides the list, the board and the plan with an export, and only with a view open', async () => {
    const m = made();
    await m.app.start(null);
    const exports = () => paletteActions(m.app).some((a) => a.key.startsWith('export.'));
    m.app.setView('today');
    expect([m.app.exportable, exports()]).toEqual([false, false]);
    m.app.setView('inbox');
    expect(m.app.exportable).toBe(false);
    m.app.setView('views');
    expect(m.app.exportable).toBe(false);
    for (const tab of ['list', 'board', 'plan'] as const) {
      m.app.setView(tab);
      expect([tab, m.app.exportable, exports()]).toEqual([tab, true, true]);
    }
    m.app.stop();
  });

  it('are forgotten when the session is lost', async () => {
    const m = made();
    m.hub.viewList = [view('pub/mine')];
    await m.app.start(null);
    await vi.waitFor(() => expect(m.app.viewsState.list.map((v) => v.id)).toEqual(['pub/mine']));
    m.hub.onUnauthorized();
    expect(m.app.viewsState.doc).toBeNull();
    expect(m.app.viewsState.groupings).toBeNull();
  });

  it('are read at the start, not again for a change of the tasks elsewhere, and on the tab when the vault changed', async () => {
    const m = made();
    m.hub.viewList = [view('pub/mine')];
    await m.app.start(null);
    await vi.waitFor(() => expect(m.app.viewsState.list.map((v) => v.id)).toEqual(['pub/mine']));
    m.hub.doc = { ...m.hub.doc, digest: 'other digest' } as Snapshot;
    await m.app.refresh();
    await m.app.refresh();
    expect(m.hub.viewsCalls).toBe(1);
    // A change of the tasks while another tab is shown: no read in front of the next write.
    m.hub.doc = snapshot(m.hub.doc.tasks, 'rev:2');
    await m.app.refresh();
    await new Promise((r) => setTimeout(r, 5));
    expect(m.hub.viewsCalls).toBe(1);
    // Entering the tab reads what changed meanwhile; on the tab a change of the vault reads them again.
    m.app.setView('views');
    await vi.waitFor(() => expect(m.hub.viewsCalls).toBe(2));
    m.app.setView('list');
    m.app.setView('views');
    expect(m.hub.viewsCalls).toBe(2);
    m.hub.doc = snapshot(m.hub.doc.tasks, 'rev:3');
    await m.app.refresh();
    await vi.waitFor(() => expect(m.hub.viewsCalls).toBe(3));
    m.app.stop();
  });

  it('are not asked of an engine that keeps none, and its tab is not there', async () => {
    const m = made([]);
    await m.app.start(null);
    m.app.setView('views');
    expect(m.app.view).not.toBe('views');
    await m.app.refresh();
    expect(m.hub.viewsCalls).toBe(0);
    expect(paletteActions(m.app).some((a) => a.key === 'go.views')).toBe(false);
    m.app.stop();
  });

  it('are drawn with the groupings of the state shown, asked once per state; an answer of a state gone by is not kept', async () => {
    const m = made();
    await m.app.start(null);
    m.app.setView('views');
    await vi.waitFor(() => expect(m.app.viewsState.groupingsNow?.rev).toBe('rev:1'));
    m.app.setView('list');
    m.app.setView('views');
    expect(m.hub.groupingsCalls).toBe(1);
    // The vault changed, and the engine answers for a state that is gone by already.
    m.hub.groupingsRev = 'rev:old';
    m.hub.doc = snapshot(m.hub.doc.tasks, 'rev:2');
    await m.app.refresh();
    await vi.waitFor(() => expect(m.hub.groupingsCalls).toBe(2));
    await new Promise((r) => setTimeout(r, 5));
    expect(m.app.viewsState.groupings?.rev).toBe('rev:1');
    expect(m.app.viewsState.groupingsNow).toBeNull();
    m.app.stop();
  });

  it('the first groupings are kept even for a state gone by: the board has the fields of its bar (not the current ones)', async () => {
    const m = made(['views', 'groupings', 'reorder']);
    await m.app.start(null);
    // The vault changes while the board asks (a view written elsewhere): the answer is for the state before.
    m.hub.groupingsRev = 'rev:old';
    m.app.setView('board');
    await vi.waitFor(() => expect(m.hub.groupingsCalls).toBe(1));
    await vi.waitFor(() => expect(m.app.viewsState.groupingsShown?.rev).toBe('rev:old'));
    expect(m.app.viewsState.groupingsNow).toBeNull();
    // The tab of the views asks again and takes the answer of the state shown.
    m.hub.groupingsRev = null;
    m.app.setView('views');
    await vi.waitFor(() => expect(m.app.viewsState.groupingsNow?.rev).toBe('rev:1'));
    m.app.stop();
  });

  it('ask for the groupings once while the answer is on its way', async () => {
    const m = made();
    await m.app.start(null);
    let release!: () => void;
    m.hub.groupingsHold = [new Promise<void>((r) => (release = r))];
    m.app.setView('views');
    m.app.setView('list');
    m.app.setView('views');
    expect(m.hub.groupingsCalls).toBe(1);
    release();
    await vi.waitFor(() => expect(m.app.viewsState.groupingsNow).not.toBeNull());
    m.app.stop();
  });

  it('a view made goes to its area and is the one shown; undo deletes it on the version made', async () => {
    const m = made();
    await m.app.start(null);
    await vi.waitFor(() => expect(m.app.hubAreas).toHaveLength(1));
    const before = m.hub.viewsCalls;
    m.hub.viewList = [view('pub/other'), view('pub/made-view')];
    expect(await m.app.viewsState.create('pub', form())).toBe(true);
    expect(last(m)).toEqual([{ op: 'view_save', area: 'pub', view: form() }]);
    // Read again after the write: the snapshot does not hold the views.
    expect(m.hub.viewsCalls).toBe(before + 1);
    expect(m.app.viewsState.open?.id).toBe('pub/made-view');
    expect(m.prefs.get('tasks-desktop.view-open')).toBe('pub/made-view');
    await m.app.undo();
    expect(last(m)).toEqual([{ op: 'view_delete', id: 'pub/made-view', if_match: 'v-made' }]);
    m.app.stop();
  });

  it('a view written here is read once after the write, and no other document is asked again (views_rev, not rev)', async () => {
    const m = made(['views', 'groupings', 'links']);
    m.hub.doc = { ...snapshot(m.hub.doc.tasks), views_rev: 'rev:aaaaa1', digest: 'd1' } as Snapshot;
    await m.app.start(null);
    m.app.setView('views');
    await vi.waitFor(() => expect(m.app.viewsState.groupingsNow).not.toBeNull());
    await vi.waitFor(() => expect(m.app.linksNow).not.toBeNull());
    const [views, links, groupings] = [m.hub.viewsCalls, m.hub.linksCalls, m.hub.groupingsCalls];
    // The engine writes the file: the snapshot after it has a new views_rev and digest, the same rev.
    const ops = m.hub.ops.bind(m.hub);
    m.hub.ops = async (request) => {
      m.hub.doc = { ...m.hub.doc, views_rev: 'rev:aaaaa2', digest: 'd2' } as Snapshot;
      return ops(request);
    };
    m.hub.viewList = [view('pub/made-view')];
    expect(await m.app.viewsState.create('pub', form())).toBe(true);
    await new Promise((r) => setTimeout(r, 10));
    expect(m.hub.viewsCalls).toBe(views + 1);
    expect([m.hub.linksCalls, m.hub.groupingsCalls]).toEqual([links, groupings]);
    m.app.stop();
  });

  it('a view written here is read after the write even when the snapshot does not show it yet, and not again on its event', async () => {
    const m = made(['views', 'groupings', 'links']);
    m.hub.doc = { ...snapshot(m.hub.doc.tasks), views_rev: 'rev:ccccc1', digest: 'd1' } as Snapshot;
    m.hub.viewsRev = 'rev:ccccc1';
    await m.app.start(null);
    m.app.setView('views');
    await vi.waitFor(() => expect(m.app.viewsState.groupingsNow).not.toBeNull());
    const views = m.hub.viewsCalls;
    // The engine wrote the file; the hub reads the vault again only on the event, after the answer.
    m.hub.viewList = [view('pub/made-view')];
    m.hub.viewsRev = 'rev:ccccc2';
    expect(await m.app.viewsState.create('pub', form())).toBe(true);
    expect(m.hub.viewsCalls).toBe(views + 1);
    expect(m.app.viewsState.list.map((v) => v.id)).toEqual(['pub/made-view']);
    // The event: the snapshot now names the views_rev the views were read at.
    m.hub.doc = { ...m.hub.doc, views_rev: 'rev:ccccc2', digest: 'd2' } as Snapshot;
    await m.app.refresh();
    await new Promise((r) => setTimeout(r, 10));
    expect(m.hub.viewsCalls).toBe(views + 1);
    m.app.stop();
  });

  it('a read of the views that failed (a busy engine) is asked again on the next read of the list', async () => {
    const m = made(['views', 'groupings']);
    m.hub.doc = { ...snapshot(m.hub.doc.tasks), views_rev: 'rev:ddddd1', digest: 'd1' } as Snapshot;
    m.hub.viewsFail = 1;
    // The start reads the views once (for the palette and the menu), and the engine is busy.
    await m.app.start(null);
    await vi.waitFor(() => expect(m.app.viewsState.failed).toBe(true));
    const views = m.hub.viewsCalls;
    m.hub.viewList = [view('pub/after-busy')];
    await m.app.refresh();
    await vi.waitFor(() => expect(m.app.viewsState.list.map((v) => v.id)).toEqual(['pub/after-busy']));
    expect(m.hub.viewsCalls).toBe(views + 1);
    m.app.stop();
  });

  it('a view changed outside (a new views_rev, the same rev) is read again while the views are shown, nothing else', async () => {
    const m = made(['views', 'groupings', 'links']);
    m.hub.doc = { ...snapshot(m.hub.doc.tasks), views_rev: 'rev:bbbbb1', digest: 'd1' } as Snapshot;
    await m.app.start(null);
    m.app.setView('views');
    await vi.waitFor(() => expect(m.app.viewsState.groupingsNow).not.toBeNull());
    await vi.waitFor(() => expect(m.app.linksNow).not.toBeNull());
    const [views, links, groupings] = [m.hub.viewsCalls, m.hub.linksCalls, m.hub.groupingsCalls];
    m.hub.viewList = [view('pub/pulled')];
    m.hub.doc = { ...m.hub.doc, views_rev: 'rev:bbbbb2', digest: 'd2' } as Snapshot;
    await m.app.refresh();
    await vi.waitFor(() => expect(m.app.viewsState.list.map((v) => v.id)).toEqual(['pub/pulled']));
    expect(m.hub.viewsCalls).toBe(views + 1);
    expect([m.hub.linksCalls, m.hub.groupingsCalls]).toEqual([links, groupings]);
    // A read of the list with nothing changed asks no view again.
    await m.app.refresh();
    await new Promise((r) => setTimeout(r, 10));
    expect(m.hub.viewsCalls).toBe(views + 1);
    m.app.stop();
  });

  it('an inverse delete of a view without the version it deletes offers no undo (the engine would refuse it)', async () => {
    const m = made();
    await m.app.start(null);
    await vi.waitFor(() => expect(m.app.hubAreas).toHaveLength(1));
    m.hub.viewList = [view('pub/made-view')];
    m.hub.next_ops = {
      kind: 'tasks.result',
      ok: true,
      dry_run: false,
      results: [
        { n: 1, op: 'view_save', id: 'pub/made-view', ok: true, outcome: 'created', changed_ids: [], inverse: { op: 'view_delete', id: 'pub/made-view' } },
      ],
    } as never;
    expect(await m.app.viewsState.create('pub', form())).toBe(true);
    expect(m.app.toast?.undo).toBeUndefined();
    const sent = m.hub.sent.length;
    await m.app.undo();
    expect(m.hub.sent.length).toBe(sent);
    m.app.stop();
  });

  it('a change is made on the version read, and undo saves the view as it was', async () => {
    const m = made();
    m.hub.viewList = [view('pub/mine')];
    await m.app.start(null);
    await vi.waitFor(() => expect(m.app.viewsState.open).not.toBeNull());
    const open = m.app.viewsState.open!;
    expect(await m.app.viewsState.save(open, { ...formOf(open), display: 'list' })).toBe(true);
    expect(last(m)).toEqual([{ op: 'view_save', id: 'pub/mine', view: { ...formOf(open), display: 'list' }, if_match: 'etag-pub/mine' }]);
    await m.app.undo();
    expect(last(m)).toEqual([
      { op: 'view_save', id: 'pub/mine', view: { title: 'Before', display: 'list', group_by: 'status' }, if_match: 'v-after' },
    ]);
    m.app.stop();
  });

  it('a view deleted on the version read comes back with undo', async () => {
    const m = made();
    m.hub.viewList = [view('pub/mine')];
    await m.app.start(null);
    await vi.waitFor(() => expect(m.app.viewsState.open).not.toBeNull());
    expect(await m.app.viewsState.remove(m.app.viewsState.open!)).toBe(true);
    expect(last(m)).toEqual([{ op: 'view_delete', id: 'pub/mine', if_match: 'etag-pub/mine' }]);
    await m.app.undo();
    expect(last(m)).toEqual([{ op: 'view_save', id: 'pub/mine', view: { title: 'Gone', display: 'columns', group_by: 'tags' } }]);
    m.app.stop();
  });

  it('folding a group keeps the fold in the view, and opening it takes it out', async () => {
    const m = made();
    m.hub.viewList = [view('pub/mine', { collapsed: ['doing'] })];
    await m.app.start(null);
    await vi.waitFor(() => expect(m.app.viewsState.open).not.toBeNull());
    const open = m.app.viewsState.open!;
    await m.app.viewsState.toggle(open, formOf(open), 'open');
    expect((last(m)[0] as { view: ViewForm }).view.collapsed).toEqual(['doing', 'open']);
    await m.app.viewsState.toggle(open, formOf(open), 'doing');
    expect((last(m)[0] as { view: ViewForm }).view.collapsed).toEqual([]);
    m.app.stop();
  });

  it('a write under way refuses another change of a view', async () => {
    const m = made();
    m.hub.viewList = [view('pub/mine')];
    await m.app.start(null);
    await vi.waitFor(() => expect(m.app.viewsState.open).not.toBeNull());
    m.app.saving = true;
    expect(await m.app.viewsState.remove(m.app.viewsState.open!)).toBe(false);
    expect(m.hub.sent).toHaveLength(0);
    // Said, as on the board: not dropped without a word.
    expect(m.app.toast).toMatchObject({ kind: 'error', text: translate(m.app.lang, 'write.busy') });
    m.app.stop();
  });

  it('a choice of a view in the palette is remembered only for an area whose class may be kept', async () => {
    const m = made();
    m.hub.areaList = [
      { name: 'pub', data_class: 'public' },
      { name: 'sec', data_class: 'private' },
    ];
    m.hub.viewList = [view('pub/one'), view('sec/two')];
    await m.app.start(null);
    await vi.waitFor(() => expect(m.app.hubAreas).toHaveLength(2));
    m.app.chose('action:view.sec/two');
    expect(m.prefs.get('tasks-desktop.frecency') ?? '').not.toContain('sec/two');
    m.app.chose('action:view.pub/one');
    expect(m.prefs.get('tasks-desktop.frecency')).toContain('pub/one');
    m.app.stop();
  });

  it('a tab of the views left open falls back to Today when the engine keeps no views', async () => {
    const m = made([], new Map([['tasks-desktop.view', 'views']]));
    expect(m.app.view).toBe('views');
    await m.app.start(null);
    expect(m.app.view).toBe('today');
    m.app.stop();
  });

  it('the groups stay drawn while the groupings of a newer state are asked for', async () => {
    const m = made();
    await m.app.start(null);
    m.app.setView('views');
    await vi.waitFor(() => expect(m.app.viewsState.groupingsShown?.rev).toBe('rev:1'));
    let release!: () => void;
    m.hub.groupingsHold = [new Promise<void>((r) => (release = r))];
    m.hub.doc = snapshot(m.hub.doc.tasks, 'rev:2');
    await m.app.refresh();
    await vi.waitFor(() => expect(m.hub.groupingsCalls).toBe(2));
    // The current ones are not there yet: the last ones stand in, never shown as those of the new state.
    expect(m.app.viewsState.groupingsNow).toBeNull();
    expect(m.app.viewsState.groupingsShown?.rev).toBe('rev:1');
    release();
    await vi.waitFor(() => expect(m.app.viewsState.groupingsShown?.rev).toBe('rev:2'));
    m.app.stop();
  });

  it('the open view is kept in the browser only for an area whose class may be kept there', async () => {
    const m = made();
    m.hub.areaList = [
      { name: 'pub', data_class: 'public' },
      { name: 'sec', data_class: 'private' },
    ];
    m.hub.viewList = [view('pub/one'), view('sec/two')];
    await m.app.start(null);
    await vi.waitFor(() => expect(m.app.hubAreas).toHaveLength(2));
    m.app.openView('sec/two');
    expect(m.app.view).toBe('views');
    expect(m.app.viewsState.open?.id).toBe('sec/two');
    expect(m.prefs.get('tasks-desktop.view-open')).toBe('');
    m.app.openView('pub/one');
    expect(m.prefs.get('tasks-desktop.view-open')).toBe('pub/one');
    m.app.stop();
  });

  it('the page opens on the tab and the view it was left on', async () => {
    const prefs = new Map([
      ['tasks-desktop.view', 'views'],
      ['tasks-desktop.view-open', 'pub/two'],
    ]);
    const m = made(['views', 'groupings'], prefs);
    m.hub.viewList = [view('pub/one'), view('pub/two')];
    expect(m.app.view).toBe('views');
    await m.app.start(null);
    await vi.waitFor(() => expect(m.app.viewsState.open?.id).toBe('pub/two'));
    // A view that is gone gives way to the first.
    m.app.viewsState.choose('pub/gone');
    expect(m.app.viewsState.open?.id).toBe('pub/one');
    m.app.stop();
  });

  it('show the tasks their selection names, found the way the list finds them', async () => {
    const m = made();
    await m.app.start(null);
    const ids = (select: Partial<View['select']>) =>
      m.app.tasksOfView(view('pub/x', { select: { ...emptySelect(), ...select } })).map((t) => t.id);
    expect(ids({})).toEqual(['pub/a', 'pub/b']);
    expect(ids({ statuses: ['doing'] })).toEqual(['pub/b']);
    expect(ids({ tags: ['ui'] })).toEqual(['pub/b']);
    expect(ids({ query: 'pub/a' })).toEqual(['pub/a']);
    m.app.stop();
  });

  describe('a task moved between the groups of a view', () => {
    const status: Grouping = { field: 'status', values: ['doing', 'blocked', 'open'], truncated: false, writable: true, value_type: 'string', mode: 'set' };
    const tags: Grouping = { field: 'tags', values: ['api', 'ui'], truncated: false, writable: true, value_type: 'string', mode: 'tags', multi: true };
    const state: Grouping = { field: 'state', values: ['ready', 'waiting'], truncated: false, writable: false, value_type: 'string' };
    const three = () => [
      task('pub/a', { status: 'open', etag: 'ea' }),
      task('pub/b', { status: 'open', etag: 'eb', tags: ['ui'] }),
      task('pub/c', { status: 'open', etag: 'ec' }),
    ];
    const ready = async () => {
      const m = made();
      m.hub.doc = snapshot(three());
      await m.app.start(null);
      return m;
    };

    it('writes the field the engine names, on the version shown, and can be taken back', async () => {
      const m = await ready();
      expect(await m.app.dropInView('pub/a', status, 'open', 'doing')).toBe(true);
      expect(last(m)).toEqual([{ op: 'set', id: 'pub/a', patch: { status: 'doing' }, if_match: 'ea' }]);
      expect(m.app.toast?.undo).toEqual([{ op: 'set', id: 'pub/a', patch: { status: 'open' }, if_match: 'e2' }]);
      m.app.stop();
    });

    it('in a matrix writes both fields in one set, and blocked asks for the blocker as on the board', async () => {
      const prio: Grouping = { field: 'prio', values: ['1', '2'], truncated: false, writable: true, value_type: 'number', mode: 'set' };
      const m = await ready();
      expect(await m.app.dropInMatrix('pub/a', prio, status, { row: '', column: 'open' }, { row: '1', column: 'doing' })).toBe(true);
      expect(last(m)).toEqual([{ op: 'set', id: 'pub/a', patch: { prio: 1, status: 'doing' }, if_match: 'ea' }]);
      // Into the column of blocked with nothing to wait for: the blocker is asked first, nothing is sent.
      const sent = m.hub.sent.length;
      expect(await m.app.dropInMatrix('pub/a', prio, status, { row: '', column: 'open' }, { row: '1', column: 'blocked' })).toBe(false);
      expect(m.app.blocking).toEqual({ id: 'pub/a' });
      expect(m.hub.sent).toHaveLength(sent);
      m.app.stop();
    });

    it('onto another area asks the engine first and moves only when confirmed, on the version shown', async () => {
      const area: Grouping = { field: 'area', values: ['pub', 'other'], truncated: false, writable: true, value_type: 'string', mode: 'move_area' };
      const m = made(['views', 'groupings', 'move_area', 'ops']);
      m.hub.doc = snapshot(three());
      await m.app.start(null);
      m.hub.next_ops = {
        kind: 'tasks.result',
        ok: true,
        dry_run: true,
        results: [{ n: 1, op: 'move_area', id: 'pub/a', ok: true, outcome: 'would_move', move: { from: 'pub/a', new_id: 'other/a', references: [], conflicts: [] } }],
      } as unknown as Result;
      // Not moved by the drop: it is a question first (a dry run, nothing written).
      expect(await m.app.dropInView('pub/a', area, 'pub', 'other')).toBe(false);
      expect(m.hub.sent).toHaveLength(1);
      expect(m.hub.sent[0]?.dry_run).toBe(true);
      expect(m.app.dropMove?.answer?.kind).toBe('ok');
      m.hub.next_ops = {
        kind: 'tasks.result',
        ok: true,
        dry_run: false,
        results: [{ n: 1, op: 'move_area', id: 'pub/a', ok: true, outcome: 'moved', new_id: 'other/a', changed_ids: ['pub/a', 'other/a'], inverse: { op: 'move_area', id: 'other/a', to_area: 'pub' } }],
      } as unknown as Result;
      await m.app.confirmDropMove();
      expect(last(m)).toEqual([{ op: 'move_area', id: 'pub/a', to_area: 'other', if_match: 'ea' }]);
      // Where it went, for the view to say and to follow.
      expect(m.app.areaMoved).toEqual({ id: 'other/a', area: 'other' });
      // The group of none is no area.
      expect(await m.app.dropInView('pub/a', area, 'pub', '')).toBe(false);
      expect(m.app.toast).toMatchObject({ kind: 'error', text: translate(m.app.lang, 'views.refused.required') });
      m.app.stop();
    });

    it('a move from the overview is not told to a view; several marked moved from a view tell where the dragged one went', async () => {
      const area: Grouping = { field: 'area', values: ['pub', 'other'], truncated: false, writable: true, value_type: 'string', mode: 'move_area' };
      const would = (n: number, id: string) => ({
        n,
        op: 'move_area',
        id,
        ok: true,
        outcome: 'would_move',
        move: { from: id, new_id: id.replace('pub/', 'other/'), references: [], conflicts: [] },
      });
      const moved = (n: number, id: string) => ({
        n,
        op: 'move_area',
        id,
        ok: true,
        outcome: 'moved',
        new_id: id.replace('pub/', 'other/'),
        changed_ids: [id],
        inverse: { op: 'move_area', id: id.replace('pub/', 'other/'), to_area: 'pub' },
      });
      const m = made(['views', 'groupings', 'move_area', 'ops']);
      m.hub.doc = snapshot(three());
      await m.app.start(null);
      // From the overview (no view): moved, and nothing for a view to say later.
      m.hub.next_ops = { kind: 'tasks.result', ok: true, dry_run: true, results: [would(1, 'pub/c')] } as unknown as Result;
      await m.app.askDropMove('pub/c', 'other');
      m.hub.next_ops = { kind: 'tasks.result', ok: true, dry_run: false, results: [moved(1, 'pub/c')] } as unknown as Result;
      await m.app.confirmDropMove();
      expect(m.hub.sent.at(-1)?.ops).toEqual([{ op: 'move_area', id: 'pub/c', to_area: 'other', if_match: 'ec' }]);
      expect(m.app.areaMoved).toBeNull();
      // Two marked cards of a view, one dragged: where the dragged one went.
      m.app.toggleMark('pub/a');
      m.app.toggleMark('pub/b');
      m.hub.next_ops = { kind: 'tasks.result', ok: true, dry_run: true, results: [would(1, 'pub/a'), would(2, 'pub/b')] } as unknown as Result;
      await m.app.dropInView('pub/a', area, 'pub', 'other', false, m.app.tasks);
      expect(m.app.dropMove?.count).toBe(2);
      m.hub.next_ops = { kind: 'tasks.result', ok: true, dry_run: false, results: [moved(1, 'pub/a'), moved(2, 'pub/b')] } as unknown as Result;
      await m.app.confirmDropMove();
      expect(m.app.areaMoved).toEqual({ id: 'other/a', area: 'other' });
      m.app.stop();
    });

    it('onto another area takes only the marked tasks the view shows', async () => {
      const area: Grouping = { field: 'area', values: ['pub', 'other'], truncated: false, writable: true, value_type: 'string', mode: 'move_area' };
      const m = made(['views', 'groupings', 'move_area', 'ops']);
      m.hub.doc = snapshot(three());
      await m.app.start(null);
      for (const id of ['pub/a', 'pub/b', 'pub/c']) m.app.toggleMark(id);
      const inView = m.app.tasks.filter((t) => t.id !== 'pub/c');
      m.hub.next_ops = { kind: 'tasks.result', ok: true, dry_run: true, results: [] } as unknown as Result;
      await m.app.dropInView('pub/a', area, 'pub', 'other', false, inView);
      expect(m.hub.sent[0]?.dry_run).toBe(true);
      expect(m.hub.sent[0]?.ops.map((o) => (o as { id: string }).id)).toEqual(['pub/a', 'pub/b']);
      expect(m.app.dropMove?.count).toBe(2);
      m.app.stop();
    });

    it('is no move when the engine refuses it (nothing to announce as moved)', async () => {
      const m = await ready();
      m.hub.next_ops = {
        kind: 'tasks.result',
        ok: false,
        dry_run: false,
        results: [{ n: 1, op: 'set', id: 'pub/a', ok: false, outcome: 'failed', changed_ids: [], error: { code: 'conflict', message: 'changed', retryable: false } }],
      } as unknown as Result;
      expect(await m.app.dropInView('pub/a', status, 'open', 'doing')).toBe(false);
      expect(m.hub.sent).toHaveLength(1);
      m.app.stop();
    });

    it('takes the tag it leaves away and sets the one it enters; with Ctrl it keeps the one it leaves', async () => {
      const m = await ready();
      await m.app.dropInView('pub/b', tags, 'ui', 'api');
      expect(last(m)).toEqual([{ op: 'set', id: 'pub/b', patch: { tags: ['api'] }, if_match: 'eb' }]);
      await m.app.dropInView('pub/b', tags, 'ui', 'api', true);
      expect(last(m)).toEqual([{ op: 'set', id: 'pub/b', patch: { tags: ['ui', 'api'] }, if_match: 'eb' }]);
      m.app.stop();
    });

    it('a marked task takes the other marked ones the view shows with it, as one batch whose failures are told', async () => {
      const m = await ready();
      for (const id of ['pub/a', 'pub/b', 'pub/c']) m.app.toggleMark(id);
      const inView = m.app.tasks.filter((t) => t.id !== 'pub/c');
      m.hub.next_ops = {
        kind: 'tasks.result',
        ok: false,
        dry_run: false,
        results: [
          { n: 1, op: 'set', id: 'pub/a', ok: true, outcome: 'changed', changed_ids: ['pub/a'], inverse: { op: 'set', id: 'pub/a', patch: { status: 'open' } } },
          { n: 2, op: 'set', id: 'pub/b', ok: false, outcome: 'failed', changed_ids: [], error: { code: 'conflict', message: 'changed', retryable: false } },
        ],
      } as unknown as Result;
      await m.app.dropInView('pub/a', status, 'open', 'doing', false, inView);
      // The mark the view does not show is not moved from here.
      expect(last(m).map((o) => (o as { id: string }).id)).toEqual(['pub/a', 'pub/b']);
      expect(m.app.toast).toMatchObject({ kind: 'error', text: translate(m.app.lang, 'bulk.partial', { done: 1, failed: 1 }) });
      // What failed stays marked, what went through is taken off.
      expect(m.app.marks).toEqual(['pub/b', 'pub/c']);
      m.app.stop();
    });

    it('blocked with nothing to wait for asks for the blocker of one task, and refuses it for several', async () => {
      const m = await ready();
      expect(await m.app.dropInView('pub/a', status, 'open', 'blocked')).toBe(false);
      expect(m.app.blocking).toEqual({ id: 'pub/a' });
      m.app.cancelBlock();
      m.app.toggleMark('pub/a');
      m.app.toggleMark('pub/b');
      expect(await m.app.dropInView('pub/a', status, 'open', 'blocked')).toBe(false);
      expect(m.app.blocking).toBeNull();
      expect(m.app.toast).toMatchObject({ kind: 'error', text: translate(m.app.lang, 'views.blocked_batch', { n: 2 }) });
      expect(m.hub.sent).toHaveLength(0);
      m.app.stop();
    });

    it('a field the engine does not write is refused in words, and nothing is sent while a write is on its way', async () => {
      const m = await ready();
      expect(await m.app.dropInView('pub/a', state, 'ready', 'waiting')).toBe(false);
      expect(m.app.toast).toMatchObject({ kind: 'error', text: translate(m.app.lang, 'views.refused.read_only') });
      m.app.saving = true;
      expect(await m.app.dropInView('pub/a', status, 'open', 'doing')).toBe(false);
      expect(m.app.toast).toMatchObject({ kind: 'error', text: translate(m.app.lang, 'write.busy') });
      expect(m.hub.sent).toHaveLength(0);
      m.app.stop();
    });
  });

  describe('a view being tried (from a context menu)', () => {
    it('is shown on the tab, changes and goes away in the page only, and is no view kept in the browser', async () => {
      const m = made();
      m.hub.viewList = [view('pub/one')];
      await m.app.start(null);
      await vi.waitFor(() => expect(m.app.viewsState.list).toHaveLength(1));
      m.app.tryView({ ...form(), title: 'Tried', select: { ...emptySelect(), areas: ['pub'] } });
      expect(m.app.view).toBe('views');
      const draft = m.app.viewsState.open!;
      expect(draft).toMatchObject({ id: DRAFT_ID, title: 'Tried', select: { areas: ['pub'] } });
      // Changed and folded: in the page, no write.
      expect(await m.app.viewsState.save(draft, { ...formOf(draft), display: 'list' })).toBe(true);
      expect(await m.app.viewsState.toggle(m.app.viewsState.open!, formOf(m.app.viewsState.open!), 'open')).toBe(true);
      expect(m.app.viewsState.open).toMatchObject({ id: DRAFT_ID, display: 'list', collapsed: ['open'] });
      expect(m.hub.sent).toHaveLength(0);
      expect(m.prefs.get('tasks-desktop.view-open') ?? '').toBe('');
      // Put away: the saved view is shown again, still nothing written.
      expect(await m.app.viewsState.remove(m.app.viewsState.open!)).toBe(true);
      expect(m.app.viewsState.open?.id).toBe('pub/one');
      expect(m.hub.sent).toHaveLength(0);
      m.app.stop();
    });

    it('saved, becomes a view of the vault with its selection, and is no longer tried', async () => {
      const m = made();
      await m.app.start(null);
      await vi.waitFor(() => expect(m.app.hubAreas).toHaveLength(1));
      m.app.tryView({ ...form(), title: 'Tried', select: { ...emptySelect(), tags: ['ui'] } });
      m.hub.viewList = [view('pub/made-view')];
      expect(await m.app.viewsState.create('pub', formOf(m.app.viewsState.open!))).toBe(true);
      expect(last(m)).toEqual([
        { op: 'view_save', area: 'pub', view: { title: 'Tried', display: 'columns', group_by: 'status', collapsed: [], select: { ...emptySelect(), tags: ['ui'] } } },
      ]);
      expect(m.app.viewsState.draft).toBeNull();
      expect(m.app.viewsState.open?.id).toBe('pub/made-view');
      m.app.stop();
    });

    it('the context menu offers the fields of the engine and opens the selection as a view being tried', async () => {
      const m = made();
      await m.app.start(null);
      const target = { getBoundingClientRect: () => ({ left: 10, bottom: 20 }), focus: () => undefined } as unknown as HTMLElement;
      let prevented = false;
      const event = { clientX: 0, clientY: 0, currentTarget: target, preventDefault: () => (prevented = true) } as unknown as MouseEvent;
      // Opened by a key (no pointer): under the element, and the focus goes back to it.
      await m.app.openViewMenu(event, 'pub', { areas: ['pub'] });
      expect(prevented).toBe(true);
      const menu = m.app.contextMenu!;
      expect(menu).toMatchObject({ x: 10, y: 20, origin: target });
      expect(menu.items.filter((i) => i.kind === 'action').map((i) => (i as { label: string }).label)).toEqual([
        translate(m.app.lang, 'views.display.columns'),
        translate(m.app.lang, 'views.display.list'),
        translate(m.app.lang, 'views.display.matrix'),
        translate(m.app.lang, 'views.field.status'),
        translate(m.app.lang, 'views.field.tags'),
      ]);
      const byTags = menu.items.filter((i) => i.kind === 'action')[4] as { onselect: () => void };
      byTags.onselect();
      expect(m.app.view).toBe('views');
      expect(m.app.viewsState.open).toMatchObject({ id: DRAFT_ID, title: 'pub', group_by: 'tags', select: { areas: ['pub'] } });
      m.app.stop();
    });

    it('an engine without views keeps the menu of the browser', async () => {
      const m = made([]);
      await m.app.start(null);
      let prevented = false;
      await m.app.openViewMenu({ clientX: 1, clientY: 1, currentTarget: null, preventDefault: () => (prevented = true) } as unknown as MouseEvent, 'pub', {});
      expect(prevented).toBe(false);
      expect(m.app.contextMenu).toBeNull();
      m.app.stop();
    });
  });

  it('a choice of "group the list by" in the palette is remembered like any action', async () => {
    const m = made();
    await m.app.start(null);
    m.app.setView('views');
    await vi.waitFor(() => expect(m.app.viewsState.groupingsShown).not.toBeNull());
    const action = paletteActions(m.app).find((a) => a.key === 'group.tags');
    expect(action).toBeDefined();
    m.app.chose(`action:${action!.key}`);
    expect(m.prefs.get('tasks-desktop.frecency')).toContain('group.tags');
    m.app.stop();
  });

  it('the palette reads the views again when the vault changed while their tab was not shown', async () => {
    const m = made();
    m.hub.viewList = [view('pub/one')];
    await m.app.start(null);
    await vi.waitFor(() => expect(m.hub.viewsCalls).toBe(1));
    m.app.openPalette();
    m.app.closePalette();
    expect(m.hub.viewsCalls).toBe(1);
    m.hub.doc = snapshot(m.hub.doc.tasks, 'rev:2');
    await m.app.refresh();
    m.app.openPalette();
    await vi.waitFor(() => expect(m.hub.viewsCalls).toBe(2));
    m.app.stop();
  });

  it('a task connects areas when the links of the engine name it among those that touch two or more', async () => {
    const m = made(['views', 'groupings', 'links']);
    await m.app.start(null);
    await vi.waitFor(() => expect(m.app.linksNow).not.toBeNull());
    const [a, b] = [m.app.tasks.find((t) => t.id === 'pub/a')!, m.app.tasks.find((t) => t.id === 'pub/b')!];
    expect(m.app.derivedValues(a, 'cross')).toEqual(['several']);
    expect(m.app.derivedValues(b, 'cross')).toEqual(['one']);
    // Every other field is the entry's own.
    expect(m.app.derivedValues(a, 'status')).toBeUndefined();
    // A new state (a write): while its links are on their way, the task keeps its group instead of jumping to `one`.
    let release: () => void = () => {};
    m.hub.linksHold = new Promise<void>((resolve) => (release = resolve));
    m.hub.doc = snapshot(m.hub.doc.tasks, 'rev:2');
    await m.app.refresh();
    expect(m.app.linksPending).toBe(true);
    expect(m.app.derivedValues(a, 'cross')).toEqual(['several']);
    release();
    await vi.waitFor(() => expect(m.app.linksNow?.rev).toBe('rev:2'));
    expect(m.app.derivedValues(a, 'cross')).toEqual(['several']);
    m.app.stop();
  });

  it('the board is the built-in view: opening it asks for the fields its bar makes views with', async () => {
    const m = made(['views', 'groupings', 'reorder']);
    await m.app.start(null);
    // The reads beside the list are done (they would see the board too, and ask themselves).
    await vi.waitFor(() => expect(m.hub.viewsCalls).toBe(1));
    await new Promise((r) => setTimeout(r, 10));
    expect(m.hub.groupingsCalls).toBe(0);
    m.app.setView('board');
    expect(m.app.view).toBe('board');
    await vi.waitFor(() => expect(m.hub.groupingsCalls).toBe(1));
    // A change of the vault on the board (every write there) asks nothing more: the next write would wait behind it.
    m.hub.doc = snapshot(m.hub.doc.tasks, 'rev:2');
    await m.app.refresh();
    await new Promise((r) => setTimeout(r, 10));
    expect(m.hub.groupingsCalls).toBe(1);
    m.app.stop();
  });

  it('the palette names every saved view and opens it', async () => {
    const m = made();
    m.hub.viewList = [view('pub/one'), view('pub/two', { title: 'Second' })];
    await m.app.start(null);
    await vi.waitFor(() => expect(m.app.viewsState.list).toHaveLength(2));
    const action = paletteActions(m.app).find((a) => a.key === 'view.pub/two');
    expect(action?.label).toContain('Second');
    await action!.run();
    expect(m.app.view).toBe('views');
    expect(m.app.viewsState.open?.id).toBe('pub/two');
    m.app.stop();
  });
});

describe('App, attaching a screenshot', () => {
  const attached = (id: string, asset: string): Result =>
    ({
      kind: 'tasks.result',
      ok: true,
      dry_run: false,
      results: [{ n: 1, op: 'attach', id, ok: true, outcome: 'changed', changed_ids: [id], asset, link: `![shot](${asset})` }],
    }) as unknown as Result;
  const nothing = (id: string, message: string): Result =>
    ({
      kind: 'tasks.result',
      ok: false,
      dry_run: false,
      results: [{ n: 1, op: 'attach', id, ok: false, outcome: 'failed', changed_ids: [], error: { code: 'invalid_argument', message, retryable: false } }],
    }) as unknown as Result;
  async function started() {
    const m = make({ token: 't' });
    m.hub.doc = snapshot([task('pub/a', { etag: 'e1' })]);
    await m.app.start(null);
    m.app.stop();
    return m;
  }
  const asked = (m: Awaited<ReturnType<typeof started>>) => m.hub.sent.map((r) => r.ops[0]);

  it('takes the image on the clipboard and shows its link in the detail', async () => {
    const m = await started();
    m.hub.next_ops = attached('pub/a', 'assets/a-shot.png');
    expect(await m.app.attachScreenshot('pub/a')).toBe(true);
    expect(asked(m)).toEqual([{ op: 'attach', id: 'pub/a', from: 'clipboard' }]);
    expect(m.app.attached).toEqual({ id: 'pub/a', link: '![shot](assets/a-shot.png)' });
    expect(m.app.toast?.kind).toBe('ok');
    expect(m.app.toast?.text).toBe(translate(m.app.lang, 'attach.done', { asset: 'assets/a-shot.png' }));
    // There is no way back: the engine gives no inverse.
    expect(m.app.toast?.undo).toBeUndefined();
  });

  it('takes the newest screenshot when the clipboard holds no image', async () => {
    const m = await started();
    m.hub.ops_queue = [nothing('pub/a', 'no image in the clipboard'), attached('pub/a', 'assets/newest.png')];
    expect(await m.app.attachScreenshot('pub/a')).toBe(true);
    expect(asked(m).map((op) => (op as { from: string }).from)).toEqual(['clipboard', 'latest']);
    expect(m.app.attached?.link).toBe('![shot](assets/newest.png)');
    expect(m.app.toast?.text).toBe(translate(m.app.lang, 'attach.done_latest', { asset: 'assets/newest.png' }));
  });

  it('takes no other image when the clipboard could not be read: the reason is told', async () => {
    const m = await started();
    m.hub.next_ops = nothing('pub/a', 'powershell.exe failed (exit 1): the clipboard is in use');
    expect(await m.app.attachScreenshot('pub/a')).toBe(false);
    expect(asked(m)).toHaveLength(1);
    expect(m.app.toast?.text).toBe(translate(m.app.lang, 'write.invalid', { message: 'powershell.exe failed (exit 1): the clipboard is in use' }));
  });

  it('says that the hub has no screenshot folders when the clipboard holds no image', async () => {
    const m = await started();
    m.hub.ops_queue = [
      nothing('pub/a', 'no image in the clipboard'),
      new ApiError(400, 'attach_no_folders', 'no screenshot folders are set for the hub'),
    ];
    expect(await m.app.attachScreenshot('pub/a')).toBe(false);
    expect(asked(m)).toHaveLength(2);
    expect(m.app.toast?.text).toBe(translate(m.app.lang, 'attach.no_folders'));
  });

  it('forgets the link of the screenshot when the session is lost', async () => {
    const m = await started();
    m.hub.next_ops = attached('pub/a', 'assets/a-shot.png');
    await m.app.attachScreenshot('pub/a');
    expect(m.app.attached).not.toBeNull();
    m.hub.onUnauthorized();
    expect(m.app.attached).toBeNull();
  });

  it('says once that there was nothing to attach, and attaches nothing', async () => {
    const m = await started();
    m.hub.ops_queue = [nothing('pub/a', 'no image in the clipboard'), nothing('pub/a', 'no new screenshot')];
    expect(await m.app.attachScreenshot('pub/a')).toBe(false);
    expect(asked(m)).toHaveLength(2);
    expect(m.app.attached).toBeNull();
    expect(m.app.toast?.kind).toBe('error');
    expect(m.app.toast?.text).toBe(translate(m.app.lang, 'attach.none'));
  });

  it('asks no second place when the engine refused for another reason', async () => {
    const m = await started();
    m.hub.next_ops = {
      kind: 'tasks.result',
      ok: false,
      dry_run: false,
      results: [{ n: 1, op: 'attach', id: 'pub/a', ok: false, outcome: 'failed', changed_ids: [], error: { code: 'not_found', message: 'no such task', retryable: false } }],
    } as unknown as Result;
    expect(await m.app.attachScreenshot('pub/a')).toBe(false);
    expect(asked(m)).toHaveLength(1);
    expect(m.app.toast?.text).toBe(translate(m.app.lang, 'write.not_found'));
  });

  it('a new task tells its id, so the capture can attach to it', async () => {
    const m = await started();
    expect(await m.app.createTask('pub', 'With a shot')).toBe('pub/created');
    m.hub.next_ops = attached('pub/created', 'assets/created.png');
    expect(await m.app.attachScreenshot('pub/created')).toBe(true);
    expect(m.app.attached?.id).toBe('pub/created');
  });
});
