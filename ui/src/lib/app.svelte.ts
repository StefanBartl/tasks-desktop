// The state of the page and what keeps it true: pairing, the held list, the
// event stream and the detail of the selected task.

import { type TagEdit, bulkSetOps, markAll, pruneMarks, toggleMark } from './bulk';
import { planOp, type PlanForm, type PlanPreview } from './planwizard';
import { columnsOf, isColumn, neighbourColumn, placeNear, stepInGroup, type Move } from './board';
import { ApiError, type CheckJobState, type Hub, type HubArea, type HubAreas, type SearchResult, type VaultList } from './api';
import { cacheableClass, cacheableList, type CachedList, type ListStore } from './cache';
import type { Check, DonePreview, Estimate, Finished, Links, MovePlan, Next, PlanFor, Result, Snapshot, TaskDocument, TaskEntry } from './contract';
import type { Op } from './api';
import { indexOfLinks, touchedAreas } from './cross';
import { parsePrefs, type Prefs as FinishedPrefs } from './finished';
import { applyFilter, emptyFilter, moveSelection, type Filter } from './filter';
import { inboxOf, triageKey } from './inbox';
import { findingsByTask, groundOf, judgeFindings, type Finding, type Ground, type Judged } from './check';
import { assumeOf, changesOf, failedIdsOf, MATRIX_MAX, matrixIds, pruneDraft, withCell, type Draft } from './estimate';
import { moved, parseOrder } from './tiles';
import { bumped, parseFrecency, type Frecency } from './palette';
import { defaultView, nextView, parseViews, type CountKey, type CountView } from './counts';
import { conflictsOf, conflictsOfRequest, mergeConflicts, retryOp, type Conflict } from './conflicts';
import { backoffSeconds, readStream, StreamRefused, type SseMessage } from 'appkit-ui/sse';
import { detectLang, isLang, translate, type Key, type Lang } from './i18n';
import { localToday } from './remind';
import type { About } from './about';

/** The state of the Info dialog (APP-09). */
export type AboutState =
  | { state: 'closed' }
  | { state: 'loading'; focus: 'info' | 'report' }
  | { state: 'ok'; doc: About; focus: 'info' | 'report' }
  | { state: 'failed'; message: string };

/** The longest line of the notes the engine takes (`append_note`), in characters. */
const NOTE_MAX = 1000;

export type Phase = 'starting' | 'needs_pairing' | 'offline' | 'unavailable' | 'ready';
export type Connection = 'live' | 'reconnecting' | 'offline';
export type View = 'today' | 'list' | 'board' | 'plan' | 'inbox' | 'cross' | 'done';
export type Theme = 'auto' | 'light' | 'dark';
/** The blocks of the Today view that a person may hide. */
export const TILES = ['next', 'waiting', 'remind', 'cdx', 'counts'] as const;
export type Tile = (typeof TILES)[number];
/** The blocks of the column that can be put in another order (the counts have a column of their own). */
export const ORDERED_TILES = ['next', 'waiting', 'remind', 'cdx'] as const satisfies readonly Tile[];
export type OrderedTile = (typeof ORDERED_TILES)[number];

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
  /** Load the page again (after another vault was chosen); replaced in tests. */
  reload?(): void;
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
/** The pause between two looks for a check the hub started by itself, and how many looks. */
const CHECK_WAIT_MS = 15_000;
const CHECK_WAITS = 12;

