// The state of the page and what keeps it true: pairing, the held list, the
// event stream and the detail of the selected task.

import { ApiError, type Hub, type HubArea, type HubAreas, type SearchResult } from './api';
import { cacheableList, type ListStore } from './cache';
import type { Next, Snapshot, TaskDocument, TaskEntry } from './contract';
import { applyFilter, emptyFilter, moveSelection, type Filter } from './filter';
import { backoffSeconds, readStream, StreamRefused, type SseMessage } from './sse';
import { detectLang, isLang, type Lang } from './i18n';

export type Phase = 'starting' | 'needs_pairing' | 'offline' | 'unavailable' | 'ready';
export type Connection = 'live' | 'reconnecting' | 'offline';
export type View = 'today' | 'list';
export type Theme = 'auto' | 'light' | 'dark';
/** The blocks of the Today view that a person may hide. */
export const TILES = ['next', 'waiting', 'cdx', 'counts'] as const;
export type Tile = (typeof TILES)[number];

export type Detail =
  | { state: 'none' }
  | { state: 'loading'; id: string }
  | { state: 'ok'; id: string; doc: TaskDocument }
  | { state: 'failed'; id: string };

/** What the page needs from its surroundings. */
export interface Env {
  hub: Hub;
  cache: ListStore;
  /** Per-tab storage for the session token. */
  session: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
  /** Per-browser storage for language and theme. */
  prefs: Pick<Storage, 'getItem' | 'setItem'>;
  preferredLanguages: readonly string[];
  now(): number;
  fetchFn: typeof fetch;
  /** Wait; replaced in tests. */
  sleep(ms: number): Promise<void>;
}

const TOKEN_KEY = 'tasks-desktop.session';

/** A promise that gives up after `ms` and says `null`. */
function within<T>(work: Promise<T>, ms: number): Promise<T | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), ms);
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      () => {
        clearTimeout(timer);
        resolve(null);
      },
    );
  });
}

function safe<T>(work: () => T): T | null {
  try {
    return work();
  } catch {
    return null;
  }
}

/** The remembered hidden blocks; anything that is not a known block is dropped. */
function parseTiles(text: string | null): Tile[] {
  if (!text) return [];
  try {
    const value: unknown = JSON.parse(text);
    if (!Array.isArray(value)) return [];
    return TILES.filter((t) => value.includes(t));
  } catch {
    return [];
  }
}

export class App {
  phase = $state<Phase>('starting');
  problem = $state<string | null>(null);
  connection = $state<Connection>('offline');
  view = $state<View>('today');
  lang = $state<Lang>('en');
  theme = $state<Theme>('auto');
  /** Single-key shortcuts; a person with assistive software may turn them off. */
  shortcuts = $state(true);
  filter = $state<Filter>({ ...emptyFilter, areas: [], statuses: [], actors: [] });
  /** Blocks of the Today view the person put away. */
  hiddenTiles = $state<Tile[]>([]);
  selectedId = $state<string | null>(null);

  tasks = $state.raw<TaskEntry[]>([]);
  snapshot = $state.raw<Snapshot | null>(null);
  next = $state.raw<Next | null>(null);
  hubAreas = $state.raw<HubArea[]>([]);
  detail = $state.raw<Detail>({ state: 'none' });
  /** What the hub found in the text of the tasks for the words in the filter. */
  textSearch = $state.raw<{ query: string; result: SearchResult } | null>(null);
  /** When the list shown was saved, if it is from the cache and not yet confirmed. */
  cachedAt = $state<number | null>(null);

  private etag: string | null = null;
  private stopped = false;
  private abort: AbortController | null = null;
  private refreshing = false;
  private dirty = false;

  constructor(private readonly env: Env) {
    const lang = safe(() => env.prefs.getItem('tasks-desktop.lang'));
    this.lang = isLang(lang) ? lang : detectLang(env.preferredLanguages);
    const theme = safe(() => env.prefs.getItem('tasks-desktop.theme'));
    this.theme = theme === 'light' || theme === 'dark' ? theme : 'auto';
    this.shortcuts = safe(() => env.prefs.getItem('tasks-desktop.shortcuts')) !== 'off';
    const hidden = safe(() => env.prefs.getItem('tasks-desktop.tiles-hidden'));
    this.hiddenTiles = parseTiles(hidden);
    // The page opens on the view it was left on.
    this.view = safe(() => env.prefs.getItem('tasks-desktop.view')) === 'list' ? 'list' : 'today';
  }

