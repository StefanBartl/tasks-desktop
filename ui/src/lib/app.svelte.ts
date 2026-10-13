// The state of the page and what keeps it true: pairing, the held list, the
// event stream and the detail of the selected task.

import { type TagEdit, bulkSetOps, markAll, pruneMarks, toggleMark } from './bulk';
import { planOp, type PlanForm, type PlanPreview } from './planwizard';
import { columnsOf, isColumn, neighbourColumn, placeNear, stepInGroup, type Move } from './board';
import { ApiError, type Hub, type HubArea, type HubAreas, type SearchResult } from './api';
import { cacheableList, type ListStore } from './cache';
import type { DonePreview, Next, Result, Snapshot, TaskDocument, TaskEntry } from './contract';
import type { Op } from './api';
import { applyFilter, emptyFilter, moveSelection, type Filter } from './filter';
import { bumped, parseFrecency, type Frecency } from './palette';
import { backoffSeconds, readStream, StreamRefused, type SseMessage } from './sse';
import { detectLang, isLang, translate, type Key, type Lang } from './i18n';
import { localToday } from './remind';

export type Phase = 'starting' | 'needs_pairing' | 'offline' | 'unavailable' | 'ready';
export type Connection = 'live' | 'reconnecting' | 'offline';
export type View = 'today' | 'list' | 'board' | 'plan';
export type Theme = 'auto' | 'light' | 'dark';
/** The blocks of the Today view that a person may hide. */
export const TILES = ['next', 'waiting', 'remind', 'cdx', 'counts'] as const;
export type Tile = (typeof TILES)[number];