const TILE_LABELS = { next: 'today.next', waiting: 'today.waiting', remind: 'remind.title', cdx: 'today.cdx' } as const;

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
  /** The last pairing code was refused (spent or older than its minute): the page says so and what to do. */
  pairRefused = $state(false);
  /** A code that arrived while the page was still starting: the pending start trades it. */
  private pendingCode: string | null = null;
  problem = $state<string | null>(null);
  connection = $state<Connection>('offline');
  view = $state<View>('today');
  lang = $state<Lang>('en');
  theme = $state<Theme>('auto');
  /** Single-key shortcuts; a person with assistive software may turn them off. */
  shortcuts = $state(true);
  filter = $state<Filter>({ ...emptyFilter, areas: [], statuses: [], actors: [], fields: {} });
  /** Blocks of the Today view the person put away. */
  hiddenTiles = $state<Tile[]>([]);
  tileOrder = $state<OrderedTile[]>([...ORDERED_TILES]);
  /** What a move of a block says to a screen reader. */
  tileNote = $state('');
  /** The number of the overview whose tasks are shown (none: closed). */
  countOpen = $state<CountKey | null>(null);
  /** The view chosen for each number; what is not here has the default. */
  countViews = $state<Partial<Record<CountKey, CountView>>>({});
  /** Area names without the prefix `wkdbook-` where that is unambiguous. */
  shortAreas = $state(true);
  /** The day of the reader, `YYYY-MM-DD`; renewed when the window is looked at again. */
  today = $state(localToday());
  /** Where the areas hang together, from the engine (null while it has not said, or when it cannot). */
  links = $state<Links | null>(null);
  /** The engine could not answer the last question for the links: the page reads the two kinds from the list. */
  linksFailed = $state(false);
  /** Whether the list shows the finished tasks under the open ones. */
  showFinished = $state(false);
  /** The period and the step the view of the finished tasks was left on. */
  finishedPrefs = $state<FinishedPrefs>(parsePrefs(null));
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
  /** The estimate matrix: the ids it holds (null: closed), what was chosen in it, and what the engine says it adds up to. */
  matrix = $state.raw<{ ids: string[] } | null>(null);
  matrixDraft = $state.raw<Draft>({});
  matrixFigures = $state.raw<Estimate | null>(null);
  /** Why the figures are not there (the engine's words), or null. */
  matrixProblem = $state<string | null>(null);
  /** The graph of one task in the plan view: which task, which way, what the engine says, and why it does not. */
  graph = $state.raw<{ id: string; direction: 'needs' | 'unlocks' } | null>(null);
  graphDoc = $state.raw<PlanFor | null>(null);
  graphProblem = $state<string | null>(null);
  /** The panel takes the focus once, when the graph is opened (not when it is drawn again after a change of view). */
  graphWantsFocus = false;
  /** The rev of the snapshot the graph on the screen was asked for. */
  private graphRev: string | undefined;
  private graphSeq = 0;
  /** The check dialog and the job behind it: what the hub says of it, and why it cannot say. */
  checking = $state(false);
  checkJob = $state.raw<CheckJobState | null>(null);
  checkProblem = $state<string | null>(null);
  /**
   * The ground of the check that is done: the versions of the tasks as they were when it was made, taken from the
   * snapshot of the same `rev` (the job's id says which check). Without it the check was made for a state the page
   * never saw whole (the vault changed while it ran), and its findings are not shown.
   */
  private checkGround = $state.raw<{ id: number; ground: Ground } | null>(null);
  /** The judged findings for one job, ground and list: judged once, not once for every row that asks. */
  private checkJudged: { job: CheckJobState; ground: Ground; tasks: readonly TaskEntry[]; judged: Judged; byTask: Map<string, Finding[]> } | null = null;
  private heldGrounds = new Map<string, Ground>();
  /** How often the page looked for a check the hub started by itself since the list last changed. */
  private checkWaits = 0;
  private checkTimer: ReturnType<typeof setTimeout> | undefined;
  /** The newest start or ask of the job: an older answer does not replace it. */
  private checkSeq = 0;
  /** The figures shown are for an older draft than the table: a question is due or under way. */
  matrixPending = $state(false);
  private matrixSeq = 0;
  private matrixTimer: ReturnType<typeof setTimeout> | undefined;
  private matrixAbort: AbortController | undefined;
  /** A card that goes to the blocked column and has no blocker yet, waiting for the person's answer. */
  blocking = $state.raw<{ id: string } | null>(null);
  /** The changes the engine refused because the file moved on: the conflict center lists them. */
  conflicts = $state.raw<Conflict[]>([]);
  /** The conflict center is open. */
  conflictsOpen = $state(false);
  /** The command palette is open. */
  palette = $state(false);
  /** What the palette's choices were, to put them first next time. */
  frecency = $state.raw<Frecency>({});
  /** The plan wizard is open. */
  planning = $state(false);
  /** The vaults the hub offers (null: none known, or the hub has no list). */
  vaultList = $state.raw<VaultList | null>(null);
  /** The dialog of the vaults is open. */
  managingVaults = $state(false);
  /** The Info dialog: closed, asking the hub, the words of the hub, or why it did not answer. */
  about = $state.raw<AboutState>({ state: 'closed' });
  /** Which opening of the Info dialog an answer belongs to (an older answer is thrown away). */
  private aboutSeq = 0;
  /** A vault is being chosen or changed: one at a time. */
  vaultBusy = $state(false);
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
    this.tileOrder = parseOrder(safe(() => env.prefs.getItem('tasks-desktop.tiles-order')), ORDERED_TILES);
    this.countViews = parseViews(safe(() => env.prefs.getItem('tasks-desktop.count-views')));
    this.frecency = parseFrecency(safe(() => env.prefs.getItem('tasks-desktop.frecency')));
    this.finishedPrefs = parsePrefs(safe(() => env.prefs.getItem('tasks-desktop.finished')));
    // The page opens on the view it was left on.
    const view = safe(() => env.prefs.getItem('tasks-desktop.view'));
    this.view =
      view === 'list' ||
      view === 'board' ||
      view === 'plan' ||
      view === 'inbox' ||
      view === 'cross' ||
      view === 'done'
        ? view
        : 'today';
  }

  // ── derived ───────────────────────────────────────────────────────────

  /** For every task the areas it touches (its own and those of the tasks it is linked with). */
  crossIndex = $derived.by(() => {
    const doc = this.linksNow;
    if (doc) return indexOfLinks(doc);
    // The engine will say: nothing is shown from the list meanwhile (it would be a second rule, and a flicker).
    if (this.linksPending) return new Map<string, Set<string>>();
    return touchedAreas(this.tasks);
  });

  /** The links of the state of the list that is shown, or null (an older state is never shown as the current one). */
  get linksNow(): Links | null {
    return this.links !== null && this.links.rev === this.snapshot?.rev ? this.links : null;
  }

  /** The engine has links and the answer for this state is still on its way. */
  get linksPending(): boolean {
    return this.capabilities !== null && this.can('links') && !this.linksFailed && this.linksNow === null;
  }

  get shown(): TaskEntry[] {
    return applyFilter(this.tasks, this.filter, this.today, this.crossIndex);
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

  /** Remember the period and the step of the view of the finished tasks. */
  setFinishedPrefs(prefs: FinishedPrefs): void {
    this.finishedPrefs = prefs;
    safe(() => this.env.prefs.setItem('tasks-desktop.finished', JSON.stringify(prefs)));
  }

  /** The finished tasks of the Backlogs and their figures, for the view of them. */
  finished(
    query: { area?: string; plan?: string; since?: string; until?: string; limit?: number; offset?: number },
    signal?: AbortSignal,
  ): Promise<Finished> {
    return this.env.hub.finished(query, signal);
  }

  /** Whether the engine can do `capability`; true while it has not said (the cached list is shown first). */
  can(capability: string): boolean {
    return this.capabilities === null || this.capabilities.includes(capability);
  }

  /** May the id of this task be kept in the browser? The class of its area decides, as for the cache. */
  private mayRemember(id: string): boolean {
    const task = this.tasks.find((t) => t.id === id);
    if (!task) return false;
    return cacheableClass(this.hubAreas.find((a) => a.name === task.area)?.data_class);
  }

  openConflicts(): void {
    if (this.conflicts.length > 0) this.conflictsOpen = true;
  }

  closeConflicts(): void {
    this.conflictsOpen = false;
  }

  /** Let a refused change go. */
  discardConflict(key: string): void {
    this.conflicts = this.conflicts.filter((c) => c.key !== key);
    if (this.conflicts.length === 0) this.conflictsOpen = false;
  }

  discardAllConflicts(): void {
    this.conflicts = [];
    this.conflictsOpen = false;
  }

  /**
   * Try a refused change again, on the version the task has now (the person has seen both and chose). It leaves the
   * list first; a second refusal puts it back as a new entry.
   */
  async retryConflict(key: string): Promise<void> {
    const conflict = this.conflicts.find((c) => c.key === key);
    // Not now (a write is under way, or the page is not connected): the entry stays, nothing is lost.
    if (!conflict || this.saving || this.phase !== 'ready') return;
    const op = retryOp(conflict, this.tasks.find((t) => t.id === conflict.id));
    if (op === null) return;
    this.conflicts = this.conflicts.filter((c) => c.key !== key);
    if (this.conflicts.length === 0) this.conflictsOpen = false;
    await this.write([op]);
  }

  openPalette(): void {
    if (this.phase === 'ready') this.palette = true;
  }

  closePalette(): void {
    this.palette = false;
  }

  /**
   * Remember that `key` (an action, or the task `taskId`) was chosen. A task is remembered only when its area
   * may be put in the browser: the id of a private or unclassified task would lie in the profile otherwise
   * (rules WEB-17 and SRV-21).
   */
  chose(key: string, taskId?: string): void {
    if (taskId !== undefined && !this.mayRemember(taskId)) return;
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
  async write(
    ops: Op[],
    opts: {
      undoable?: boolean;
      tags?: TagEdit;
      /**
       * Told the answer as soon as it is there, before the list is read again (which takes as long as the engine
       * does, and a busy machine makes it long). It returns true when it has said what came of the write itself.
       */
      onAnswer?: (result: Result) => boolean;
    } = {},
  ): Promise<Result | null> {
    if (this.saving || this.phase !== 'ready') return null;
    this.saving = true;
    this.answering = true;
    let settle!: () => void;
    this.settling = new Promise<void>((resolve) => (settle = resolve));
    try {
      const result = await this.env.hub.ops({ client_op_id: this.opId(), ops });
      this.answering = false;
      this.conflicts = mergeConflicts(this.conflicts, conflictsOf(ops, result, Date.now(), opts.tags));
      const failed = result.results.find((r) => !r.ok);
      if (opts.onAnswer?.(result)) {
        // said already
      } else if (failed) {
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
        this.conflicts = mergeConflicts(this.conflicts, conflictsOfRequest(ops, Date.now(), opts.tags));
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
      // Finishing is taken back by bringing the task back. What finishing set in motion beside the file (ticked steps,
      // closed plans) stays as it is, so with such effects no way back is offered rather than a half one.
      if (entry.op === 'done' && entry.id) {
        if ((entry.steps_ticked ?? 0) > 0 || (entry.plans_closed?.length ?? 0) > 0) return undefined;
        inverses.push({ op: 'reopen', id: entry.id });
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
      if (inv.op === 'tick_step') {
        if (typeof inv.n !== 'number') return undefined;
        inverses.push({
          op: 'tick_step',
          id: inv.id,
          n: inv.n,
          ...(typeof inv.done === 'boolean' ? { done: inv.done } : {}),
          ...(inv.if_match ? { if_match: inv.if_match } : {}),
        });
        continue;
      }
      if (inv.op === 'move_area') {
        if (typeof inv.to_area !== 'string') return undefined;
        inverses.push({ op: 'move_area', id: inv.id, to_area: inv.to_area, ...(inv.if_match ? { if_match: inv.if_match } : {}) });
        continue;
      }
      if (inv.op === 'set_body') {
        if (typeof inv.body !== 'string') return undefined;
        inverses.push({ op: 'set_body', id: inv.id, body: inv.body, ...(inv.if_match ? { if_match: inv.if_match } : {}) });
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
    // The list is read again inside the write and drops a selection that has no task any more: look before.
    const selectedBefore = this.selectedId;
    // A click while the write under way still re-reads the list is queued, not lost.
    if (this.settling) await this.settling;
    const result = await this.write(ops, {
      undoable: false,
      onAnswer: (answer) => {
        if (!answer.ok) return false;
        this.say('ok', 'write.undone');
        return true;
      },
    });
    // A move taken back: the task has its old id again, the selection follows it.
    const back = result?.results.find((r) => r.ok && r.outcome === 'moved' && typeof r.new_id === 'string');
    if (back?.new_id && ops.some((o) => o.op === 'move_area' && o.id === selectedBefore)) this.select(back.new_id);
    // Not sent at all (the page is not ready any more): say so, the toast is gone.
    if (!result && !this.toast) this.say('error', 'write.failed', { code: 'offline' });
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

  /**
   * Tick or untick step `n` of the plan section of a task. `etag` is the version of the file the steps were read from:
   * if the file moved on, the engine refuses and the numbers are not applied to another text.
   */
  async tickStep(id: string, n: number, done: boolean, etag?: string): Promise<void> {
    await this.write([{ op: 'tick_step', id, n, done, ...(etag ? { if_match: etag } : {}) }]);
  }

  /** Add one dated line to the notes of a task; says whether it was written (the box is emptied only then). */
  async addNote(id: string, text: string, etag?: string): Promise<boolean> {
    const result = await this.write(
      [{ op: 'append_note', id, text, ...(etag ? { if_match: etag } : {}) }],
      { undoable: false },
    );
    return result?.ok === true;
  }

  /**
   * Drop a task that will not be done: it is parked and the reason goes into its notes (the engine has no verb of its
   * own for it, and `done` would count it as finished). Two requests, one after the other: a batch does not stop at the
   * operation that failed, so a status that was refused (the file changed) would still get its note. The line is judged
   * before anything is written: the engine takes at most 1000 characters, and a status written without its note would be
   * half of it. Says whether both were written (the box is emptied only then).
   */
  async discard(id: string, reason: string, etag?: string): Promise<boolean> {
    const text = reason.trim();
    if (text === '') return false;
    const line = translate(this.lang, 'discard.note', { reason: text });
    if ([...line].length > NOTE_MAX) {
      this.say('error', 'discard.too_long', { n: NOTE_MAX });
      return false;
    }
    const parked = await this.write([
      { op: 'set', id, patch: { status: 'parked' }, ...(etag ? { if_match: etag } : {}) },
    ]);
    if (parked?.ok !== true) return false;
    // The note goes in under the version the status left; a failure of it is told by `write` and the task stays parked.
    return this.addNote(id, line);
  }

  /**
   * Ask the engine what moving `id` to `toArea` would break (a dry run: nothing is written). The report is the
   * engine's: a taken slug is a conflict in it, what names the old id is in `references`.
   */
  async previewMove(
    id: string,
    toArea: string,
    signal?: AbortSignal,
  ): Promise<{ kind: 'ok'; move: MovePlan } | { kind: 'refused'; message: string } | { kind: 'unknown' }> {
    try {
      const result = await this.env.hub.ops(
        { client_op_id: this.opId(), dry_run: true, ops: [{ op: 'move_area', id, to_area: toArea }] },
        signal,
      );
      const entry = result.results[0];
      if (entry?.move) return { kind: 'ok', move: entry.move };
      return { kind: 'refused', message: entry?.error?.message ?? '' };
    } catch (error) {
      if (error instanceof ApiError && error.status === 400) {
        return { kind: 'refused', message: error.message };
      }
      return { kind: 'unknown' };
    }
  }

  /**
   * Move `id` to `toArea`: the id changes, what named the old id names the new one, all or nothing (the engine).
   * `etag` is the version of the file that was shown. The selection follows the task. Taking it back is the inverse
   * the engine gave. Says whether it was written.
   */
  async moveArea(id: string, toArea: string, etag?: string): Promise<boolean> {
    const selectedBefore = this.selectedId;
    const result = await this.write([
      { op: 'move_area', id, to_area: toArea, ...(etag ? { if_match: etag } : {}) },
    ]);
    const entry = result?.results[0];
    if (!entry?.ok || entry.outcome !== 'moved' || typeof entry.new_id !== 'string') return false;
    if (selectedBefore === id) this.select(entry.new_id);
    return true;
  }

  /**
   * Replace the text of a task by `text`. `etag` is the version of the file the text was read from: if the file moved
   * on, the engine refuses and the draft stays with the person. Says whether it was written (the editor closes only then).
   */
  async setBody(id: string, text: string, etag?: string): Promise<boolean> {
    const result = await this.write([{ op: 'set_body', id, body: text, ...(etag ? { if_match: etag } : {}) }]);
    return result?.ok === true;
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
    // Said as soon as the answer is there: the re-read of the list that follows takes as long as the engine does.
    const onAnswer = (result: Result): boolean => {
      // A failed entry names its operation (`n`), not always the task: the position in the batch says which one.
      const failedIds = new Set<string>();
      for (const r of result.results) {
        if (r.ok) continue;
        const id = ops[r.n - 1]?.id ?? (r.error?.details as { id?: unknown } | undefined)?.id;
        if (typeof id === 'string') failedIds.add(id);
      }
      if (result.results.some((r) => !r.ok) && failedIds.size === 0) {
        // Which tasks failed is not known: the toast of the write says why, and nothing is taken off the marks.
        return false;
      }
      this.marks = this.marks.filter((id) => !sent.has(id) || failedIds.has(id));
      const undo = this.inverseOf(result);
      if (failedIds.size === 0) {
        this.say('ok', 'bulk.saved', { n: ops.length }, undo);
      } else {
        this.say('error', 'bulk.partial', { done: ops.length - failedIds.size, failed: failedIds.size }, undo);
      }
      return true;
    };
    await this.write(ops, { ...(tags ? { tags } : {}), onAnswer });
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
  // ── the check of the vault, as a job ───────────────────────────────────

  /**
   * Take what the hub says of the job. A check that is done for the state the page shows gets its ground: the
   * versions of the tasks now, which are the versions it read (same `rev`). A done check whose `rev` the page does
   * not hold yet is grounded when the list that matches it is read (`readOnce`).
   */
  private adoptCheck(job: CheckJobState): void {
    if (job.state === 'running') this.checkWaits = 0;
    this.checkJob = job;
    this.groundCheck();
  }

  private groundCheck(): void {
    const job = this.checkJob;
    // Also a check that is done: the hub may run the next one by itself, and the page never sees it run.
    this.holdGround(job !== null);
    if (job?.state !== 'done' || this.checkGround?.id === job.id) return;
    // The page may have read a newer list before it saw the job done: the ground of the rev the check read was held
    // while the job ran.
    const ground = job.result.rev === this.snapshot?.rev ? groundOf(this.tasks) : this.heldGrounds.get(job.result.rev);
    if (ground === undefined) return;
    this.checkGround = { id: job.id, ground };
    this.heldGrounds.clear();
  }

  /** While a job runs, keep the versions of the list the page holds: the check may be made for any of them. */
  private holdGround(running: boolean): void {
    const rev = this.snapshot?.rev;
    if (!running || rev === undefined || this.heldGrounds.has(rev)) return;
    if (this.heldGrounds.size >= 8) this.heldGrounds.clear();
    this.heldGrounds.set(rev, groundOf(this.tasks));
  }

  /** The findings judged against the tasks as they are now (see `lib/check.ts`); nothing for a check without ground. */
  private judged(): { judged: Judged; byTask: Map<string, Finding[]> } {
    const job = this.checkJob;
    const grounded = this.checkGround;
    if (job?.state !== 'done' || grounded?.id !== job.id) return { judged: { valid: [], stale: [], changed: 0 }, byTask: new Map() };
    const memo = this.checkJudged;
    if (memo && memo.job === job && memo.ground === grounded.ground && memo.tasks === this.tasks) return memo;
    const judged = judgeFindings(job.result.findings, grounded.ground, this.tasks);
    const next = { job, ground: grounded.ground, tasks: this.tasks, judged, byTask: findingsByTask(judged.valid) };
    this.checkJudged = next;
    return next;
  }

  /** The findings that hold: of tasks as they were when the check was made, and of what is no listed task. */
  get checkFindings(): Finding[] {
    return this.judged().judged.valid;
  }

  /** The findings of tasks that changed since the check: possibly resolved, shown as such. */
  get checkStale(): Finding[] {
    return this.judged().judged.stale;
  }

  /** How many tasks with findings changed or went away since the check. */
  get checkChanged(): number {
    return this.judged().judged.changed;
  }

  /** The findings that hold about the task `id`. */
  findingsFor(id: string): Finding[] {
    return this.judged().byTask.get(id) ?? [];
  }

  /** Whether the check that is done was made for a state the page never held (the vault changed while it ran). */
  get checkOutdated(): boolean {
    const job = this.checkJob;
    return job?.state === 'done' && this.checkGround?.id !== job.id;
  }

  /** Open the check dialog on what the hub knows of the job. */
  async openChecks(): Promise<void> {
    if (this.phase !== 'ready' || !this.can('check')) return;
    this.checking = true;
    await this.pollCheck();
  }

  closeChecks(): void {
    this.checking = false;
  }

  /** Start the check; it runs in the hub and the page goes on. */
  async runCheck(refs: boolean): Promise<void> {
    this.checkProblem = null;
    this.checkSeq += 1;
    const seq = this.checkSeq;
    // The check reads the list the page holds now (or a later one): its ground is kept for when the job is done.
    this.holdGround(true);
    try {
      const job = await this.env.hub.checkStart(refs ? { stale: 'refs' } : {});
      if (seq !== this.checkSeq) return;
      this.adoptCheck(job);
    } catch (error) {
      if (seq !== this.checkSeq) return;
      this.checkProblem = error instanceof ApiError ? error.message : translate(this.lang, 'check.failed');
      return;
    }
    this.watchCheck();
  }

  /** Ask for the state of the job, and again a second later while it runs. */
  private async pollCheck(): Promise<void> {
    clearTimeout(this.checkTimer);
    this.checkSeq += 1;
    const seq = this.checkSeq;
    try {
      const job = await this.env.hub.checkState();
      if (seq !== this.checkSeq) return;
      this.adoptCheck(job);
      this.checkProblem = null;
    } catch (error) {
      if (seq !== this.checkSeq) return;
      this.checkProblem = error instanceof ApiError ? error.message : translate(this.lang, 'check.failed');
      // A job that was running may well still run: one failed question ends neither it nor the asking. The next
      // try is a little later (the hub may be busy), and the run button is not held back by the old state.
      if (this.checkJob?.state === 'running' && this.phase === 'ready') {
        this.checkTimer = setTimeout(() => void this.pollCheck(), 3000);
      }
      return;
    }
    this.watchCheck();
  }

  private watchCheck(): void {
    clearTimeout(this.checkTimer);
    if (this.phase !== 'ready') return;
    const job = this.checkJob;
    if (job?.state === 'running') {
      this.checkTimer = setTimeout(() => void this.pollCheck(), 1000);
    } else if (job?.state === 'done' && job.result.rev !== this.snapshot?.rev && this.checkWaits < CHECK_WAITS) {
      // The vault changed since the check. The hub runs it again by itself after a quiet time (and a gap since the last
      // one), so the page looks now and then for a job it did not start; it gives up after a while, since the hub may
      // not run it (no client at the time, a check with refs, a vault that never rests).
      this.checkWaits += 1;
      this.checkTimer = setTimeout(() => void this.pollCheck(), CHECK_WAIT_MS);
    }
  }

  // ── the graph of a task ────────────────────────────────────────────────

  /** Show what `id` needs (or what waits for it) in the plan view. */
  openGraph(id: string, direction: 'needs' | 'unlocks' = 'needs'): void {
    if (this.phase !== 'ready' || !this.can('plan_for')) return;
    this.graph = { id, direction };
    this.graphDoc = null;
    this.graphProblem = null;
    this.graphWantsFocus = true;
    this.setView('plan');
    void this.askGraph();
  }

  closeGraph(): void {
    this.graphSeq += 1;
    this.graph = null;
    this.graphDoc = null;
    this.graphProblem = null;
  }

  /** Ask again for the graph that is open, after the vault changed (the old one stays until the new one is there). */
  reloadGraph(): void {
    if (this.graph && this.graphDoc !== null && this.snapshot?.rev !== this.graphRev) void this.askGraph();
  }

  private async askGraph(): Promise<void> {
    const graph = this.graph;
    if (!graph) return;
    this.graphSeq += 1;
    const seq = this.graphSeq;
    this.graphRev = this.snapshot?.rev;
    try {
      const doc = await this.env.hub.planFor(graph.id, graph.direction);
      if (seq !== this.graphSeq || !this.graph) return;
      this.graphDoc = doc;
      this.graphProblem = null;
    } catch (error) {
      if (seq !== this.graphSeq || !this.graph) return;
      // The engine's words, as they are (a task that is finished meanwhile is "no such open task"); the list that was
      // there is not left standing under them.
      this.graphDoc = null;
      this.graphProblem = error instanceof ApiError ? error.message : translate(this.lang, 'graph.failed');
    }
  }

  // ── the estimate matrix ───────────────────────────────────────────────

  /** Open the matrix on the marked tasks, else on those the list shows. */
  openMatrix(): void {
    // One that is open keeps its draft: a second call (the palette) does not throw the choices away.
    if (this.phase !== 'ready' || !this.can('estimate') || this.matrix) return;
    const ids = matrixIds(this.marks, this.shown);
    if (ids.length === 0) {
      this.say('ok', 'matrix.none');
      return;
    }
    const wanted = this.marks.length > 0 ? this.marks.length : this.shown.length;
    if (wanted > MATRIX_MAX) this.say('ok', 'matrix.cut', { n: MATRIX_MAX, total: wanted });
    this.matrix = { ids };
    this.matrixDraft = {};
    this.matrixFigures = null;
    this.matrixProblem = null;
    void this.askFigures();
  }

  closeMatrix(): void {
    clearTimeout(this.matrixTimer);
    this.matrixAbort?.abort();
    this.matrixSeq += 1;
    this.matrixPending = false;
    this.matrix = null;
    this.matrixDraft = {};
    this.matrixFigures = null;
    this.matrixProblem = null;
  }

  /** The tasks of the matrix that are still there, in the order they were asked for. */
  get matrixRows(): TaskEntry[] {
    const ids = this.matrix?.ids ?? [];
    const byId = new Map(this.tasks.map((t) => [t.id, t] as const));
    return ids.flatMap((id) => {
      const task = byId.get(id);
      return task ? [task] : [];
    });
  }

  /** How many tasks the draft would change (a cell equal to its file changes nothing). */
  get matrixChanges(): number {
    return changesOf(this.matrixRows, this.matrixDraft).length;
  }

  /** Choose a cell (or put it back with `undefined`); the figures are asked for again a moment later. */
  setCell(id: string, field: 'effort' | 'value', value: string | number | undefined): void {
    if (!this.matrix) return;
    const task = this.tasks.find((t) => t.id === id);
    this.matrixDraft = withCell(this.matrixDraft, id, field, value, task?.etag);
    // What was asked for the older draft is no answer to this one: it is dropped at once, not when the next
    // question starts, and the figures say they are being reckoned.
    this.matrixAbort?.abort();
    this.matrixSeq += 1;
    this.matrixPending = true;
    clearTimeout(this.matrixTimer);
    this.matrixTimer = setTimeout(() => void this.askFigures(), 250);
  }

  private async askFigures(): Promise<void> {
    if (!this.matrix) return;
    // The tasks that are there now: one that was finished or moved meanwhile would make the engine refuse every
    // question from here on (`no open task`), so it leaves the question and the draft.
    const ids = this.matrixRows.map((t) => t.id);
    this.matrixDraft = pruneDraft(this.matrixDraft, ids);
    this.matrixAbort?.abort();
    const abort = new AbortController();
    this.matrixAbort = abort;
    this.matrixSeq += 1;
    const seq = this.matrixSeq;
    if (ids.length === 0) {
      this.matrixFigures = null;
      this.matrixPending = false;
      return;
    }
    const assume = assumeOf(this.matrixDraft, ids);
    try {
      const figures = await this.env.hub.estimate({ ids, ...(assume.length > 0 ? { assume } : {}) }, abort.signal);
      // An older answer does not replace a newer question's.
      if (seq !== this.matrixSeq || !this.matrix) return;
      this.matrixFigures = figures;
      this.matrixProblem = null;
      this.matrixPending = false;
    } catch (error) {
      if (seq !== this.matrixSeq || !this.matrix || abort.signal.aborted) return;
      this.matrixPending = false;
      // The engine's words, as they are: the page does not interpret them.
      this.matrixProblem = error instanceof ApiError ? error.message : translate(this.lang, 'matrix.failed');
    }
  }

  /**
   * Write the cells that differ from the files, in one batch, each task with the version that was shown. A task that
   * changed meanwhile fails alone and stays in the matrix with its cells; the others are written and leave the draft.
   */
  async applyMatrix(): Promise<void> {
    const ops = changesOf(this.matrixRows, this.matrixDraft);
    if (ops.length === 0) {
      this.say('ok', 'bulk.nothing');
      return;
    }
    const onAnswer = (result: Result): boolean => {
      const failed = failedIdsOf(ops, result.results);
      if (failed === null) return false;
      const sent = new Set(ops.map((o) => ('id' in o ? o.id : '')));
      const rest: Draft = {};
      for (const [id, cell] of Object.entries(this.matrixDraft)) {
        if (!sent.has(id)) {
          rest[id] = cell;
        } else if (failed.has(id)) {
          // The row shows the task as it is now (the list is read next): its cells are written with that version,
          // not with the old one, which would conflict again for ever.
          const { etag: _old, ...kept } = cell;
          rest[id] = kept;
        }
      }
      const undo = this.inverseOf(result);
      if (failed.size === 0) {
        this.say('ok', 'bulk.saved', { n: ops.length }, undo);
        this.closeMatrix();
      } else {
        this.matrixDraft = rest;
        this.say('error', 'bulk.partial', { done: ops.length - failed.size, failed: failed.size }, undo);
        void this.askFigures();
      }
      return true;
    };
    await this.write(ops, { onAnswer });
  }

  async confirmRepriority(): Promise<void> {
    const asking = this.repriority;
    if (!asking) return;
    this.repriority = null;
    await this.write(asking.ops);
  }

  /**
   * A key or a drop of the board or the inbox that would write while a write is under way: it is refused aloud (an
   * error toast, in the alert region) instead of being dropped without a word. It is deliberately not buffered: a key
   * kept for later would act on a list the person has not seen yet (the write under way may move the card, or sort
   * the task out of the inbox). Nothing is drawn for the refused move: the board only ever shows the engine's state.
   */
  private refusedWhileSaving(): boolean {
    if (!this.saving || this.phase !== 'ready') return false;
    this.say('error', 'write.busy');
    return true;
  }

  /** `id` dropped on `target`: before or after it. */
  async dropNear(id: string, target: { id: string; place: 'before' | 'after' }): Promise<void> {
    if (this.refusedWhileSaving()) return;
    await this.moveCard(placeNear(this.tasks, id, target, this.can('eff_prio')));
  }

  /** `id` one place up or down inside its group (`K` and `J`). */
  async stepCard(id: string, dir: 1 | -1): Promise<void> {
    const task = this.tasks.find((t) => t.id === id);
    // A card the filter hides is not moved behind the person's back.
    if (!task || !isColumn(task.status) || !this.shown.some((t) => t.id === id)) return;
    if (this.refusedWhileSaving()) return;
    await this.moveCard(stepInGroup(this.board[task.status], id, dir));
  }

  /** `id` into the column of `status` (a drop on a column, `H` and `L`). */
  async dropOnColumn(id: string, status: string): Promise<void> {
    const task = this.tasks.find((t) => t.id === id);
    if (!task || task.status === status || !isColumn(status)) return;
    if (this.refusedWhileSaving()) return;
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
    if (this.refusedWhileSaving()) return;
    await this.startFinish(id);
  }

  /** `id` one column to the left or right. */
  async shiftColumn(id: string, dir: 1 | -1): Promise<void> {
    const task = this.tasks.find((t) => t.id === id);
    if (!task || !this.shown.some((t) => t.id === id)) return;
    if (this.refusedWhileSaving()) return;
    const to = neighbourColumn(task.status, dir);
    if (to) await this.dropOnColumn(id, to);
    // Past the last column lies the strip the mouse drops on to finish: the keyboard gets the same way (with the preview).
    else if (dir === 1) await this.startFinish(id);
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

  async createTask(
    area: string,
    title: string,
    fields: Record<string, unknown> = {},
    body = '',
  ): Promise<void> {
    const text = body.trim();
    const result = await this.write(
      [
        {
          op: 'new',
          area,
          title,
          ...(Object.keys(fields).length > 0 ? { fields } : {}),
          // A text replaces the sections of the template; none keeps them.
          ...(text !== '' ? { body: text } : {}),
        },
      ],
      { undoable: false },
    );
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
      // The way back is to bring the task back (see `inverseOf`).
    );
  }

  /** Show the file of a task in Neovim. The hub starts the window; the answer says when it could not. */
  async openInEditor(id: string): Promise<void> {
    try {
      await this.env.hub.openInEditor(id);
      this.say('ok', 'editor.opened');
    } catch (error) {
      const message = error instanceof ApiError ? error.message : '';
      this.say('error', 'editor.failed', { message });
    }
  }

  /** Bring a finished task back (the reminder of a finished task offers it). */
  async reopen(id: string): Promise<void> {
    await this.write([{ op: 'reopen', id }], { undoable: false });
  }

  setShortAreas(on: boolean): void {
    this.shortAreas = on;
    safe(() => this.env.prefs.setItem('tasks-desktop.short-areas', on ? 'on' : 'off'));
  }

  /** Take every chosen area, status and actor and the search words away. */
  resetFilter(): void {
    this.filter = { ...emptyFilter, areas: [], statuses: [], actors: [], fields: {} };
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

  /** The view a number shows its tasks in. */
  countView(key: CountKey): CountView {
    return this.countViews[key] ?? defaultView(key);
  }

  /** Open the tasks behind a number, or close them when they are open. */
  toggleCount(key: CountKey): void {
    this.countOpen = this.countOpen === key ? null : key;
  }

  closeCount(): void {
    this.countOpen = null;
  }

  setCountView(key: CountKey, view: CountView): void {
    this.countViews = { ...this.countViews, [key]: view };
    safe(() => this.env.prefs.setItem('tasks-desktop.count-views', JSON.stringify(this.countViews)));
  }

  /**
   * The key `v` on a number: a number that is closed opens in the view it has (the first press shows what the number
   * holds, it does not skip a view); one that is open goes on to its next view.
   */
  cycleCountView(key: CountKey): void {
    if (this.countOpen !== key) {
      this.countOpen = key;
      return;
    }
    this.setCountView(key, nextView(key, this.countView(key)));
  }

  /** The tasks of a number in the list, with the status filter that fits (only "doing" and "blocked" have one). */
  openCountInList(key: CountKey): void {
    if (key !== 'doing' && key !== 'blocked') return;
    this.filter = { ...emptyFilter, areas: [], statuses: [key], actors: [], fields: {} };
    this.setView('list');
  }

  /** Put the block `tile` before (or after) `target`; `visible` are the blocks on the page, for the number said aloud. */
  moveTile(tile: OrderedTile, target: OrderedTile, after: boolean, visible: readonly OrderedTile[]): void {
    const order = moved(this.tileOrder, tile, target, after);
    if (order.every((t, i) => t === this.tileOrder[i])) return;
    this.tileOrder = order;
    this.saveOrder();
    const now = order.filter((t) => visible.includes(t));
    this.tileNote = translate(this.lang, 'today.moved', {
      tile: translate(this.lang, TILE_LABELS[tile]),
      n: now.indexOf(tile) + 1,
      total: now.length,
    });
  }

  /** The blocks are not in the standard order (what "reset the order" would change). */
  get tileOrderChanged(): boolean {
    return this.tileOrder.some((tile, i) => tile !== ORDERED_TILES[i]);
  }

  resetTileOrder(): void {
    this.tileOrder = [...ORDERED_TILES];
    this.saveOrder();
    this.tileNote = translate(this.lang, 'today.order_reset');
  }

  private saveOrder(): void {
    safe(() => this.env.prefs.setItem('tasks-desktop.tiles-order', JSON.stringify(this.tileOrder)));
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
    if (code) this.pendingCode = code;
    let stored = safe(() => this.env.session.getItem(TOKEN_KEY));
    // The session of the tab was handed to the client: when it is gone from it later, the hub refused it.
    let given = false;

    // The first picture comes from the cache, before the hub has answered
    // (and when it does not). Only a tab that was paired shows one. A cache
    // that does not answer in a moment is a miss.
    if (stored) {
      const cached = await within(this.env.cache.load(), 1500);
      if (cached && this.tasks.length === 0) {
        // The views are drawn from here on and ask the hub at once (the view the page was left on): they carry the
        // session of this tab. Without it their first question is refused and the page believes the session is lost.
        this.env.hub.setToken(stored);
        this.env.hub.onUnauthorized = () => this.lostSession();
        given = true;
        this.tasks = cached.tasks;
        this.cachedAt = cached.savedAt;
        this.phase = 'ready';
        // The list is of the vault the hub read when it was saved. A hub that reads another one now (chosen in another
        // tab, or its settings changed) would answer the views of this page for that vault beside a list of the old
        // one. The first picture does not wait for the hub (that is the use of the cache); the hub is asked at once
        // (no engine, a moment) and a list of another vault is taken away as soon as it says so.
        void this.dropCacheOfAnotherVault(cached);
      }
    }

    for (;;) {
      try {
        const hello = await this.env.hub.hello();
        if (!hello.engine.ready) {
          this.problem = hello.engine.problem ?? 'unknown';
          // A tab that was paired keeps its session here too: the Info dialog and its report (the hub answers
          // them without an engine) are for exactly this page. A session that is gone is told by the first 401.
          if (stored && given && !this.env.hub.hasToken) stored = null;
          else if (stored && !this.env.hub.hasToken) {
            this.env.hub.setToken(stored);
            this.env.hub.onUnauthorized = () => this.lostSession();
            given = true;
          }
          this.phase = 'unavailable';
          await this.env.sleep(5000);
          if (this.stopped) return;
          continue;
        }
        // An engine that is not there says nothing about what it can do.
        this.capabilities = hello.engine.capabilities;
        // A board left open by an older engine would offer what it refuses.
        if (this.view === 'board' && !this.can('reorder')) this.view = 'today';
        if (this.view === 'done' && !this.can('finished')) this.view = 'today';
        break;
      } catch {
        this.connection = 'offline';
        // A list from the cache stays on the screen: that is its use.
        if (this.tasks.length === 0) this.phase = 'offline';
        await this.env.sleep(3000);
        if (this.stopped) return;
      }
    }

    // A session the hub refused while this waited is not the one to go on with.
    if (stored && given && !this.env.hub.hasToken) stored = null;
    let token = stored;
    // The code of the address, or a newer one that was pasted while this waited for the hub or for the answer
    // to the one before. A code that works ends it; one that is refused makes room for the next.
    let offered = this.pendingCode;
    this.pendingCode = null;
    let refused = false;
    while (offered) {
      try {
        const fresh = await this.env.hub.exchange(offered);
        safe(() => this.env.session.setItem(TOKEN_KEY, fresh));
        token = fresh;
        this.pendingCode = null;
        break;
      } catch (error) {
        // A code that is spent or too old: the session of this tab, if it has one, is still good. Only a
        // refusal of the hub (a 4xx) says "used up or too old"; a hub that did not answer says nothing of it.
        refused = error instanceof ApiError && error.status >= 400 && error.status < 500;
      }
      offered = this.pendingCode;
      this.pendingCode = null;
    }
    // Said only when the code left the tab without a session.
    this.pairRefused = !token && refused;
    if (!token) {
      this.phase = 'needs_pairing';
      this.tasks = [];
      this.cachedAt = null;
      return;
    }
    this.env.hub.setToken(token);
    this.sessionHeld = true;
    this.env.hub.onUnauthorized = () => this.lostSession();

    await this.refresh();
    if (!this.env.hub.hasToken || this.stopped) return;
    void this.followStream();
  }

  /**
   * A pairing code that arrives after the page was loaded (a link pasted into the tab that is open: the
   * browser then changes only the fragment and does not reload). Without a session it is traded at once; a
   * page that is still starting picks it up when it gets there; a paired page keeps its session.
   */
  offerCode(code: string): void {
    if (this.sessionHeld) return;
    this.pendingCode = code;
    if (this.phase === 'needs_pairing') void this.start(code);
  }

  stop(): void {
    this.stopped = true;
    this.checkSeq += 1;
    this.matrixSeq += 1;
    this.graphSeq += 1;
    clearTimeout(this.checkTimer);
    clearTimeout(this.matrixTimer);
    this.abort?.abort();
  }

  /** The session of this tab was confirmed (a token held for the cached list only is not that). */
  private sessionHeld = false;

  private lostSession(): void {
    this.sessionHeld = false;
    // The loss is not about a code that was refused at the start.
    this.pairRefused = false;
    // What was asked of the hub is not valid without the session: the dialogs and the graph close, the job is forgotten.
    this.closeGraph();
    this.closeMatrix();
    this.closeChecks();
    this.checkSeq += 1;
    this.checkJob = null;
    clearTimeout(this.checkTimer);
    safe(() => this.env.session.removeItem(TOKEN_KEY));
    this.env.hub.setToken(null);
    this.abort?.abort();
    this.phase = 'needs_pairing';
    this.connection = 'offline';
    this.tasks = [];
    this.snapshot = null;
    this.checkJob = null;
    this.checkGround = null;
    this.heldGrounds.clear();
    this.next = null;
    this.nextFor = null;
    this.hubAreas = [];
    this.links = null;
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
        this.groundCheck();
        this.checkWaits = 0;
        this.watchCheck();
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
      // The list is kept with the vault the hub reads, so that a start can tell a list of another vault.
      await this.loadVaults();
      if (list) void this.env.cache.save({ ...list, hubVault: this.vaultList?.active ?? null });
      else void this.env.cache.clear();
    } catch {
      // No classes, no cache: nothing is written.
    }
    void this.loadLinks();
    if (this.view === 'today') await this.loadNext();
  }

  /** The rev the links are being asked for. */
  private linksAsked: string | null = null;

  /** The links between areas, once per state of the vault. An engine without them leaves the page to read them from the list. */
  private async loadLinks(): Promise<void> {
    const rev = this.snapshot?.rev;
    if (!this.can('links') || this.capabilities === null || rev === undefined || this.links?.rev === rev) return;
    // One question per state: a read that arrives while the answer is on its way does not ask again.
    if (this.linksAsked === rev) return;
    this.linksAsked = rev;
    try {
      const doc = await this.env.hub.links();
      // An answer for a state that has gone by meanwhile is not kept; the next read asks again.
      if (this.snapshot?.rev === doc.rev) {
        this.links = doc;
        this.linksFailed = false;
      }
    } catch {
      // The links read from the list stand in, and no older state of the engine's answer is shown.
      this.links = null;
      this.linksFailed = true;
    } finally {
      if (this.linksAsked === rev) this.linksAsked = null;
    }
  }

  /** The areas a task touches when that is more than its own (from the links), else none. */
  crossAreas(id: string): string[] {
    const touched = this.crossIndex.get(id);
    return touched && touched.size >= 2 ? [...touched].sort() : [];
  }

  /** Read the list of vaults; a hub without one (404) simply has no menu entries. */
  /** Take the cached list away when the hub names another vault than the one it was saved of. */
  private async dropCacheOfAnotherVault(cached: CachedList): Promise<void> {
    let now: { name: string | null };
    try {
      now = await this.hubVaultName();
    } catch {
      return; // A hub that does not answer says nothing against the list.
    }
    if (cached.hubVault === undefined || now.name === cached.hubVault) return;
    void this.env.cache.clear();
    // Only while the cached list is what is shown: a list the hub sent meanwhile stays.
    if (this.cachedAt !== cached.savedAt) return;
    this.tasks = [];
    this.cachedAt = null;
    this.select(null);
    this.marks = [];
    this.phase = 'starting';
  }

  /** The name of the vault the hub reads now (`null`: a hub with one vault and no list); fails when the hub does not answer. */
  private async hubVaultName(): Promise<{ name: string | null }> {
    try {
      return { name: (await this.env.hub.vaults()).active };
    } catch (error) {
      if (error instanceof ApiError && error.status === 404) return { name: null };
      throw error;
    }
  }

  async loadVaults(): Promise<void> {
    try {
      this.vaultList = await this.env.hub.vaults();
    } catch {
      this.vaultList = null;
    }
  }

  /** Open the Info dialog (APP-09); `focus` says what the person came for, so that the keyboard lands there. */
  /**
   * The Info dialog is for a running page and for the page whose engine is not there: that is when a report is
   * needed most, and the hub answers `about` without an engine. It needs a session, so the phases before pairing
   * are out.
   */
  get canAbout(): boolean {
    return this.phase === 'ready' || (this.phase === 'unavailable' && this.env.hub.hasToken);
  }

  openAbout(focus: 'info' | 'report' = 'info'): void {
    if (!this.canAbout) return;
    this.aboutSeq += 1;
    this.about = { state: 'loading', focus };
    void this.loadAbout(focus, this.aboutSeq);
  }

  closeAbout(): void {
    // An answer that is still on its way belongs to this opening, not to the next one.
    this.aboutSeq += 1;
    this.about = { state: 'closed' };
  }

  private async loadAbout(focus: 'info' | 'report', seq: number): Promise<void> {
    try {
      const doc = await this.env.hub.about();
      if (seq === this.aboutSeq) this.about = { state: 'ok', doc, focus };
    } catch (error) {
      if (seq === this.aboutSeq) {
        this.about = { state: 'failed', message: error instanceof Error ? error.message : String(error) };
      }
    }
  }

  openVaults(): void {
    if (this.phase === 'ready' && this.vaultList) this.managingVaults = true;
  }

  closeVaults(): void {
    this.managingVaults = false;
  }

  private async vaultStep(work: () => Promise<void>, ok?: Key): Promise<boolean> {
    if (this.vaultBusy) return false;
    this.vaultBusy = true;
    try {
      await work();
      if (ok) this.say('ok', ok);
      return true;
    } catch (error) {
      const message = error instanceof ApiError ? error.message : '';
      this.say('error', 'vaults.failed', { message });
      return false;
    } finally {
      this.vaultBusy = false;
    }
  }

  /** Read another vault. What the page holds of the old one (the list, the cache) goes; the page loads again. */
  async selectVault(name: string): Promise<void> {
    if (this.vaultList?.active === name) return;
    const done = await this.vaultStep(async () => {
      await this.env.hub.selectVault(name);
      // The list that is cached belongs to the vault that was left.
      await this.env.cache.clear();
    });
    if (done) (this.env.reload ?? (() => undefined))();
  }

  async addVault(name: string, path: string): Promise<boolean> {
    const done = await this.vaultStep(async () => {
      await this.env.hub.addVault(name.trim(), path.trim());
      this.vaultList = await this.env.hub.vaults();
    }, 'vaults.added');
    return done;
  }

  async removeVault(name: string): Promise<void> {
    await this.vaultStep(async () => {
      await this.env.hub.removeVault(name);
      this.vaultList = await this.env.hub.vaults();
    }, 'vaults.removed');
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
    if (view === 'inbox') this.ensureInboxSelection(true);
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

  /** The tasks the inbox view shows: those that lack a priority, an effort or a written actor. */
  get inbox(): TaskEntry[] {
    return inboxOf(this.tasks);
  }

  moveSelectionInbox(delta: number): void {
    const id = moveSelection(this.inbox, this.selectedId, delta);
    if (id !== null && id !== this.selectedId) this.select(id);
  }

  /**
   * A key of the inbox: write the field it names on the selected task. Nothing is sent while another write is under
   * way, or for a key that names nothing. When the task is sorted by it and leaves the inbox, the selection stays
   * at the same place, on the task that took its row.
   */
  async triage(key: string, shift: boolean): Promise<void> {
    const choice = triageKey(key, shift);
    const id = this.selectedId;
    if (!choice || id === null || this.phase !== 'ready') return;
    if (this.refusedWhileSaving()) return;
    const before = this.inbox;
    const at = before.findIndex((t) => t.id === id);
    if (at === -1) return;
    await this.setField(id, choice.field, choice.value);
    const after = this.inbox;
    // Only when the person is still on that task: a click or a j made during the write is theirs.
    if (this.selectedId === id && !after.some((t) => t.id === id)) {
      this.select(after[Math.min(at, after.length - 1)]?.id ?? null);
    }
  }

  /**
   * Put the selection on a row of the inbox when it is on a task that left it (sorted elsewhere, in Neovim), and, when
   * the view is entered (`entering`), also when it is on none. A selection of none that the person made (Escape) is
   * left alone by a later change of the rows. Not while a write is under way: `triage` knows where the selection goes.
   */
  ensureInboxSelection(entering = false): void {
    if (this.saving) return;
    const rows = this.inbox;
    if (rows.length === 0) return;
    const gone = this.selectedId !== null && !rows.some((t) => t.id === this.selectedId);
    if (gone || (entering && this.selectedId === null)) this.select(rows[0]?.id ?? null);
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
    // Not before the hub has confirmed the session: a page on the cached list holds the token already.
    if (this.phase !== 'ready' || !this.sessionHeld) return;
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