  // ── derived ───────────────────────────────────────────────────────────

  get shown(): TaskEntry[] {
    return applyFilter(this.tasks, this.filter);
  }

  get areaNames(): string[] {
    return [...new Set(this.tasks.map((t) => t.area))];
  }

  get selected(): TaskEntry | null {
    return this.tasks.find((t) => t.id === this.selectedId) ?? null;
  }

  // ── preferences ───────────────────────────────────────────────────────

  setLang(lang: Lang): void {
    this.lang = lang;
    safe(() => this.env.prefs.setItem('tasks-desktop.lang', lang));
  }

  setShortcuts(on: boolean): void {
    this.shortcuts = on;
    safe(() => this.env.prefs.setItem('tasks-desktop.shortcuts', on ? 'on' : 'off'));
  }

  hideTile(tile: Tile): void {
    if (this.hiddenTiles.includes(tile)) return;
    this.hiddenTiles = [...this.hiddenTiles, tile];
    this.saveTiles();
  }

  showTiles(): void {
    this.hiddenTiles = [];
    this.saveTiles();
  }

  private saveTiles(): void {
    safe(() => this.env.prefs.setItem('tasks-desktop.tiles-hidden', JSON.stringify(this.hiddenTiles)));
  }

  setTheme(theme: Theme): void {
    this.theme = theme;
    safe(() => this.env.prefs.setItem('tasks-desktop.theme', theme));
  }

  // ── start ─────────────────────────────────────────────────────────────

  /** Bring the page up. `code` is a pairing code taken from the address. */
  async start(code: string | null): Promise<void> {
    this.stopped = false;
    this.phase = 'starting';
    const stored = safe(() => this.env.session.getItem(TOKEN_KEY));

    // The first picture comes from the cache, before the hub has answered
    // (and when it does not). Only a tab that was paired shows one. A cache
    // that does not answer in a moment is a miss.
    if (stored) {
      const cached = await within(this.env.cache.load(), 1500);
      if (cached && this.tasks.length === 0) {
        this.tasks = cached.tasks;
        this.cachedAt = cached.savedAt;
        this.phase = 'ready';
      }
    }

    for (;;) {
      try {
        const hello = await this.env.hub.hello();
        if (!hello.engine.ready) {
          this.problem = hello.engine.problem ?? 'unknown';
          this.phase = 'unavailable';
          await this.env.sleep(5000);
          if (this.stopped) return;
          continue;
        }
        break;
      } catch {
        this.connection = 'offline';
        // A list from the cache stays on the screen: that is its use.
        if (this.tasks.length === 0) this.phase = 'offline';
        await this.env.sleep(3000);
        if (this.stopped) return;
      }
    }

    let token = stored;
    if (code) {
      try {
        const fresh = await this.env.hub.exchange(code);
        safe(() => this.env.session.setItem(TOKEN_KEY, fresh));
        token = fresh;
      } catch {
        // A code that is spent or too old: the session of this tab, if it
        // has one, is still good.
      }
    }
    if (!token) {
      this.phase = 'needs_pairing';
      this.tasks = [];
      this.cachedAt = null;
      return;
    }
    this.env.hub.setToken(token);
    this.env.hub.onUnauthorized = () => this.lostSession();

    await this.refresh();
    if (!this.env.hub.hasToken || this.stopped) return;
    void this.followStream();
  }

  stop(): void {
    this.stopped = true;
    this.abort?.abort();
  }

  private lostSession(): void {
    safe(() => this.env.session.removeItem(TOKEN_KEY));
    this.env.hub.setToken(null);
    this.abort?.abort();
    this.phase = 'needs_pairing';
    this.connection = 'offline';
    this.tasks = [];
    this.snapshot = null;
    this.next = null;
    this.nextFor = null;
    this.hubAreas = [];
    this.detail = { state: 'none' };
    this.cachedAt = null;
    this.etag = null;
  }