/** What the last write did, in one line; `undo` is the way back, when there is one. */
export interface Toast {
  kind: 'ok' | 'error';
  text: string;
  undo?: Op[];
}

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
  /** Area names without the prefix `wkdbook-` where that is unambiguous. */
  shortAreas = $state(true);
  /** The day of the reader, `YYYY-MM-DD`; renewed when the window is looked at again. */
  today = $state(localToday());
  /** What the engine says it can do; `null` until it has answered (then nothing is held back). */
  capabilities = $state.raw<string[] | null>(null);
  /** A write is under way: the controls wait. */
  saving = $state(false);
  /** A write is sent and not answered yet: the toast on the screen is not the toast of that write. */
  answering = $state(false);
  /** Settles when the write under way has ended, its re-read included. */
  private settling: Promise<void> | null = null;
  /**
   * How many writes have ended. A control that shows a value the person chose
   * is drawn again from the model after each one: a change that was not made
   * (a conflict, a refusal) must not leave the control showing it.
   */
  writes = $state(0);
  /** The ids marked for a bulk change, in the order they were marked. */
  marks = $state.raw<string[]>([]);
  toast = $state.raw<Toast | null>(null);
  /** The capture dialog is open. */
  capturing = $state(false);
  /** A card dropped among cards of another priority, waiting for the person's answer. */
  repriority = $state.raw<{ id: string; from: string; prio: number; ops: Op[] } | null>(null);
  /** A card that goes to the blocked column and has no blocker yet, waiting for the person's answer. */
  blocking = $state.raw<{ id: string } | null>(null);
  /** The command palette is open. */
  palette = $state(false);
  /** What the palette's choices were, to put them first next time. */
  frecency = $state.raw<Frecency>({});
  /** The plan wizard is open. */
  planning = $state(false);
  /** The task that is being finished, with what the engine says that does. */
  finishing = $state.raw<{ id: string; preview: DonePreview } | null>(null);
  private opCount = 0;
  selectedId = $state<string | null>(null);
  /** The plan the plan view is narrowed to ('': every task); kept when the view is left. */
  planChoice = $state('');

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
  /** The read in progress (and the reads it repeats), if any. */
  private loop: Promise<void> | null = null;
  private dirty = false;

  constructor(private readonly env: Env) {
    const lang = safe(() => env.prefs.getItem('tasks-desktop.lang'));
    this.lang = isLang(lang) ? lang : detectLang(env.preferredLanguages);
    const theme = safe(() => env.prefs.getItem('tasks-desktop.theme'));
    this.theme = theme === 'light' || theme === 'dark' ? theme : 'auto';
    this.shortcuts = safe(() => env.prefs.getItem('tasks-desktop.shortcuts')) !== 'off';
    this.shortAreas = safe(() => env.prefs.getItem('tasks-desktop.short-areas')) !== 'off';
    const hidden = safe(() => env.prefs.getItem('tasks-desktop.tiles-hidden'));
    this.hiddenTiles = parseTiles(hidden);
    this.frecency = parseFrecency(safe(() => env.prefs.getItem('tasks-desktop.frecency')));
    // The page opens on the view it was left on.
    const view = safe(() => env.prefs.getItem('tasks-desktop.view'));
    this.view = view === 'list' || view === 'board' || view === 'plan' ? view : 'today';
  }

  // ── derived ───────────────────────────────────────────────────────────

  get shown(): TaskEntry[] {
    return applyFilter(this.tasks, this.filter);
  }

  get areaNames(): string[] {
    return [...new Set(this.tasks.map((t) => t.area))];
  }

  /** Every area of the vault, also one that has no open task (a task may be put there). */
  get allAreaNames(): string[] {
    return [...new Set([...this.hubAreas.map((a) => a.name), ...this.areaNames])];
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

  // ── writing ───────────────────────────────────────────────────────────

  private opId(): string {
    this.opCount += 1;
    return `ui-${this.env.now().toString(36)}-${this.opCount}`;
  }

  private say(kind: Toast['kind'], key: string, params: Record<string, string | number> = {}, undo?: Op[]): void {
    const text = translate(this.lang, key as Key, params);
    this.toast = { kind, text, ...(undo ? { undo } : {}) };
  }

  dismissToast(): void {
    this.toast = null;
  }

  openCapture(): void {
    if (this.phase === 'ready') this.capturing = true;
  }

  closeCapture(): void {
    this.capturing = false;
  }

  /** Whether the engine can do `capability`; true while it has not said (the cached list is shown first). */
  can(capability: string): boolean {
    return this.capabilities === null || this.capabilities.includes(capability);
  }

  openPalette(): void {
    if (this.phase === 'ready') this.palette = true;
  }

  closePalette(): void {
    this.palette = false;
  }

  /** Remember that `key` (an action or a task) was chosen. */
  chose(key: string): void {
    this.frecency = bumped(this.frecency, key, Date.now());
    safe(() => this.env.prefs.setItem('tasks-desktop.frecency', JSON.stringify(this.frecency)));
  }

  openPlanWizard(): void {
    if (this.phase === 'ready' && this.can('plan_new')) this.planning = true;
  }

  closePlanWizard(): void {
    this.planning = false;
  }

  /**
   * Ask the engine what the plan would be called (a dry run: nothing is written, nothing is scanned). The engine's
   * refusal is the answer when the form is not one, so the rules stay in one place.
   */
  async previewPlan(form: PlanForm, signal?: AbortSignal): Promise<PlanPreview> {
    if (form.title.trim() === '' || form.area === '') return { kind: 'unknown' };
    try {
      const result = await this.env.hub.ops(
        { client_op_id: this.opId(), dry_run: true, ops: [planOp(form)] },
        signal,
      );
      const entry = result.results[0];
      if (entry?.ok && typeof entry.id === 'string') {
        return { kind: 'ok', id: entry.id, renamed: entry.renamed === true };
      }
      return { kind: 'refused', message: entry?.error?.message ?? '' };
    } catch (error) {
      if (error instanceof ApiError && error.status === 400) {
        return { kind: 'refused', message: error.message };
      }
      return { kind: 'unknown' };
    }
  }

  /** Make the plan, show it in the plan view and choose it there. */
  async createPlan(form: PlanForm): Promise<void> {
    const result = await this.write([planOp(form)], { undoable: false });
    const id = result?.results.find((r) => r.ok && r.outcome === 'created')?.id;
    if (!id) return;
    this.planning = false;
    this.planChoice = id;
    this.setView('plan');
  }

  /**
   * Send operations and say what came of them. A part that failed is told per
   * operation; whatever the answer, the list is read again, so the page
   * never stands on a state it guessed.
   */
  async write(ops: Op[], opts: { undoable?: boolean } = {}): Promise<Result | null> {
    if (this.saving || this.phase !== 'ready') return null;
    this.saving = true;
    this.answering = true;
    let settle!: () => void;
    this.settling = new Promise<void>((resolve) => (settle = resolve));
    try {
      const result = await this.env.hub.ops({ client_op_id: this.opId(), ops });
      this.answering = false;
      const failed = result.results.find((r) => !r.ok);
      if (failed) {
        const code = failed.error?.code ?? 'failed';
        // What went through before the failure can still be taken back.
        const undo = opts.undoable === false ? undefined : this.inverseOf(result);
        if (code === 'conflict') this.say('error', 'write.conflict', {}, undo);
        else if (code === 'not_found') this.say('error', 'write.not_found', {}, undo);
        else if (code === 'exists') this.say('error', 'write.exists', {}, undo);
        else if (code === 'invalid_argument' || code === 'forbidden') {
          this.say('error', 'write.invalid', { message: failed.error?.message ?? code }, undo);
        } else this.say('error', 'write.failed', { code }, undo);
      } else {
        const undo = opts.undoable === false ? undefined : this.inverseOf(result);
        // A reorder numbers the neighbours where the spot needs it: more than one file is told.
        const files = result.results.reduce((n, r) => n + (r.writes ?? 0), 0);
        if (files > 1) this.say('ok', 'write.saved_many', { n: files }, undo);
        else this.say('ok', 'write.saved', {}, undo);
      }
      await this.refresh();
      return result;
    } catch (error) {
      this.answering = false;
      if (error instanceof ApiError && error.code === 'outcome_unknown') {
        this.say('error', 'write.unknown');
      } else if (error instanceof ApiError && error.status === 409) {
        this.say('error', 'write.conflict');
      } else if (error instanceof ApiError && error.status === 400) {
        this.say('error', 'write.invalid', { message: error.message });
      } else {
        this.say('error', 'write.failed', {
          code: error instanceof ApiError ? error.code : 'offline',
        });
      }
      await this.refresh();
      return null;
    } finally {
      this.saving = false;
      this.answering = false;
      this.settling = null;
      this.writes += 1;
      settle();
    }
  }

  /** The operations that take back what `result` did (only when every entry has one). */
  private inverseOf(result: Result): Op[] | undefined {
    const inverses: Op[] = [];
    for (const entry of result.results) {
      // An entry that failed changed nothing: it has no way back and needs none.
      if (!entry.ok || entry.outcome === 'unchanged') continue;
      // A move that numbered neighbours: one set for each file written gives it its old `order` back (the inverse
      // alone would only restore the place).
      if (entry.restore && entry.restore.length > 0) {
        for (const step of entry.restore) {
          if (step.op !== 'set') return undefined;
          inverses.push({
            op: 'set',
            id: step.id,
            patch: (step.patch ?? {}) as Record<string, unknown>,
            ...(step.if_match ? { if_match: step.if_match } : {}),
          });
        }
        continue;
      }
      const inv = entry.inverse;
      if (!inv) return undefined;
      if (inv.op === 'reorder') {
        inverses.push({
          op: 'reorder',
          id: inv.id,
          ...(inv.after ? { after: inv.after } : {}),
          ...(inv.before ? { before: inv.before } : {}),
          ...(inv.if_match ? { if_match: inv.if_match } : {}),
        });
        continue;
      }
      if (inv.op !== 'set') return undefined;
      inverses.push({
        op: 'set',
        id: inv.id,
        patch: (inv.patch ?? {}) as Record<string, unknown>,
        ...(inv.if_match ? { if_match: inv.if_match } : {}),
      });
    }
    return inverses.length > 0 ? inverses.reverse() : undefined;
  }

  async undo(): Promise<void> {
    const ops = this.toast?.undo;
    // While a write waits for its answer the toast is an older one: what it would undo may be touched by that write.
    if (!ops || this.answering) return;
    this.toast = null;
    // A click while the write under way still re-reads the list is queued, not lost.
    if (this.settling) await this.settling;
    const result = await this.write(ops, { undoable: false });
    if (result && result.ok) this.say('ok', 'write.undone');
    // Not sent at all (the page is not ready any more): say so, the toast is gone.
    else if (!result && !this.toast) this.say('error', 'write.failed', { code: 'offline' });
  }

  /** Take a reminder away (an open task or a finished one); `etag` is the version of the file that was shown. */
  async clearReminder(id: string, etag?: string): Promise<void> {
    await this.write([
      { op: 'set', id, patch: { remind: null }, ...(etag ? { if_match: etag } : {}) },
    ]);
  }

  /** Set one key of a task; `null` takes the key away. */
  async setField(id: string, key: string, value: string | number | string[] | null): Promise<void> {
    const task = this.tasks.find((t) => t.id === id);
    if (!task) return;
    await this.write([
      { op: 'set', id, patch: { [key]: value }, ...(task.etag ? { if_match: task.etag } : {}) },
    ]);
  }

  /** Mark or unmark `id`; says whether it is marked now (a mark past one batch is refused and told). */
  toggleMark(id: string): boolean {
    const next = toggleMark(this.marks, id);
    if (next.length === this.marks.length && !this.marks.includes(id)) {
      this.say('error', 'bulk.limit');
      return false;
    }
    this.marks = next;
    return next.includes(id);
  }

  /** Mark every task the list shows (up to one batch; what does not fit is told). */
  markShown(): void {
    const ids = this.shown.map((t) => t.id);
    const next = markAll(this.marks, ids);
    if (ids.some((id) => !next.includes(id))) this.say('error', 'bulk.limit');
    this.marks = next;
  }

  /** Only the tasks the list shows stay marked: a mark that cannot be seen must not be changed. */
  keepMarksShown(): void {
    if (this.marks.length === 0) return;
    const shown = new Set(this.shown.map((t) => t.id));
    const kept = this.marks.filter((id) => shown.has(id));
    if (kept.length !== this.marks.length) this.marks = kept;
  }

  clearMarks(): void {
    this.marks = [];
  }

  /** Say something to the person without writing (a refusal before anything is sent). */
  tell(kind: Toast['kind'], key: Key, params: Record<string, string | number> = {}): void {
    this.say(kind, key, params);
  }

  /**
   * The keys of `patch` on every marked task, as ONE request: the engine takes the batch as a whole (one write of the
   * index), each task with the version that was shown. A task that changed meanwhile fails alone and is told; the rest
   * is kept. The marks stay on the tasks that failed, so a second try is one click; a mark made while the request was
   * under way is not touched.
   */
  async bulkSet(patch: Record<string, unknown>, tags?: TagEdit): Promise<void> {
    const ops = bulkSetOps(this.tasks, this.marks, patch, tags);
    if (ops.length === 0) {
      this.say('ok', 'bulk.nothing');
      return;
    }
    const sent = new Set(ops.map((o) => o.id));
    const result = await this.write(ops);
    if (!result) return;
    // A failed entry names its operation (`n`), not always the task: the position in the batch says which one.
    const failedIds = new Set<string>();
    for (const r of result.results) {
      if (r.ok) continue;
      const id = ops[r.n - 1]?.id ?? (r.error?.details as { id?: unknown } | undefined)?.id;
      if (typeof id === 'string') failedIds.add(id);
    }
    if (result.results.some((r) => !r.ok) && failedIds.size === 0) {
      // Which tasks failed is not known: the toast of the write says why, and nothing is taken off the marks.
      return;
    }
    this.marks = this.marks.filter((id) => !sent.has(id) || failedIds.has(id));
    const undo = this.inverseOf(result);
    if (failedIds.size === 0) {
      this.say('ok', 'bulk.saved', { n: ops.length }, undo);
    } else {
      this.say('error', 'bulk.partial', { done: ops.length - failedIds.size, failed: failedIds.size }, undo);
    }
  }

  // ── the board ─────────────────────────────────────────────────────────

  /** The cards of the board: what the list shows, in a column for each status, in the engine's order. */
  get board() {
    return columnsOf(this.shown);
  }

  /** Send a move of a card, or say why it cannot be made (the order has no meaning across a priority border). */
  async moveCard(move: Move): Promise<void> {
    if (move.kind === 'prio') {
      if (this.phase === 'ready' && !this.saving) {
        this.repriority = { id: move.id, from: move.from, prio: move.prio, ops: move.ops };
      }
      return;
    }
    if (move.kind === 'refused') {
      if (move.reason === 'group') this.say('error', 'board.refused_group');
      else if (move.reason === 'edge') this.say('error', 'board.refused_edge');
      return;
    }
    await this.write([move.op]);
  }

  cancelRepriority(): void {
    this.repriority = null;
  }

  /** Set the priority and place the card, as one batch (the way back is the inverse of both). */
  async confirmRepriority(): Promise<void> {
    const asking = this.repriority;
    if (!asking) return;
    this.repriority = null;
    await this.write(asking.ops);
  }

  /** `id` dropped on `target`: before or after it. */
  async dropNear(id: string, target: { id: string; place: 'before' | 'after' }): Promise<void> {
    await this.moveCard(placeNear(this.tasks, id, target));
  }

  /** `id` one place up or down inside its group (`K` and `J`). */
  async stepCard(id: string, dir: 1 | -1): Promise<void> {
    const task = this.tasks.find((t) => t.id === id);
    // A card the filter hides is not moved behind the person's back.
    if (!task || !isColumn(task.status) || !this.shown.some((t) => t.id === id)) return;
    await this.moveCard(stepInGroup(this.board[task.status], id, dir));
  }

  /** `id` into the column of `status` (a drop on a column, `H` and `L`). */
  async dropOnColumn(id: string, status: string): Promise<void> {
    const task = this.tasks.find((t) => t.id === id);
    if (!task || task.status === status || !isColumn(status)) return;
    // Blocked with nothing that blocks it is a warning of the engine: ask for the blocker first.
    if (status === 'blocked' && task.blocked_by.length === 0) {
      if (this.phase === 'ready' && !this.saving) this.blocking = { id };
      return;
    }
    await this.setField(id, 'status', status);
  }

  cancelBlock(): void {
    this.blocking = null;
  }

  /** The names in `ids` that are no open task of the vault (or the card itself). */
  unknownBlockers(ids: string[]): string[] {
    const self = this.blocking?.id;
    const known = new Set(this.tasks.map((t) => t.id));
    return ids.filter((id) => id === self || !known.has(id));
  }

  /** Block the card, by `ids` or by nothing the person can name. */
  async confirmBlock(blockers: string[]): Promise<void> {
    // The same id twice is one blocker.
    const ids = [...new Set(blockers)];
    const asking = this.blocking;
    if (!asking) return;
    this.blocking = null;
    const task = this.tasks.find((t) => t.id === asking.id);
    if (!task) return;
    await this.write([
      {
        op: 'set',
        id: asking.id,
        patch: { status: 'blocked', ...(ids.length > 0 ? { blocked_by: ids } : {}) },
        ...(task.etag ? { if_match: task.etag } : {}),
      },
    ]);
  }

  /** A card dropped on the zone for finished work: the same two steps as the button. */
  async dropOnDone(id: string): Promise<void> {
    if (!this.shown.some((t) => t.id === id)) return;
    await this.startFinish(id);
  }

  /** `id` one column to the left or right. */
  async shiftColumn(id: string, dir: 1 | -1): Promise<void> {
    const task = this.tasks.find((t) => t.id === id);
    const to = neighbourColumn(task?.status, dir);
    if (task && to && this.shown.some((t) => t.id === id)) await this.dropOnColumn(id, to);
  }

  /** The selection to the next card of its column (`j`, `k`). */
  moveSelectionInColumn(delta: number): void {
    const task = this.tasks.find((t) => t.id === this.selectedId);
    if (!task || !isColumn(task.status)) {
      const first = Object.values(this.board).flat()[0];
      if (first) this.select(first.id);
      return;
    }
    const column = this.board[task.status];
    const at = column.findIndex((t) => t.id === task.id);
    const next = column[at + delta];
    if (next) this.select(next.id);
  }

  /** The selection to the same height in the column left or right (`h`, `l`); empty columns are passed. */
  moveSelectionAcross(dir: 1 | -1): void {
    const task = this.tasks.find((t) => t.id === this.selectedId);
    if (!task || !isColumn(task.status)) return;
    const at = task.status;
    const board = this.board;
    const row = board[at].findIndex((t) => t.id === task.id);
    let col = neighbourColumn(at, dir);
    while (col !== null && board[col].length === 0) col = neighbourColumn(col, dir);
    if (col === null) return;
    const target = board[col][Math.min(row, board[col].length - 1)];
    if (target) this.select(target.id);
  }

  async createTask(area: string, title: string, fields: Record<string, unknown> = {}): Promise<void> {
    const result = await this.write([
      { op: 'new', area, title, ...(Object.keys(fields).length > 0 ? { fields } : {}) },
    ], { undoable: false });
    const created = result?.results.find((r) => r.ok && r.outcome === 'created')?.id;
    this.capturing = false;
    if (created) {
      this.reveal(created);
    }
  }

  async startFinish(id: string): Promise<void> {
    if (this.saving || this.phase !== 'ready') return;
    try {
      const preview = await this.env.hub.donePreview(id);
      if (preview.already) {
        this.say('ok', 'done.already');
        return;
      }
      this.finishing = { id, preview };
    } catch (error) {
      this.say('error', 'write.failed', { code: error instanceof ApiError ? error.code : 'offline' });
    }
  }

  cancelFinish(): void {
    this.finishing = null;
  }

  /** `remind` (`+7d`, a date) sets a reminder on the finished task. */
  async confirmFinish(remind?: string): Promise<void> {
    const finishing = this.finishing;
    if (!finishing?.preview.confirm) return;
    this.finishing = null;
    await this.write(
      [
        {
          op: 'done',
          id: finishing.id,
          confirm: finishing.preview.confirm,
          ...(remind ? { remind } : {}),
        },
      ],
      { undoable: false },
    );
  }

  setShortAreas(on: boolean): void {
    this.shortAreas = on;
    safe(() => this.env.prefs.setItem('tasks-desktop.short-areas', on ? 'on' : 'off'));
  }

  /** Take every chosen area, status and actor and the search words away. */
  resetFilter(): void {
    this.filter = { ...emptyFilter, areas: [], statuses: [], actors: [] };
    // The text search belongs to the words that are gone.
    this.scheduleTextSearch('', 0);
  }

  /**
   * Show a task in the list with its detail: a filter that hides it is taken
   * away first, or the detail would stand without its row.
   */
  reveal(id: string): void {
    if (this.tasks.some((t) => t.id === id) && !this.shown.some((t) => t.id === id)) {
      this.resetFilter();
    }
    this.select(id);
    this.setView('list');
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
        // An engine that is not there says nothing about what it can do.
        this.capabilities = hello.engine.capabilities;
        // A board left open by an older engine would offer what it refuses.
        if (this.view === 'board' && !this.can('reorder')) this.view = 'today';
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
   * is running makes exactly one more read after it. A caller that arrives
   * then waits for that read too, so what it awaits is a list that is
   * current (a write has just made a task that the read under way may not
   * have seen).
   */
  refresh(): Promise<void> {
    if (this.loop) {
      this.dirty = true;
      return this.loop;
    }
    this.loop = (async () => {
      try {
        do {
          this.dirty = false;
          await this.readOnce();
        } while (this.dirty && !this.stopped);
      } finally {
        this.loop = null;
      }
    })();
    return this.loop;
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
      this.marks = pruneMarks(this.marks, this.tasks);
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
    // The board writes with `reorder`: an engine without it does not get one.
    if (view === 'board' && !this.can('reorder')) return;
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
    // A page that stood open over midnight: a reminder may be due since.
    this.today = localToday();
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
