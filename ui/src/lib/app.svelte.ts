// The state of the page and what keeps it true: pairing, the held list, the
// event stream and the detail of the selected task.

import {
  MOVE_MAX,
  type MoveCheck,
  type TagEdit,
  bulkMoveOps,
  bulkSetOps,
  followMoves,
  markAll,
  moveChecks,
  moveOrder,
  moveUndo,
  pruneMarks,
  toggleMark,
} from './bulk';
import { planOp, type PlanForm, type PlanPreview } from './planwizard';
import { columnsOf, isColumn, neighbourColumn, placeNear, stepInGroup, type Move } from './board';
import { ApiError, type Hub, type HubArea, type HubAreas, type SearchResult, type VaultList } from './api';
import { cacheableClass, cacheableList, type CachedList, type ListStore } from './cache';
import type {
  DonePreview,
  Finished,
  Links,
  MovePlan,
  Next,
  Result,
  Snapshot,
  TaskDocument,
  TaskEntry,
  View as SavedView,
  ViewSelect,
} from './contract';
import type { Op } from './api';
import { indexOfLinks, touchedAreas } from './cross';
import { parsePrefs, type Prefs as FinishedPrefs } from './finished';
import { applyFilter, filterVaultOf, freshFilter, moveSelection, parseFilter, serializeFilter, type Filter } from './filter';
import { inboxOf, triageKey } from './inbox';
import type { Finding } from './check';
import { CheckState } from './state/check.svelte';
import { changesOf, failedIdsOf, MATRIX_MAX, matrixIds, type Draft } from './estimate';
import { MatrixState } from './state/matrix.svelte';
import { bumped, parseFrecency, type Frecency } from 'appkit-ui/palette';
import { AboutState, type AboutDialog } from './state/about.svelte';
import { ConflictsState } from './state/conflicts.svelte';
import { VaultsState } from './state/vaults.svelte';
import { ViewsState } from './state/views.svelte';
import { emptySelect, filterOfSelect, type ViewForm } from './views';
import { viewMenuItems } from './viewMenu';
import type { MenuItem } from 'appkit-ui/menu';
import { dropOps, NONE, type Grouping } from './groups';
import { TodayState } from './state/today.svelte';
import { GraphState } from './state/graph.svelte';
import type { DailyPrefs } from './daily';
import { parseConflictMode, type ConflictMode } from 'appkit-ui/conflicts';
import type { CountKey, CountView } from './counts';
import { conflictsOf, conflictsOfRequest, retryOp, type Conflict } from './conflicts';
import { Preferences, StreamSession } from 'appkit-ui/session';
import type { SseMessage } from 'appkit-ui/sse';
import { LANGS, translate, type Key, type Lang } from './i18n';
import { csvSeparatorFor, exportText, type ExportFormat } from './export';
import { applyOrder, orderOf, parseSort, type SortWord } from './sort';
import { fromEngineList, type EngineList } from './engineLists';
import { DEFAULT_RANGES, rangesOf, type Ranges } from './fields';
import {
  activeList as activeListOf,
  cleanName,
  makeList,
  parseListMemory,
  serializeListMemory,
  vaultKey,
  withList,
  withoutList,
  type ListMemory,
  type NamedList,
} from './lists';
import { localToday } from './remind';

/** The longest line of the notes the engine takes (`append_note`), in characters. */
const NOTE_MAX = 1000;

export type Phase = 'starting' | 'needs_pairing' | 'offline' | 'unavailable' | 'ready';
export type Connection = 'live' | 'reconnecting' | 'offline';
export type View = 'today' | 'list' | 'board' | 'plan' | 'inbox' | 'cross' | 'done' | 'views';
export type Theme = 'auto' | 'light' | 'dark';
/** The blocks of the Today view that a person may hide. */
export { ORDERED_TILES, TILES, type OrderedTile, type Tile } from './tiles-list';
import type { OrderedTile, Tile } from './tiles-list';

/** A context menu that is open: at `x`/`y` of the window, its name, its entries, and where the focus goes back to. */
export interface ContextMenuState {
  x: number;
  y: number;
  label: string;
  items: MenuItem[];
  origin: HTMLElement | null;
}

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
/** The saved view that was open last (its id). */
const OPEN_VIEW_KEY = 'tasks-desktop.view-open';
/** The key the palette remembers a choice of a saved view under (`view.<id>` of `paletteActions`, as an action). */
const VIEW_ACTION = 'action:view.';

/** The area of an id `<area>/<slug>`, or undefined when it has none. */
function areaOfId(id: string): string | undefined {
  const at = id.indexOf('/');
  return at > 0 ? id.slice(0, at) : undefined;
}

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
/** How many reads that began after a batch of moves may still bring the list of before the move (see `#arriving`). */
const LATE_READS = 3;

