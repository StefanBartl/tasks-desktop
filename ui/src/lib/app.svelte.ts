// The state of the page and what keeps it true: pairing, the held list, the
// event stream and the detail of the selected task.

import { ApiError, type Hub, type HubArea } from './api';
import { cacheableList, type ListStore } from './cache';
import type { Next, Snapshot, TaskDocument, TaskEntry } from './contract';
import { applyFilter, emptyFilter, moveSelection, type Filter } from './filter';
import { backoffSeconds, readStream, StreamRefused, type SseMessage } from './sse';
import { detectLang, isLang, type Lang } from './i18n';

export type Phase = 'starting' | 'needs_pairing' | 'offline' | 'unavailable' | 'ready';
export type Connection = 'live' | 'reconnecting' | 'offline';
export type View = 'today' | 'list';
export type Theme = 'auto' | 'light' | 'dark';

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

function safe<T>(work: () => T): T | null {
  try {
    return work();
  } catch {
    return null;
  }
}

export class App {
  phase = $state<Phase>('starting');
  problem = $state<string | null>(null);
  connection = $state<Connection>('offline');
  view = $state<View>('today');
  lang = $state<Lang>('en');
  theme = $state<Theme>('auto');
  filter = $state<Filter>({ ...emptyFilter });
  selectedId = $state<string | null>(null);

  tasks = $state.raw<TaskEntry[]>([]);
  snapshot = $state.raw<Snapshot | null>(null);
  next = $state.raw<Next | null>(null);
  hubAreas = $state.raw<HubArea[]>([]);
  detail = $state.raw<Detail>({ state: 'none' });
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

  setTheme(theme: Theme): void {
    this.theme = theme;
    safe(() => this.env.prefs.setItem('tasks-desktop.theme', theme));
  }

  // ── start ─────────────────────────────────────────────────────────────

  /** Bring the page up. `code` is a pairing code taken from the address. */
  async start(code: string | null): Promise<void> {
    this.stopped = false;
    this.phase = 'starting';
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
        this.phase = 'offline';
        this.connection = 'offline';
        await this.env.sleep(3000);
        if (this.stopped) return;
      }
    }

    let token = safe(() => this.env.session.getItem(TOKEN_KEY));
    if (code) {
      try {
        token = await this.env.hub.exchange(code);
        safe(() => this.env.session.setItem(TOKEN_KEY, token as string));
      } catch {
        token = null;
      }
    }
    if (!token) {
      this.phase = 'needs_pairing';
      return;
    }
    this.env.hub.setToken(token);
    this.env.hub.onUnauthorized = () => this.lostSession();

    // The first picture comes from the cache, before the hub has answered.
    const cached = await this.env.cache.load();
    if (cached && this.tasks.length === 0) {
      this.tasks = cached.tasks;
      this.etag = cached.etag;
      this.cachedAt = cached.savedAt;
      this.phase = 'ready';
    }

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
      const [result, areas] = await Promise.all([hub.snapshot(this.etag), hub.areas()]);
      this.hubAreas = areas.areas;
      if (result.kind === 'fresh') {
        this.snapshot = result.doc;
        this.tasks = result.doc.tasks;
        this.etag = result.etag;
        const list = cacheableList(result.doc, result.etag, areas.areas, this.env.now());
        if (list) void this.env.cache.save(list);
        else void this.env.cache.clear();
      }
      this.cachedAt = null;
      this.phase = 'ready';
      if (this.connection === 'offline') this.connection = 'reconnecting';
      this.next = await hub.next().catch(() => this.next);
      this.keepSelection();
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

  // ── selection and detail ──────────────────────────────────────────────

  select(id: string | null): void {
    this.selectedId = id;
    if (id === null) {
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
    try {
      const doc = await this.env.hub.task(id);
      if (this.selectedId === id) this.detail = { state: 'ok', id, doc };
    } catch {
      if (this.selectedId === id) this.detail = { state: 'failed', id };
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