  // ── reading ───────────────────────────────────────────────────────────

  /**
   * Read the list again. One at a time: a change that arrives while a read
   * is running makes exactly one more read after it.
   */
  async refresh(): Promise<void> {
    if (this.refreshing) {
      this.dirty = true;
      return;
    }
    this.refreshing = true;
    try {
      do {
        this.dirty = false;
        await this.readOnce();
      } while (this.dirty && !this.stopped);
    } finally {
      this.refreshing = false;
    }
  }

  private async readOnce(): Promise<void> {
    const hub = this.env.hub;
    try {
      // A conditional request only when the whole document is held: the
      // cache holds a part of it, and a "not modified" must not leave that
      // part standing in for the list.
      const result = await hub.snapshot(this.snapshot ? this.etag : null);
      if (result.kind === 'fresh') {
        this.snapshot = result.doc;
        this.tasks = result.doc.tasks;
        this.etag = result.etag;
      }
      this.cachedAt = null;
      this.phase = 'ready';
      if (this.connection === 'offline') this.connection = 'reconnecting';
      this.keepSelection();
      // What is needed beside the list is read after it is shown: each of
      // these is one more Neovim process of the hub.
      void this.readBeside();
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) return;
      if (error instanceof ApiError && error.code === 'engine_unavailable') {
        this.phase = 'unavailable';
        return;
      }
      if (this.tasks.length === 0) this.phase = 'offline';
      this.connection = 'offline';
    }
  }

  /** The classes of the areas, the cache, and the next task. */
  private async readBeside(): Promise<void> {
    const doc = this.snapshot;
    if (!doc) return;
    try {
      // The classes come from `areas.json`, read when the hub started: they
      // are read once, and again when an area appears that was not there.
      const known = new Set(this.hubAreas.map((a) => a.name));
      if (this.hubAreas.length === 0 || doc.tasks.some((t) => !known.has(t.area))) {
        this.areasRead ??= this.env.hub.areas().finally(() => {
          this.areasRead = null;
        });
        this.hubAreas = (await this.areasRead).areas;
      }
      const list = cacheableList(doc, this.etag, this.hubAreas, this.env.now());
      if (list) void this.env.cache.save(list);
      else void this.env.cache.clear();
    } catch {
      // No classes, no cache: nothing is written.
    }
    if (this.view === 'today') await this.loadNext();
  }

  private nextFor: string | null = null;
  private searchTimer: ReturnType<typeof setTimeout> | undefined;
  private searchAbort: AbortController | null = null;
  private detailAbort: AbortController | null = null;
  private areasRead: Promise<HubAreas> | null = null;

  /** The next task, read when the list it belongs to is not the one held. */
  async loadNext(): Promise<void> {
    const key = this.snapshot?.digest ?? null;
    if (this.next !== null && key !== null && this.nextFor === key) return;
    try {
      this.next = await this.env.hub.next();
      this.nextFor = key;
    } catch {
      // The old one stays.
    }
  }

  setView(view: View): void {
    this.view = view;
    safe(() => this.env.prefs.setItem('tasks-desktop.view', view));
    if (view === 'today' && this.phase === 'ready') void this.loadNext();
  }

  /** The selection stays on the task id; a task that is gone clears it. */
  private keepSelection(): void {
    if (this.selectedId === null) return;
    const task = this.tasks.find((t) => t.id === this.selectedId);
    if (!task) {
      this.selectedId = null;
      this.detail = { state: 'none' };
      return;
    }
    // The file changed under the open detail: read it again.
    if (this.detail.state === 'ok' && this.detail.doc.task.etag !== task.etag) {
      void this.loadDetail(task.id);
    }
  }

  // ── the text of the tasks ─────────────────────────────────────────────

  /** The words of the filter changed: the list filters at once, the text is searched a moment later. */
  setQuery(text: string): void {
    this.filter = { ...this.filter, query: text };
    this.scheduleTextSearch(text, 0);
  }

  private scheduleTextSearch(text: string, attempt: number): void {
    clearTimeout(this.searchTimer);
    this.searchAbort?.abort();
    const query = text.trim();
    // Two letters are not a search of the text (the title and id filter is).
    if (query.length < 2 || this.phase !== 'ready') {
      this.textSearch = null;
      return;
    }
    const wait = attempt === 0 ? 250 : 1500;
    this.searchTimer = setTimeout(() => void this.runTextSearch(query, attempt), wait);
  }

  private async runTextSearch(query: string, attempt: number): Promise<void> {
    const abort = new AbortController();
    this.searchAbort = abort;
    try {
      const result = await this.env.hub.search(query, abort.signal);
      if (abort.signal.aborted || this.filter.query.trim() !== query) return;
      this.textSearch = { query, result };
      // The hub reads the texts a moment after it starts: ask again.
      if (result.status === 'building' && attempt < 8) this.scheduleTextSearch(query, attempt + 1);
    } catch {
      if (!abort.signal.aborted && this.filter.query.trim() === query) this.textSearch = null;
    }
  }

  // ── selection and detail ──────────────────────────────────────────────

  select(id: string | null): void {
    this.selectedId = id;
    if (id === null) {
      this.detailAbort?.abort();
      this.detail = { state: 'none' };
      return;
    }
    void this.loadDetail(id);
  }

  moveSelection(delta: number): void {
    const id = moveSelection(this.shown, this.selectedId, delta);
    if (id !== null && id !== this.selectedId) this.select(id);
  }

  private async loadDetail(id: string): Promise<void> {
    // Keep what is shown while the same task is read again.
    if (!(this.detail.state === 'ok' && this.detail.id === id)) {
      this.detail = { state: 'loading', id };
    }
    // Each task is a Neovim process of the hub. A task that was passed on the
    // way (j j j j) is not read: its request is dropped, and so is its read.
    this.detailAbort?.abort();
    const abort = new AbortController();
    this.detailAbort = abort;
    try {
      const doc = await this.env.hub.task(id, abort.signal);
      if (this.selectedId === id) this.detail = { state: 'ok', id, doc };
    } catch {
      if (!abort.signal.aborted && this.selectedId === id) {
        this.detail = { state: 'failed', id };
      }
    }
  }

  // ── events ────────────────────────────────────────────────────────────

  /** Ask for a scan: the window got the focus back. */
  async focused(): Promise<void> {
    if (this.phase !== 'ready' || !this.env.hub.hasToken) return;
    try {
      await this.env.hub.rescan();
    } catch {
      // A hub that is gone shows itself through the stream.
    }
    await this.refresh();
  }

  private async followStream(): Promise<void> {
    let attempt = 0;
    while (!this.stopped && this.env.hub.hasToken) {
      this.abort = new AbortController();
      try {
        await readStream(
          this.env.fetchFn,
          this.env.hub.url('/api/tasks/events'),
          this.env.hub.bearer,
          {
            onOpen: () => {
              attempt = 0;
              this.connection = 'live';
              // What happened while the stream was down.
              void this.refresh();
            },
            onMessage: (m) => this.onMessage(m),
          },
          this.abort.signal,
        );
      } catch (error) {
        if (this.stopped) return;
        if (error instanceof StreamRefused && error.status === 401) {
          this.lostSession();
          return;
        }
      }
      if (this.stopped || !this.env.hub.hasToken) return;
      this.connection = 'reconnecting';
      await this.env.sleep(backoffSeconds(attempt++) * 1000);
    }
  }

  private onMessage(message: SseMessage): void {
    if (message.event === 'tasks' || message.event === 'resync') {
      void this.refresh();
      return;
    }
    if (message.event === 'hello') {
      // Where the stream stands: a different revision than ours is a change
      // that came between our read and the stream.
      try {
        const doc = JSON.parse(message.data) as { rev?: string | null };
        if (doc.rev && this.snapshot?.rev && doc.rev !== this.snapshot.rev) void this.refresh();
      } catch {
        void this.refresh();
      }
    }
  }
}