export class App {
  phase = $state<Phase>('starting');
  /** The last pairing code was refused (spent or older than its minute): the page says so and what to do. */
  pairRefused = $state(false);
  /** A code that arrived while the page was still starting: the pending start trades it. */
  private pendingCode: string | null = null;
  problem = $state<string | null>(null);
  view = $state<View>('today');
  /** What the person chose for the whole page (the kit's `Preferences`): the language, the theme, the single keys. */
  readonly prefs: Preferences<Lang>;
  /** The connection to the hub, and the event stream (the kit's `StreamSession`). */
  readonly stream = new StreamSession();
  get lang(): Lang {
    return this.prefs.lang;
  }
  get theme(): Theme {
    return this.prefs.theme;
  }
  /** Single-key shortcuts; a person with assistive software may turn them off. */
  get shortcuts(): boolean {
    return this.prefs.shortcuts;
  }
  get connection(): Connection {
    return this.stream.connection;
  }
  set connection(value: Connection) {
    this.stream.connection = value;
  }
  #filter = $state<Filter>(freshFilter());
  /** What is chosen to see. It is remembered (not the search words), so it outlives a reload. */
  get filter(): Filter {
    return this.#filter;
  }
  set filter(value: Filter) {
    const before = serializeFilter(this.#filter, this.#filterVault);
    this.#filter = value;
    // The filter belongs to the vault it was made in (its areas, tags and plans); while the hub has not named its
    // vault yet, the one the memory names is kept.
    if (typeof this.#hubVault === 'string') this.#filterVault = this.#hubVault;
    // The search words are not remembered: typing in the box writes nothing.
    const text = serializeFilter(value, this.#filterVault);
    if (text !== before) safe(() => this.env.prefs.setItem('tasks-desktop.filter', text));
  }
  /** The vault the remembered filter was made in (see `filterVaultOf`). */
  #filterVault: string | null | undefined = undefined;
  /** The vault the hub named last: `undefined` not asked yet (or not answered), `null` a hub that has no list of vaults. */
  #hubVault: string | null | undefined = undefined;
  /** How the start page is laid out and what was chosen there (its own state: `state/today.svelte.ts`). */
  readonly todayState: TodayState;
  /** The saved views of the vault and the groupings they are drawn with (its own state: `state/views.svelte.ts`). */
  readonly viewsState: ViewsState;
  /** The rev of the snapshot the views were last read at. */
  #viewsRev: string | undefined = undefined;
  /** Blocks of the Today view the person put away. */
  get hiddenTiles(): Tile[] {
    return this.todayState.hidden;
  }
  get tileOrder(): OrderedTile[] {
    return this.todayState.order;
  }
  /** What a move of a block says to a screen reader. */
  get tileNote(): string {
    return this.todayState.note;
  }
  /** The number of the overview whose tasks are shown (none: closed). */
  get countOpen() {
    return this.todayState.countOpen;
  }
  /** The view chosen for each number; what is not here has the default. */
  get countViews() {
    return this.todayState.countViews;
  }
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
  /**
   * A task dropped on an area: what the engine says moving it there would do (a dry run), until the person confirms
   * or gives up. Nothing is written before that.
   */
  dropMove = $state.raw<{
    id: string;
    toArea: string;
    /** How many tasks go: more than one when the dropped task is one of several marked ones (they go together). */
    count: number;
    /** The version of the file the dry run was made for (one task): the move is written under it, not under a newer one. */
    etag?: string;
    /** The dry run of one task. */
    answer: Awaited<ReturnType<App['previewMove']>> | null;
    /** The dry run of the marked tasks (`count` > 1), per task. */
    checks: MoveCheck[] | null;
  } | null>(null);
  /** A task whose area the person wants to choose (no drag: the key or the button of the row), until it is chosen. */
  dropChoose = $state<string | null>(null);
  #dropAsks = 0;
  /** The estimate matrix (its own state: `state/matrix.svelte.ts`). */
  readonly matrixState = new MatrixState({
    lang: () => this.lang,
    tasks: () => this.tasks,
    estimate: (request, signal) => this.env.hub.estimate(request, signal),
  });
  get matrix() {
    return this.matrixState.matrix;
  }
  get matrixDraft(): Draft {
    return this.matrixState.draft;
  }
  set matrixDraft(value: Draft) {
    this.matrixState.draft = value;
  }
  get matrixFigures() {
    return this.matrixState.figures;
  }
  get matrixProblem() {
    return this.matrixState.problem;
  }
  /** The figures shown are for an older draft than the table: a question is due or under way. */
  get matrixPending(): boolean {
    return this.matrixState.pending;
  }
  /** The graph of one task in the plan view (its own state: `state/graph.svelte.ts`). */
  readonly graphState = new GraphState({
    ready: () => this.phase === 'ready',
    can: (capability) => this.can(capability),
    lang: () => this.lang,
    rev: () => this.snapshot?.rev,
    showPlan: () => this.setView('plan'),
    planFor: (id, direction) => this.env.hub.planFor(id, direction),
  });
  get graph() {
    return this.graphState.graph;
  }
  get graphDoc() {
    return this.graphState.doc;
  }
  get graphProblem() {
    return this.graphState.problem;
  }
  get graphWantsFocus(): boolean {
    return this.graphState.wantsFocus;
  }
  set graphWantsFocus(value: boolean) {
    this.graphState.wantsFocus = value;
  }
  /** The check of the vault as a job and its findings (its own state: `state/check.svelte.ts`). */
  readonly checkState = new CheckState({
    ready: () => this.phase === 'ready',
    can: (capability) => this.can(capability),
    lang: () => this.lang,
    rev: () => this.snapshot?.rev,
    tasks: () => this.tasks,
    checkStart: (request) => this.env.hub.checkStart(request),
    checkState: () => this.env.hub.checkState(),
  });
  get checking(): boolean {
    return this.checkState.checking;
  }
  get checkJob() {
    return this.checkState.job;
  }
  get checkProblem() {
    return this.checkState.problem;
  }
  /** A card that goes to the blocked column and has no blocker yet, waiting for the person's answer. */
  blocking = $state.raw<{ id: string } | null>(null);
  /** The changes the engine refused because the file moved on (its own state: `state/conflicts.svelte.ts`). */
  /** The vaults the hub can read (its own state: `state/vaults.svelte.ts`). */
  readonly vaultsState = new VaultsState({
    ready: () => this.phase === 'ready',
    vaults: () => this.env.hub.vaults(),
    selectVault: (name) => this.env.hub.selectVault(name),
    addVault: (name, path) => this.env.hub.addVault(name, path),
    removeVault: (name) => this.env.hub.removeVault(name),
    createVault: (path, area) => this.env.hub.createVault(path, area),
    revealVault: () => this.env.hub.revealVault(),
    say: (kind, key, params) => this.say(kind, key, params),
  });
  get vaultList(): VaultList | null {
    return this.vaultsState.list;
  }
  get managingVaults(): boolean {
    return this.vaultsState.managing;
  }
  get vaultBusy(): boolean {
    return this.vaultsState.busy;
  }
  get vaultsFailed(): boolean {
    return this.vaultsState.failed;
  }
  /** The Info dialog (its own state: `state/about.svelte.ts`). */
  readonly aboutState = new AboutState({
    available: () => this.phase === 'ready' || (this.phase === 'unavailable' && this.env.hub.hasToken),
    about: () => this.env.hub.about(),
  });
  get about(): AboutDialog {
    return this.aboutState.dialog;
  }
  readonly conflictsState = new ConflictsState((mode) => safe(() => this.env.prefs.setItem('tasks-desktop.conflict-mode', mode)));
  get conflicts(): Conflict[] {
    return this.conflictsState.list;
  }
  /** The conflict center is open. */
  get conflictsOpen(): boolean {
    return this.conflictsState.open;
  }
  /** How the conflict center shows its list: every conflict (the default), or one at a time. */
  get conflictMode(): ConflictMode {
    return this.conflictsState.mode;
  }
  /** What the tile Today shows: the kind of period, the days of a named one, the evaluations chosen. */
  get dailyPrefs() {
    return this.todayState.daily;
  }
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
  /** The named lists of the engine (read only; the ones of the editor, built in, or from its configuration). */
  engineLists = $state.raw<EngineList[]>([]);
  #engineListsAsked = false;
  /** The ranges the property form offers: the engine's (`hello.enums`) once the hub has passed them on. */
  ranges = $state.raw<Ranges>(DEFAULT_RANGES);
  #enumsAsked = false;
  /** The named lists of every vault this browser knows (a filter and an order under a name). */
  listMemory = $state.raw<ListMemory>({});
  /** The order the list is shown in: a word of the engine's `--sort`, or its plan order. */
  sort = $state<SortWord>('default');
  /** The places the engine gave the ids for `sort`; a task it does not name yet comes after the named ones. */
  #order = $state.raw<Map<string, number> | null>(null);
  #orders = 0;
  next = $state.raw<Next | null>(null);
  hubAreas = $state.raw<HubArea[]>([]);
  detail = $state.raw<Detail>({ state: 'none' });
  /** What the hub found in the text of the tasks for the words in the filter. */
  textSearch = $state.raw<{ query: string; result: SearchResult } | null>(null);
  /** When the list shown was saved, if it is from the cache and not yet confirmed. */
  cachedAt = $state<number | null>(null);

  private etag: string | null = null;
  /** The page was stopped (the kit's `StreamSession` knows). */
  private get stopped(): boolean {
    return this.stream.stopped;
  }
  /** The read in progress (and the reads it repeats), if any. */
  private loop: Promise<void> | null = null;
  private dirty = false;

  constructor(private readonly env: Env) {
    // Made here, not as a field: it reads the profile at once, and the fields are made before `env` is held.
    this.todayState = new TodayState({
      lang: () => this.lang,
      getItem: (key) => safe(() => env.prefs.getItem(key)),
      setItem: (key, value) => void safe(() => env.prefs.setItem(key, value)),
    });
    this.viewsState = new ViewsState({
      can: (capability) => this.can(capability),
      rev: () => this.snapshot?.rev,
      views: () => env.hub.views(),
      groupings: () => env.hub.groupings(),
      // A change while a write is on its way is refused with a word, as on the board (not dropped without one).
      write: (ops) => (this.refusedWhileSaving() ? Promise.resolve(null) : this.write(ops)),
      remembered: () => safe(() => env.prefs.getItem(OPEN_VIEW_KEY)) || null,
      // The id names its area: it is kept only for an area whose class may be kept in the browser (as the cache).
      remember: (id) => {
        const keep = id !== null && this.mayRememberArea(areaOfId(id));
        safe(() => env.prefs.setItem(OPEN_VIEW_KEY, keep ? id : ''));
      },
    });
    this.prefs = new Preferences<Lang>(
      env.prefs,
      { lang: 'tasks-desktop.lang', theme: 'tasks-desktop.theme', shortcuts: 'tasks-desktop.shortcuts' },
      LANGS,
      env.preferredLanguages,
      'en',
    );
    this.shortAreas = safe(() => env.prefs.getItem('tasks-desktop.short-areas')) !== 'off';
    this.sort = parseSort(safe(() => env.prefs.getItem('tasks-desktop.sort')));
    this.listMemory = parseListMemory(safe(() => env.prefs.getItem('tasks-desktop.lists')));
    const remembered = safe(() => env.prefs.getItem('tasks-desktop.filter'));
    this.#filter = parseFilter(remembered);
    this.#filterVault = filterVaultOf(remembered);
    this.frecency = parseFrecency(safe(() => env.prefs.getItem('tasks-desktop.frecency')));
    this.conflictsState.mode = parseConflictMode(safe(() => env.prefs.getItem('tasks-desktop.conflict-mode')));
    this.finishedPrefs = parsePrefs(safe(() => env.prefs.getItem('tasks-desktop.finished')));
    // The page opens on the view it was left on.
    const view = safe(() => env.prefs.getItem('tasks-desktop.view'));
    this.view =
      view === 'list' ||
      view === 'board' ||
      view === 'plan' ||
      view === 'inbox' ||
      view === 'cross' ||
      view === 'done' ||
      view === 'views'
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

  /** The ids the engine counts as quick wins (its figure of the estimate), or undefined when the engine gave none. */
  quickWinSet = $derived.by((): ReadonlySet<string> | undefined => {
    const ids = this.snapshot?.estimate?.quick_wins;
    return ids === undefined ? undefined : new Set(ids);
  });

  get shown(): TaskEntry[] {
    const filtered = applyFilter(this.tasks, this.filter, this.today, this.crossIndex, this.quickWinSet);
    return this.sort === 'default' ? filtered : applyOrder(filtered, this.#order);
  }

  /** The open tasks a saved view shows: its selection found the way the list finds its filter. */
  tasksOfView(view: SavedView): TaskEntry[] {
    return applyFilter(this.tasks, filterOfSelect(view.select), this.today, this.crossIndex, this.quickWinSet);
  }

  /** Show the tab of the views with the view `id` open. */
  openView(id: string): void {
    this.viewsState.choose(id);
    this.setView('views');
  }

  /** Show the tab of the views with `form` as a view being tried (not saved: nothing is written). */
  tryView(form: ViewForm): void {
    if (!this.can('views')) return;
    this.viewsState.try(form);
    this.viewsState.wantsFocus = true;
    this.setView('views');
  }

  /** The context menu that is open: where, its name, its entries, and the element the focus goes back to. */
  contextMenu = $state.raw<ContextMenuState | null>(null);

  openContextMenu(menu: ContextMenuState): void {
    this.contextMenu = menu;
  }

  closeContextMenu(): void {
    this.contextMenu = null;
  }

  /**
   * The context menu "open as a view" for `select` (named `title`), at the place of `event` - a right click, the menu
   * key or Shift+F10. Without views (an older engine) or without the fields of the engine the menu of the browser stays.
   */
  async openViewMenu(event: MouseEvent, title: string, select: Partial<ViewSelect>): Promise<void> {
    if (this.phase !== 'ready' || !this.can('views') || !this.can('groupings')) return;
    event.preventDefault();
    // The element the menu belongs to (by what it can do, not by its class: the page is also run without a DOM in tests).
    const target = event.currentTarget as Partial<HTMLElement> | null;
    // (A label around a choice is such an element too: its `focus()` gives the focus to the choice.)
    const origin = target && typeof target.focus === 'function' && typeof target.getBoundingClientRect === 'function' ? (target as HTMLElement) : null;
    // A key opens the menu with no pointer: it opens at the element instead.
    const box = origin?.getBoundingClientRect();
    const byKey = event.clientX === 0 && event.clientY === 0;
    const x = byKey && box ? box.left : event.clientX;
    const y = byKey && box ? box.bottom : event.clientY;
    await this.viewsState.loadGroupings();
    const fields = this.viewsState.groupingsShown?.fields.map((f) => f.field) ?? [];
    const t = (key: Key) => translate(this.lang, key);
    const items = viewMenuItems(
      title,
      { ...emptySelect(), ...select },
      fields,
      {
        open: t('views.menu.open'),
        columns: t('views.display.columns'),
        list: t('views.display.list'),
        groupBy: t('views.form.group_by'),
        field: (field) => t(`views.field.${field}` as Key),
      },
      (form) => this.tryView(form),
    );
    if (items.length === 0) return;
    this.contextMenu = { x, y, label: t('views.menu.label'), items, origin };
  }

  /** The named lists of the vault the hub reads. */
  get lists(): NamedList[] {
    return this.listMemory[vaultKey(this.vaultList?.active)] ?? [];
  }

  /** The named list that is exactly the filter and the order shown now, if any. */
  get shownList(): NamedList | undefined {
    return activeListOf(this.lists, this.filter, this.sort);
  }

  #keepLists(next: ListMemory): void {
    this.listMemory = next;
    safe(() => this.env.prefs.setItem('tasks-desktop.lists', serializeListMemory(next)));
  }

  /** Keep the filter and the order shown now under `name` (a list of that name is replaced). Says what came of it. */
  saveList(name: string): 'saved' | 'bad_name' | 'full' | 'wait' {
    // The lists belong to the vault the hub reads: until it has named it (or said it has none) they would be
    // kept under no name and not be found again.
    if (this.#hubVault === undefined) {
      this.say('error', this.vaultsFailed ? 'lists.wait_failed' : 'lists.wait');
      return 'wait';
    }
    const clean = cleanName(name);
    if (clean === null) {
      this.say('error', 'lists.bad_name');
      return 'bad_name';
    }
    const key = vaultKey(this.vaultList?.active);
    const lists = withList(this.lists, makeList(clean, this.filter, this.sort));
    if (lists === null) {
      this.say('error', 'lists.full');
      return 'full';
    }
    this.#keepLists({ ...this.listMemory, [key]: lists });
    this.say('ok', 'lists.saved', { name: clean });
    return 'saved';
  }

  /** Show what the list `name` names: its filter (the search words stay) and its order. */
  applyList(name: string): void {
    const list = this.lists.find((l) => l.name === name);
    if (!list) return;
    this.filter = { ...parseFilter(list.filter), query: this.filter.query };
    this.setSort(list.sort);
  }

  /**
   * Show what a list of the engine names: its filter (the search words stay) and its order. What the page cannot say
   * of it is told, so nobody takes the list for more than it shows.
   */
  applyEngineList(name: string): void {
    const list = this.engineLists.find((l) => l.name === name);
    if (!list) return;
    const applied = fromEngineList(list, this.tasks, { quickWins: this.quickWinSet !== undefined });
    this.filter = { ...applied.filter, query: this.filter.query };
    this.setSort(applied.sort);
    if (applied.unsupported.length > 0) {
      this.say('error', 'lists.engine_partial', { name, words: applied.unsupported.join(', ') });
    }
  }

  /** Ask for the ranges of the fields, once. A hub or an engine that cannot say keeps the defaults of `fields.ts`. */
  async loadEnums(): Promise<void> {
    if (this.#enumsAsked) return;
    this.#enumsAsked = true;
    try {
      this.ranges = rangesOf((await this.env.hub.enums()).enums);
    } catch (error) {
      // A session that is gone asks again after the next pairing; any other failure keeps the defaults.
      if (error instanceof ApiError && error.status === 401) this.#enumsAsked = false;
    }
  }

  /** Ask the engine for its lists. A hub or an engine without them shows none; that is no failure to tell. */
  async loadEngineLists(): Promise<void> {
    // Once for this page: the lists of the editor change when somebody saves one there, not with every write.
    if (this.#engineListsAsked) return;
    if (!this.can('lists')) {
      this.engineLists = [];
      return;
    }
    this.#engineListsAsked = true;
    try {
      this.engineLists = (await this.env.hub.lists()).lists;
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        this.#engineListsAsked = false;
        return;
      }
      this.engineLists = [];
    }
  }

  deleteList(name: string): void {
    const key = vaultKey(this.vaultList?.active);
    const lists = withoutList(this.lists, name);
    if (lists.length === this.lists.length) return;
    const next = { ...this.listMemory };
    if (lists.length === 0) delete next[key];
    else next[key] = lists;
    this.#keepLists(next);
    this.say('ok', 'lists.deleted', { name });
  }

  /** Show the list in another order of the engine. The order is asked for at once; until it is there the plan's order stands. */
  setSort(word: SortWord): void {
    if (word === this.sort) return;
    this.sort = word;
    this.#order = null;
    safe(() => this.env.prefs.setItem('tasks-desktop.sort', word));
    void this.readOrder();
  }

  /** Ask the engine for the ids in the order of `sort`. A failure puts the list back in the plan's order and says so. */
  private async readOrder(): Promise<void> {
    const word = this.sort;
    if (word === 'default') {
      this.#order = null;
      return;
    }
    const seq = ++this.#orders;
    try {
      const { ids } = await this.env.hub.order(word);
      if (seq === this.#orders && word === this.sort) this.#order = orderOf(ids);
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) return;
      if (seq !== this.#orders) return;
      this.sort = 'default';
      this.#order = null;
      safe(() => this.env.prefs.setItem('tasks-desktop.sort', 'default'));
      this.tell('error', 'sort.failed');
    }
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
    this.prefs.setLang(lang);
  }

  setShortcuts(on: boolean): void {
    this.prefs.setShortcuts(on);
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
    return this.mayRememberArea(task.area);
  }

  /** May a name of this area (an id under it) be kept in the browser? Its class decides, as for the cache. */
  private mayRememberArea(area: string | undefined): boolean {
    return area !== undefined && cacheableClass(this.hubAreas.find((a) => a.name === area)?.data_class);
  }

  openConflicts(): void {
    this.conflictsState.show();
  }

  closeConflicts(): void {
    this.conflictsState.hide();
  }

  /** The way the conflict center shows its list, kept in this browser. */
  setConflictMode(mode: ConflictMode): void {
    this.conflictsState.setMode(mode);
  }

  /** Let a refused change go. */
  discardConflict(key: string): void {
    this.conflictsState.discard(key);
  }

  discardAllConflicts(): void {
    this.conflictsState.discardAll();
  }

  /**
   * Try a refused change again, on the version the task has now (the person has seen both and chose). It leaves the
   * list first; a second refusal puts it back as a new entry.
   */
  async retryConflict(key: string): Promise<void> {
    const conflict = this.conflictsState.find(key);
    // Not now (a write is under way, or the page is not connected): the entry stays, nothing is lost.
    if (!conflict || this.saving || this.phase !== 'ready') return;
    const op = retryOp(conflict, this.tasks.find((t) => t.id === conflict.id));
    if (op === null) return;
    this.conflictsState.discard(key);
    await this.write([op]);
  }

  openPalette(): void {
    if (this.phase !== 'ready') return;
    this.palette = true;
    // The palette names the saved views: read them again when the vault changed since (they are read on a new state
    // only while their tab is shown).
    if (this.can('views') && this.#viewsRev !== this.snapshot?.rev) this.readViews();
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
    // An action of a saved view names the view's id, and so its area: kept only for an area that may be kept.
    if (key.startsWith(VIEW_ACTION) && !this.mayRememberArea(areaOfId(key.slice(VIEW_ACTION.length)))) return;
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
      this.conflictsState.add(conflictsOf(ops, result, Date.now(), opts.tags));
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
      await this.readAfter(ops);
      return result;
    } catch (error) {
      this.answering = false;
      if (error instanceof ApiError && error.code === 'outcome_unknown') {
        this.say('error', 'write.unknown');
      } else if (error instanceof ApiError && error.status === 409) {
        this.conflictsState.add(conflictsOfRequest(ops, Date.now(), opts.tags));
        this.say('error', 'write.conflict');
      } else if (error instanceof ApiError && error.status === 400) {
        this.say('error', 'write.invalid', { message: error.message });
      } else {
        this.say('error', 'write.failed', {
          code: error instanceof ApiError ? error.code : 'offline',
        });
      }
      await this.readAfter(ops);
      return null;
    } finally {
      this.saving = false;
      this.answering = false;
      this.settling = null;
      this.writes += 1;
      // The marks were not judged while the write was on its way (see `keepMarksShown`): now they are, by the list the
      // write read after it.
      if (this.marks.length > 0) {
        this.marks = pruneMarks(this.marks, this.tasks, this.#arriving?.ids);
        this.keepMarksShown();
      }
      settle();
    }
  }

  /** Read the saved views, noting the state of the vault they were read at. */
  private readViews(): void {
    this.#viewsRev = this.snapshot?.rev;
    void this.viewsState.load();
  }

  /** The list after a write, and the views when the write was one of them (the snapshot does not hold the views). */
  private async readAfter(ops: readonly Op[]): Promise<void> {
    await this.refresh();
    if (ops.some((op) => op.op === 'view_save' || op.op === 'view_delete')) await this.viewsState.load();
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
      // A view: made is taken back by deleting it, changed or deleted by saving the view as it was (the engine's).
      if (inv.op === 'view_delete') {
        inverses.push({ op: 'view_delete', id: inv.id, ...(inv.if_match ? { if_match: inv.if_match } : {}) });
        continue;
      }
      if (inv.op === 'view_save') {
        if (typeof inv.view !== 'object' || inv.view === null) return undefined;
        inverses.push({
          op: 'view_save',
          id: inv.id,
          view: inv.view as ViewForm,
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
    // Several moves taken back at once: the one of the selected task is found by its place in the batch.
    const back = result?.results.find((r) => {
      const op = ops[r.n - 1];
      return r.ok && r.outcome === 'moved' && typeof r.new_id === 'string' && op?.op === 'move_area' && op.id === selectedBefore;
    });
    if (back?.new_id) this.select(back.new_id);
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
   * A task was dropped on an area: ask the engine what the move would do and show it. The same area is no move.
   * A later drop replaces an earlier one, and the answer of the earlier is not shown for it.
   */
  async askDropMove(id: string, toArea: string): Promise<void> {
    const task = this.tasks.find((x) => x.id === id);
    if (!task || task.area === toArea || !this.can('move_area') || this.saving) return;
    this.dropChoose = null;
    const seq = ++this.#dropAsks;
    // A marked task dropped with other marked ones takes them along: they are moved together, as in the list.
    const count = this.marks.length > 1 && this.marks.includes(id) ? this.marks.length : 1;
    const etag = task.etag;
    this.dropMove = { id, toArea, count, ...(etag ? { etag } : {}), answer: null, checks: null };
    const still = (): boolean => seq === this.#dropAsks && this.dropMove?.id === id && this.dropMove.toArea === toArea;
    if (count > 1) {
      const checks = await this.previewBulkMove(toArea);
      if (!still()) return;
      // The engine could not be asked (the reason was told): nothing is left to confirm.
      this.dropMove = checks === null ? null : { id, toArea, count, answer: null, checks };
      return;
    }
    const answer = await this.previewMove(id, toArea);
    if (still()) this.dropMove = { id, toArea, count, ...(etag ? { etag } : {}), answer, checks: null };
  }

  cancelDropMove(): void {
    this.#dropAsks++;
    this.dropMove = null;
  }

  /** Let the person choose the area of `id` (the key `m` or the button of a row): the way without a drag. */
  chooseDropMove(id: string): void {
    if (!this.can('move_area') || this.saving || !this.tasks.some((x) => x.id === id)) return;
    this.dropChoose = id;
  }

  cancelDropChoose(): void {
    this.dropChoose = null;
  }

  /** The person confirmed the move the engine described. The version is the one that was shown. */
  async confirmDropMove(): Promise<void> {
    const asking = this.dropMove;
    if (asking && asking.count > 1) {
      const checks = asking.checks ?? [];
      if (!checks.some((c) => c.reasons.length === 0 && c.newId !== '')) return;
      this.#dropAsks++;
      this.dropMove = null;
      await this.bulkMove(asking.toArea, checks);
      return;
    }
    if (!asking || asking.answer?.kind !== 'ok' || asking.answer.move.conflicts.length > 0) return;
    // The version the person was shown, not the one the list has by now: a file that changed meanwhile is refused.
    this.#dropAsks++;
    this.dropMove = null;
    await this.moveArea(asking.id, asking.toArea, asking.etag);
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

  /** The text of the marked tasks, or of those the list shows when none is marked, in the order of the list. */
  exportTasks(format: ExportFormat): { text: string; count: number } {
    const marked = new Set(this.marks);
    const tasks = marked.size > 0 ? this.shown.filter((t) => marked.has(t.id)) : this.shown;
    // The spreadsheet that opens the file is the one of the system: its locale decides the column separator.
    const separator = csvSeparatorFor(this.env.preferredLanguages[0]);
    return { text: exportText(tasks, format, separator), count: tasks.length };
  }

  /** Tell the person what an export did (`how`: saved, failed, copied or copy_failed). */
  announceExport(how: 'saved' | 'failed' | 'copied' | 'copy_failed', count: number): void {
    this.say(how === 'failed' || how === 'copy_failed' ? 'error' : 'ok', `export.${how}`, { n: count });
  }

  /** Only the tasks the list shows stay marked: a mark that cannot be seen must not be changed. */
  keepMarksShown(): void {
    // Not while a write is on its way: a list read in the middle of it may lack tasks the write has moved already, and
    // their marks would go before the answer can tell where the tasks went. The read after the write sets this right.
    if (this.marks.length === 0 || this.saving) return;
    const shown = new Set(this.shown.map((t) => t.id));
    const arriving = this.#arriving?.ids;
    const kept = this.marks.filter((id) => shown.has(id) || arriving?.has(id));
    if (kept.length !== this.marks.length) this.marks = kept;
  }

  /**
   * The new ids a batch of moves gave its marks, and how many reads of the list had begun when it was answered. A
   * read that began before the answer may bring the list of before (an event of the hub had started it), which does
   * not know the new ids yet: they are not taken off the marks for it. A read that began after the answer clears this
   * once its list knows the new ids; a list that still lacks them (the hub answered from the state before the move) is
   * not believed at once, but only for `LATE_READS` reads, so a mark of a task that is really gone does not stay.
   */
  #arriving: { ids: ReadonlySet<string>; before: number; late: number } | null = null;
  /** The reads of the list begun so far (see `#arriving`). */
  #reads = 0;

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
    await this.write(ops, { ...(tags ? { tags } : {}), onAnswer: this.batchAnswer(ops) });
  }

  /**
   * What a batch of `set` on marked tasks says when its answer is there: how many went through, how many failed (each
   * failed one stays marked, the others are taken off), with the way back of those that went through.
   */
  private batchAnswer(ops: readonly { id: string }[]): (result: Result) => boolean {
    const sent = new Set(ops.map((o) => o.id));
    // Said as soon as the answer is there: the re-read of the list that follows takes as long as the engine does.
    return (result: Result): boolean => {
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
  }

  /**
   * A task of a saved view dropped from the group `from` onto the group `to` of `grouping` (`copy`: the Ctrl key, a
   * list of tags keeps the group it leaves). A marked task takes the other marked ones of the view with it, as one batch.
   * The operation is the one the engine names for the field (`dropOps`); what it cannot be is said, not sent. Says
   * whether it was sent.
   */
  async dropInView(
    id: string,
    grouping: Grouping,
    from: string,
    to: string,
    copy = false,
    inView: readonly TaskEntry[] = this.tasks,
  ): Promise<boolean> {
    if (this.refusedWhileSaving()) return false;
    const task = inView.find((t) => t.id === id);
    if (!task) return false;
    // Only the marked tasks the view shows go with it: a mark the person cannot see here is not moved from here.
    const together = this.marks.includes(id) ? inView.filter((t) => this.marks.includes(t.id)) : [task];
    // Blocked with nothing that blocks it is a warning of the engine: one task is asked for its blocker (as on the
    // board); several are not blocked behind the person's back.
    if (grouping.field === 'status' && to === 'blocked') {
      const bare = together.filter((t) => t.blocked_by.length === 0);
      if (bare.length > 0 && together.length === 1) {
        if (this.phase === 'ready') this.blocking = { id };
        return false;
      }
      if (bare.length > 0) {
        this.say('error', 'views.blocked_batch', { n: bare.length });
        return false;
      }
    }
    const ops: Op[] = [];
    for (const one of together) {
      const drop = dropOps(one, grouping, from, to, copy);
      if (drop.kind === 'ops') ops.push(...drop.ops);
      // A task of the batch that already is where it goes is no refusal of the others.
      else if (drop.kind === 'refused' && drop.reason === 'same' && one.id !== id) continue;
      else {
        this.say('error', `views.refused.${drop.kind === 'refused' ? drop.reason : 'read_only'}` as Key);
        return false;
      }
    }
    if (ops.length === 0) return false;
    const tags: TagEdit | undefined = grouping.mode === 'tags' ? { add: to === NONE ? [] : [to], remove: copy ? [] : [from] } : undefined;
    const batch = together.length > 1 ? { onAnswer: this.batchAnswer(ops as { id: string }[]) } : {};
    const result = await this.write(ops, { ...(tags ? { tags } : {}), ...batch });
    // Moved only when the engine took every operation: a refusal is told by the toast, not announced as a move.
    return result !== null && result.results.every((r) => r.ok);
  }

  /**
   * Ask the engine, in ONE dry run, what moving every marked task to `toArea` would do: per task the new id, the
   * reasons it cannot be made (a taken slug, an unknown area) and how many places follow. Nothing is written. Null when
   * nothing is to be moved or the engine could not be asked.
   */
  async previewBulkMove(toArea: string): Promise<MoveCheck[] | null> {
    const ops = bulkMoveOps(this.tasks, this.marks, toArea);
    if (ops.length === 0) return [];
    // Too many moves for one engine call: refused before anything is sent (see `MOVE_MAX`).
    if (ops.length > MOVE_MAX) {
      this.say('error', 'bulk.move_limit', { n: MOVE_MAX });
      return null;
    }
    try {
      const result = await this.env.hub.ops({ client_op_id: this.opId(), dry_run: true, ops });
      return moveChecks(ops, result.results);
    } catch (error) {
      if (error instanceof ApiError && error.status === 400) {
        this.say('error', 'write.invalid', { message: error.message });
      } else {
        this.say('error', 'move.unknown');
      }
      return null;
    }
  }

  /**
   * Move the marked tasks the dry run let through (`checks` without a reason) to `toArea`, as ONE request with one
   * `move_area` each, each with the version that was shown. Not all-or-nothing: a task that changed meanwhile fails
   * alone and is told. A moved task keeps its mark under its new id, and the selection follows it; a failed one stays
   * marked. Taking it back is the inverses the engine gave. Says how many were moved.
   */
  async bulkMove(toArea: string, checks: readonly MoveCheck[]): Promise<number> {
    const go = new Set(checks.filter((c) => c.reasons.length === 0 && c.newId !== '').map((c) => c.id));
    // A marked task that names another marked one goes first: the other's move rewrites its file.
    const ops = moveOrder(
      bulkMoveOps(this.tasks, this.marks, toArea).filter((o) => go.has(o.id)),
      checks,
    );
    if (ops.length === 0) {
      this.say('ok', 'bulk.nothing');
      return 0;
    }
    if (ops.length > MOVE_MAX) {
      this.say('error', 'bulk.move_limit', { n: MOVE_MAX });
      return 0;
    }
    const selectedBefore = this.selectedId;
    const moved = new Map<string, string>();
    const onAnswer = (result: Result): boolean => {
      let failed = 0;
      for (const r of result.results) {
        const id = ops[r.n - 1]?.id;
        if (r.ok && r.outcome === 'moved' && typeof r.new_id === 'string' && id) moved.set(id, r.new_id);
        else if (!r.ok) failed += 1;
      }
      this.marks = followMoves(this.marks, moved);
      // A read under way now may still bring the list of before: the new ids are kept from it.
      this.#arriving = { ids: new Set(moved.values()), before: this.#reads, late: 0 };
      // Not `inverseOf`: a later move of the batch may have rewritten a file whose inverse carries the version before.
      const undo = moveUndo(result.results);
      if (failed === 0) this.say('ok', 'bulk.moved', { n: moved.size }, undo);
      else {
        // The text of the engine says why, and a "rollback incomplete" names the files that could not be put back.
        const first = result.results.find((r) => !r.ok);
        const why = first?.error?.message ?? first?.error?.code ?? '';
        this.say('error', 'bulk.move_partial', { done: moved.size, failed, why }, undo);
      }
      return true;
    };
    await this.write(ops, { onAnswer });
    const next = selectedBefore === null ? undefined : moved.get(selectedBefore);
    if (next) this.select(next);
    return moved.size;
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

  /** The findings that hold: of tasks as they were when the check was made, and of what is no listed task. */
  get checkFindings(): Finding[] {
    return this.checkState.findings;
  }

  /** The findings of tasks that changed since the check: possibly resolved, shown as such. */
  get checkStale(): Finding[] {
    return this.checkState.stale;
  }

  /** How many tasks with findings changed or went away since the check. */
  get checkChanged(): number {
    return this.checkState.changed;
  }

  /** The findings that hold about the task `id`. */
  findingsFor(id: string): Finding[] {
    return this.checkState.findingsFor(id);
  }

  /** Whether the check that is done was made for a state the page never held (the vault changed while it ran). */
  get checkOutdated(): boolean {
    return this.checkState.outdated;
  }

  /** Open the check dialog on what the hub knows of the job. */
  openChecks(): Promise<void> {
    return this.checkState.open();
  }

  closeChecks(): void {
    this.checkState.close();
  }

  /** Start the check; it runs in the hub and the page goes on. */
  runCheck(refs: boolean): Promise<void> {
    return this.checkState.run(refs);
  }

  // ── the graph of a task ────────────────────────────────────────────────

  /** Show what `id` needs (or what waits for it) in the plan view. */
  openGraph(id: string, direction: 'needs' | 'unlocks' = 'needs'): void {
    this.graphState.open(id, direction);
  }

  closeGraph(): void {
    this.graphState.close();
  }

  /** Ask again for the graph that is open, after the vault changed (the old one stays until the new one is there). */
  reloadGraph(): void {
    this.graphState.reload();
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
    this.matrixState.start(ids);
  }

  closeMatrix(): void {
    this.matrixState.close();
  }

  /** The tasks of the matrix that are still there, in the order they were asked for. */
  get matrixRows(): TaskEntry[] {
    return this.matrixState.rows;
  }

  /** How many tasks the draft would change (a cell equal to its file changes nothing). */
  get matrixChanges(): number {
    return this.matrixState.changes;
  }

  /** Choose a cell (or put it back with `undefined`); the figures are asked for again a moment later. */
  setCell(id: string, field: 'effort' | 'value', value: string | number | undefined): void {
    this.matrixState.setCell(id, field, value);
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
        void this.matrixState.ask();
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
    this.filter = freshFilter();
    // The text search belongs to the words that are gone.
    this.scheduleTextSearch('', 0);
  }

  /**
   * Show a task in the list with its detail: a filter that hides it is taken
   * away first, or the detail would stand without its row.
   */
  reveal(id: string): void {
    this.peeking = false;
    if (this.tasks.some((t) => t.id === id) && !this.shown.some((t) => t.id === id)) {
      this.resetFilter();
    }
    this.select(id);
    this.setView('list');
  }

  /** A task is looked at in a popup over the view the person is in (the overview, the plan), not in the list. */
  peeking = $state(false);

  /** Look at a task without leaving the view: it is selected (its detail is read) and the popup opens over the view. */
  peek(id: string): void {
    this.select(id);
    this.peeking = true;
  }

  closePeek(): void {
    this.peeking = false;
  }

  /** The choice of the tile Today (the period and the evaluations), kept in this browser. */
  setDailyPrefs(prefs: DailyPrefs): void {
    this.todayState.setDaily(prefs);
  }

  hideTile(tile: Tile): void {
    this.todayState.hide(tile);
  }

  /** The view a number shows its tasks in. */
  countView(key: CountKey): CountView {
    return this.todayState.countView(key);
  }

  /** Open the tasks behind a number, or close them when they are open. */
  toggleCount(key: CountKey): void {
    this.todayState.toggleCount(key);
  }

  closeCount(): void {
    this.todayState.closeCount();
  }

  setCountView(key: CountKey, view: CountView): void {
    this.todayState.setCountView(key, view);
  }

  /**
   * The key `v` on a number: a number that is closed opens in the view it has (the first press shows what the number
   * holds, it does not skip a view); one that is open goes on to its next view.
   */
  cycleCountView(key: CountKey): void {
    this.todayState.cycleCountView(key);
  }

  /** The tasks of a number in the list, with the status filter that fits (only "doing" and "blocked" have one). */
  openCountInList(key: CountKey): void {
    if (key !== 'doing' && key !== 'blocked') return;
    this.filter = { ...freshFilter(), statuses: [key] };
    this.setView('list');
  }

  /** Put the block `tile` before (or after) `target`; `visible` are the blocks on the page, for the number said aloud. */
  moveTile(tile: OrderedTile, target: OrderedTile, after: boolean, visible: readonly OrderedTile[]): void {
    this.todayState.move(tile, target, after, visible);
  }

  /** The blocks are not in the standard order (what "reset the order" would change). */
  get tileOrderChanged(): boolean {
    return this.todayState.orderChanged;
  }

  resetTileOrder(): void {
    this.todayState.resetOrder();
  }

  showTiles(): void {
    this.todayState.showAll();
  }

  setTheme(theme: Theme): void {
    this.prefs.setTheme(theme);
  }

  // ── start ─────────────────────────────────────────────────────────────

  /** Bring the page up. `code` is a pairing code taken from the address. */
  async start(code: string | null): Promise<void> {
    this.stream.resume();
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
        if (this.view === 'views' && !this.can('views')) this.view = 'today';
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
    this.stream.stop();
    this.checkState.invalidate();
    this.matrixState.invalidate();
    this.graphState.invalidate();
    this.stream.cut();
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
    this.checkState.forget();
    safe(() => this.env.session.removeItem(TOKEN_KEY));
    this.env.hub.setToken(null);
    this.stream.cut();
    this.phase = 'needs_pairing';
    this.connection = 'offline';
    this.tasks = [];
    this.snapshot = null;
    this.#order = null;
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
    const seq = ++this.#reads;
    try {
      // The vault the hub reads tells whether the remembered filter is of it: asked beside the list (it needs no
      // engine) and awaited before the list is put on the page, so that the filter of another vault is never drawn
      // on the tasks of this one.
      const named = this.#hubVault === undefined ? this.loadVaults() : null;
      // A conditional request only when the whole document is held: the
      // cache holds a part of it, and a "not modified" must not leave that
      // part standing in for the list.
      const result = await hub.snapshot(this.snapshot ? this.etag : null);
      if (named) await within(named, 1500);
      if (result.kind === 'fresh') {
        this.snapshot = result.doc;
        this.tasks = result.doc.tasks;
        this.etag = result.etag;
        if (this.sort !== 'default') void this.readOrder();
        this.checkState.listChanged();
      }
      this.cachedAt = null;
      this.phase = 'ready';
      if (this.connection === 'offline') this.connection = 'reconnecting';
      this.keepSelection();
      if (this.#arriving && seq > this.#arriving.before) {
        const have = new Set(this.tasks.map((t) => t.id));
        this.#arriving.late += 1;
        if ([...this.#arriving.ids].every((id) => have.has(id)) || this.#arriving.late >= LATE_READS) this.#arriving = null;
      }
      // The same: a write under way has not said where its tasks went, so a mark is not judged by a list read meanwhile.
      if (!this.saving) this.marks = pruneMarks(this.marks, this.tasks, this.#arriving?.ids);
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
    void this.loadEngineLists();
    void this.loadEnums();
    const doc = this.snapshot;
    if (!doc) return;
    // The vaults first: the answer does not depend on the classes, and a failure of those must not skip it.
    await this.loadVaults();
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
      if (list) void this.env.cache.save({ ...list, hubVault: this.vaultList?.active ?? null });
      else void this.env.cache.clear();
    } catch {
      // No classes, no cache: nothing is written.
    }
    void this.loadLinks();
    // The views are files of their own: read at the start, after a write of one, when the tab is entered and, while it is
    // shown, when the vault changed (from outside, say). A change of a task does not change a view: reading them after
    // every write elsewhere would be one more engine call in front of the next write.
    if (this.#viewsRev === undefined || (this.view === 'views' && this.#viewsRev !== doc.rev)) this.readViews();
    if (this.view === 'views') void this.viewsState.loadGroupings();
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
    const read = await this.vaultsState.read();
    // A hub with one vault and no list names none: the remembered filter stays as it is.
    if (read === 'none') this.#hubVault = null;
    if (read !== 'ok' || this.vaultList === null) return;
    // A filter made in another vault (chosen in another tab, or in the settings of the hub) is not taken over: its
    // areas, tags and plans are not those of this one. A filter that does not say its vault is now of this one.
    const active = this.vaultList.active;
    this.#hubVault = active;
    if (this.#filterVault !== undefined && this.#filterVault !== active) this.forgetFilterOfAnotherVault(active);
    else if (this.#filterVault === undefined) this.filter = { ...this.#filter };
  }

  /**
   * The filter in memory was made in another vault: it goes. What is saved is left alone: it may be the one that
   * another tab made for that vault a moment ago, and this page has nothing better to put there.
   */
  private forgetFilterOfAnotherVault(active: string): void {
    this.#filter = freshFilter();
    this.#filterVault = active;
    // The text search belongs to the words that are gone.
    this.scheduleTextSearch('', 0);
  }

  /** Whether the Info dialog can be opened: a running page, or one whose engine is not there (needs a session). */
  get canAbout(): boolean {
    return this.aboutState.available;
  }

  /** Open the Info dialog (APP-09); `focus` says what the person came for, so that the keyboard lands there. */
  openAbout(focus: 'info' | 'report' = 'info'): void {
    this.aboutState.open(focus);
  }

  closeAbout(): void {
    this.aboutState.close();
  }

  openVaults(): void {
    this.vaultsState.open();
  }

  closeVaults(): void {
    this.vaultsState.close();
  }

  /** Read another vault. What the page holds of the old one (the list, the cache) goes; the page loads again. */
  async selectVault(name: string): Promise<void> {
    if (this.vaultList?.active === name) return;
    const done = await this.vaultsState.select(name, async () => {
      // The list that is cached belongs to the vault that was left.
      await this.env.cache.clear();
      // The areas, tags and plans of a filter are those of the vault that was left; the empty one is the new vault's.
      this.#hubVault = name;
      this.filter = freshFilter();
    });
    if (done) (this.env.reload ?? (() => undefined))();
  }

  addVault(name: string, path: string): Promise<boolean> {
    return this.vaultsState.add(name, path);
  }

  removeVault(name: string): Promise<void> {
    return this.vaultsState.remove(name);
  }

  createVault(name: string, path: string, area: string): Promise<boolean> {
    return this.vaultsState.create(name, path, area);
  }

  revealVault(): Promise<void> {
    return this.vaultsState.reveal();
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
    // The views are the vault's: an engine that keeps none has no tab of them.
    if (view === 'views' && !this.can('views')) return;
    this.view = view;
    if (view === 'inbox') this.ensureInboxSelection(true);
    if (view === 'views' && this.phase === 'ready') {
      void this.viewsState.loadGroupings();
      // What changed while the tab was not shown is read now (once per state of the vault).
      if (this.#viewsRev !== this.snapshot?.rev) this.readViews();
    }
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
    return inboxOf(this.shown);
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

  private followStream(): Promise<void> {
    return this.stream.follow({
      fetchFn: this.env.fetchFn,
      url: () => this.env.hub.url('/api/tasks/events'),
      bearer: () => this.env.hub.bearer,
      hasToken: () => this.env.hub.hasToken,
      sleep: (ms) => this.env.sleep(ms),
      // What happened while the stream was down.
      onOpen: () => void this.refresh(),
      onMessage: (m) => this.onMessage(m),
      onLost: () => this.lostSession(),
    });
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
