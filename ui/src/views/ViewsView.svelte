<script lang="ts">
  import { selectionTarget } from '../lib/context';
  import { contextTarget, type ContextTarget } from 'appkit-ui/contextmenu';
  // The tab of the saved views: which view is open, a form to make one, and the open view drawn in groups. A view is a
  // file of the vault (the engine reads and writes it); the fields it can be grouped by and their values are the
  // engine's (`tasks.groupings`). Nothing here names a field's values or judges a view: a change is sent, and the engine
  // says what came of it.
  import { tick, untrack } from 'svelte';
  import type { App } from '../lib/app.svelte';
  import type { GroupField, View, ViewSelect } from '../lib/contract';
  import ExportMenu from './ExportMenu.svelte';
  import { cellsOf, groupsOf, keepsGroup, neighbourCell, neighbourGroup, NONE, type Cell, type Grouping } from '../lib/groups';
  import { labelOf, translate, type Key } from '../lib/i18n';
  import { markHidden } from '../lib/text';
  import { cleanTitle, emptySelect, formOf, selectOfFilter, selectParts, type ViewForm } from '../lib/views';
  import { selectOfGroup } from '../lib/viewMenu';
  import { DRAFT_ID } from '../lib/state/views.svelte';
  import { createGrip, farEnough, placeAt, type PointerDragEvent } from '../lib/pointerDrag';
  import Detail from './Detail.svelte';
  import Groups from './Groups.svelte';
  import GroupMatrix from './GroupMatrix.svelte';
  import BoardView from './BoardView.svelte';

  /** `board`: the built-in view is shown, the board (columns by status, with its order, runs and finishing). */
  let { app, board = false }: { app: App; board?: boolean } = $props();
  const t = (key: Key, params: Record<string, string | number> = {}) => translate(app.lang, key, params);

  const saved = $derived(app.viewsState);
  const open = $derived(saved.open);
  const groupings = $derived(saved.groupingsShown);
  /** The fields a view can be grouped by, in the engine's order; the area the engine names as one of them. */
  const fields = $derived<GroupField[]>(groupings?.fields.map((f) => f.field) ?? []);
  const areas = $derived.by(() => {
    const named = groupings?.fields.find((f) => f.field === 'area')?.values;
    return named && named.length > 0 ? named : [...new Set(app.tasks.map((x) => x.area))].sort();
  });

  /** The words for a field. */
  const fieldLabel = (field: string): string => t(`views.field.${field}` as Key);

  /** The words for a value of the field `field`: the page's word where it has one, else the value as it is. */
  function valueLabel(field: string, value: string): string {
    if (value === NONE) return t('views.none');
    if (field === 'status' || field === 'actor' || field === 'state' || field === 'cross') return labelOf(app.lang, field, value);
    if (field === 'prio') return `P${value}`;
    return value;
  }

  /** The value of the built-in view in the choice of views (no saved view has it: an id names an area and a slug). */
  const BOARD_ID = '@board';

  /** A view chosen in the bar: the board, a saved one, or the one being tried (which is shown already). */
  function choose(value: string): void {
    if (value === BOARD_ID) app.setView('board');
    else if (value !== DRAFT_ID) app.openView(value);
  }

  // ── the form of a new view ──
  let making = $state(false);
  let title = $state('');
  let area = $state('');
  let groupBy = $state<GroupField>('status');
  let display = $state<View['display']>('columns');
  let groupBy2 = $state<GroupField | undefined>(undefined);
  let fromList = $state(true);
  /** The selection of the view being tried, when it is the one being saved (then not the filter of the list). */
  let draftSelect = $state.raw<ViewSelect | null>(null);
  let makeProblem = $state('');
  let titleBox = $state<HTMLInputElement | null>(null);

  const fromFilter = $derived(selectOfFilter(app.filter));
  /** The selection the new view will get: the one being tried, else the filter of the list, else none. */
  const chosenSelect = $derived(draftSelect ?? (fromList ? fromFilter.select : emptySelect()));
  const parts = $derived(selectParts(chosenSelect));
  const partValue = (key: string, value: string): string =>
    key === 'statuses' ? labelOf(app.lang, 'status', value) : key === 'actors' ? labelOf(app.lang, 'actor', value) : value;

  function startMaking(): void {
    making = true;
    title = '';
    draftSelect = null;
    makeProblem = '';
    area = areas.includes(area) ? area : (app.filter.areas.length === 1 && areas.includes(app.filter.areas[0]!) ? app.filter.areas[0]! : (areas[0] ?? ''));
    groupBy = fields.includes(groupBy) ? groupBy : (fields[0] ?? 'status');
    queueMicrotask(() => titleBox?.focus());
  }

  async function make(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    const clean = cleanTitle(title);
    if (clean === null) {
      makeProblem = t('views.bad_title');
      return;
    }
    makeProblem = '';
    const rows = display === 'matrix' ? (groupBy2 !== undefined && groupBy2 !== groupBy ? groupBy2 : fields.find((f) => f !== groupBy)) : undefined;
    const form: ViewForm = {
      title: clean,
      display: display === 'matrix' && rows === undefined ? 'columns' : display,
      group_by: groupBy,
      ...(rows !== undefined ? { group_by2: rows } : {}),
      collapsed: [],
      select: chosenSelect,
    };
    if (await saved.create(area, form)) {
      making = false;
      // Made from the board: the new view is shown, not the board.
      if (board) app.setView('views');
    }
  }

  /** Save the view being tried: the form of a new view, with its name, field, form and selection. */
  function saveDraft(draft: View): void {
    startMaking();
    title = draft.title;
    groupBy = draft.group_by;
    display = draft.display;
    groupBy2 = draft.group_by2;
    draftSelect = draft.select;
  }

  /** What a group is for the context menu: the same view narrowed to the group, where a view can hold that. */
  function groupTarget(view: View, value: string): ContextTarget | undefined {
    const select = selectOfGroup(view.select, view.group_by, value);
    return select ? selectionTarget(`${view.title}: ${valueLabel(view.group_by, value)}`, select) : undefined;
  }

  // ── the open view ──
  let renaming = $state('');
  let renameProblem = $state('');
  // The box takes the title of the view when another view is opened or its title changed, not with every read of the
  // views (each read is a new object, and the text being typed would be lost).
  const openTitle = $derived(open ? JSON.stringify([open.id, open.title]) : '');
  $effect(() => {
    void openTitle;
    renaming = untrack(() => open?.title ?? '');
    renameProblem = '';
  });

  function save(view: View, change: Partial<ViewForm>): void {
    void saved.save(view, { ...formOf(view), ...change });
  }

  async function rename(event: SubmitEvent, view: View): Promise<void> {
    event.preventDefault();
    const clean = cleanTitle(renaming);
    if (clean === null) {
      renameProblem = t('views.bad_title');
      return;
    }
    renameProblem = '';
    if (clean !== view.title) save(view, { title: clean });
  }

  const grouping = $derived<Grouping | null>(
    open ? (groupings?.fields.find((f) => f.field === open.group_by) ?? null) : null,
  );
  const viewTasks = $derived(open ? app.tasksOfView(open) : []);
  const groups = $derived(grouping ? groupsOf(viewTasks, grouping, app.derivedValues) : []);
  /** A task is moved between groups only where the engine writes the field by a set or the list of tags (not the area). */
  const movable = $derived(
    grouping !== null &&
      grouping.writable &&
      (grouping.mode === 'set' || grouping.mode === 'tags' || (grouping.mode === 'move_area' && app.can('move_area'))),
  );

  // ── the matrix: the rows are the second field (`group_by2`), the columns the first ──
  const grouping2 = $derived<Grouping | null>(
    open?.display === 'matrix' && open.group_by2 !== undefined ? (groupings?.fields.find((f) => f.field === open.group_by2) ?? null) : null,
  );
  const rowGroups = $derived(grouping2 ? groupsOf(viewTasks, grouping2, app.derivedValues) : []);
  const cells = $derived(grouping && grouping2 ? cellsOf(viewTasks, grouping2, grouping, app.derivedValues) : []);
  const cellIndex = $derived(new Map(cells.map((c) => [JSON.stringify([c.row, c.column]), c])));
  const cellOf = (cell: Cell) => cellIndex.get(JSON.stringify([cell.row, cell.column]));
  /** A card is moved between cells where at least one of the two fields can be written so (the other may stay). */
  const movable2 = $derived(grouping2 !== null && grouping2.writable && (grouping2.mode === 'set' || grouping2.mode === 'tags'));
  const matrixMovable = $derived(movable || movable2);
  /** The cell whose tasks are listed under the matrix. */
  let openedCell = $state<Cell | null>(null);
  /** The card of the opened cell that is being dragged. */
  let cellDrag = $state<{ id: string; from: Cell } | null>(null);
  // Another view, or another field: the opened cell is no cell of it any more.
  const matrixKey = $derived(open ? JSON.stringify([open.id, open.group_by, open.group_by2 ?? '']) : '');
  $effect(() => {
    void matrixKey;
    openedCell = null;
  });

  const cellText = (cell: Cell): string =>
    open ? `${valueLabel(open.group_by2 ?? '', cell.row)} · ${valueLabel(open.group_by, cell.column)}` : '';

  /** Move `id` from the cell `from` onto `to` (both fields in one write); the opened cell follows it, and the focus. */
  async function moveInMatrix(id: string, from: Cell, to: Cell): Promise<void> {
    if (!grouping || !grouping2) return;
    const title = viewTasks.find((x) => x.id === id)?.title ?? id;
    if (!(await app.dropInMatrix(id, grouping2, grouping, from, to, viewTasks))) return;
    moved = t('views.moved', { title: markHidden(title), group: cellText(to) });
    openedCell = to;
    await tick();
    document.querySelector<HTMLElement>(`[data-matrix-item="${CSS.escape(id)}"]`)?.focus();
  }

  /** Shift with h, l (a column) or j, k (a row) on a card of the opened cell: the cell next to it. */
  function onCellItemKey(event: KeyboardEvent, id: string, from: Cell): void {
    if (!matrixMovable || !event.shiftKey || event.ctrlKey || event.altKey || event.metaKey) return;
    const moves = { h: 'left', l: 'right', j: 'down', k: 'up' } as const;
    const move = moves[event.key.toLowerCase() as keyof typeof moves];
    if (move === undefined) return;
    event.preventDefault();
    event.stopPropagation();
    if (event.repeat) return;
    const to = neighbourCell(rowGroups, groups, from, move);
    if (to !== null) void moveInMatrix(id, from, to);
  }

  // A finger drags a card of the opened cell by its grip onto another cell: the cell under the finger takes it once the
  // finger has gone a stretch from where it went down.
  let fingerFrom = { x: 0, y: 0 };
  let fingerCell = $state<string | null>(null);
  const cellGrip = createGrip(
    () => (matrixMovable ? onCellFinger : undefined),
    () => app.locked,
  );
  function onCellFinger(e: PointerDragEvent): void {
    if (e.phase === 'start') {
      fingerFrom = { x: e.x, y: e.y };
      fingerCell = null;
      return;
    }
    if (e.phase === 'move') {
      const far = farEnough(fingerFrom, e);
      fingerCell = far ? placeAt(document, e.x, e.y, 'data-cell') : null;
      return;
    }
    const at = e.phase === 'end' ? fingerCell : null;
    fingerCell = null;
    const from = openedCell;
    if (at === null || from === null) return;
    const [row = '', column = ''] = JSON.parse(at) as [string, string];
    if (row !== from.row || column !== from.column) void moveInMatrix(e.id, from, { row, column });
  }

  /** The field of the rows when a view becomes a matrix: the one it had, or the first other field of the engine. */
  const rowsFieldFor = (view: View): GroupField | undefined =>
    view.group_by2 !== undefined && view.group_by2 !== view.group_by ? view.group_by2 : fields.find((f) => f !== view.group_by);

  function setDisplay(view: View, value: View['display']): void {
    if (value === 'matrix') {
      const rows = rowsFieldFor(view);
      if (rows !== undefined) save(view, { display: 'matrix', group_by2: rows });
    } else save(view, { display: value, group_by2: undefined });
  }

  function setGroupBy(view: View, field: GroupField): void {
    // A matrix never has the same field down and across: the rows take another one.
    const rows = view.display === 'matrix' && view.group_by2 === field ? fields.find((f) => f !== field) : view.group_by2;
    save(view, { group_by: field, collapsed: [], ...(view.display === 'matrix' ? { group_by2: rows } : {}) });
  }

  // A view opened from a context menu takes the focus on its heading: the menu and the element it was opened on are gone.
  let heading = $state<HTMLHeadingElement | null>(null);
  $effect(() => {
    if (heading && saved.wantsFocus) {
      saved.wantsFocus = false;
      heading.focus();
    }
  });

  /** What was moved last, for assistive software (the toast says that it was saved, this says where it went). */
  let moved = $state('');

  /** Move `id` from the group `from` onto `to`; the focus follows the card into its new group. */
  async function move(id: string, from: string, to: string, copy: boolean): Promise<void> {
    if (!grouping || !open) return;
    const field = open.group_by;
    const title = viewTasks.find((x) => x.id === id)?.title ?? id;
    if (!(await app.dropInView(id, grouping, from, to, copy, viewTasks))) return;
    // Only a list of tags keeps the group it leaves: any other field moves, Ctrl or not.
    const kept = keepsGroup(grouping, copy);
    moved = t(kept ? 'views.copied' : 'views.moved', { title: markHidden(title), group: valueLabel(field, to) });
    await tick();
    const target = document.querySelector<HTMLElement>(`[data-group="${CSS.escape(to)}"] [data-view-item="${CSS.escape(id)}"]`);
    target?.focus();
  }

  // A move to another area is confirmed in the dialog (`askDropMove`): once it is written, the view says where the card
  // went and the focus follows it into its new group (the dialog gave it back to a card that is gone).
  $effect(() => {
    const done = app.areaMoved;
    if (!done || open?.group_by !== 'area') return;
    app.areaMoved = null;
    const title = app.tasks.find((x) => x.id === done.id)?.title ?? done.id;
    moved = t('views.moved', { title: markHidden(title), group: done.area });
    void tick().then(() =>
      document.querySelector<HTMLElement>(`[data-group="${CSS.escape(done.area)}"] [data-view-item="${CSS.escape(done.id)}"]`)?.focus(),
    );
  });

  /**
   * Shift with h or l on a card: the group before or after, as the keys of the board. With Alt as well it is the copy of
   * Ctrl and drag (a tag stays in the group it leaves; any other field moves). Alt changes the letter on some keyboards
   * (macOS), so the key is read by its place there.
   */
  function onItemKey(event: KeyboardEvent, id: string, from: string): void {
    if (!movable || !event.shiftKey || event.ctrlKey || event.metaKey) return;
    const copy = event.altKey;
    // The letter as the layout has it; only when Alt made it another character (macOS) the place of the key.
    const letter = event.key.toLowerCase();
    const key = copy && letter !== 'h' && letter !== 'l' ? ({ KeyH: 'h', KeyL: 'l' } as Record<string, string>)[event.code] : letter;
    if (key !== 'h' && key !== 'l') return;
    event.preventDefault();
    event.stopPropagation();
    if (event.repeat) return;
    const to = neighbourGroup(groups, from, key === 'l' ? 1 : -1);
    if (to !== null) void move(id, from, to, copy);
  }

  /** What the view selects, in words. */
  function selectionText(view: View): string {
    const s = view.select;
    const parts: string[] = [];
    const add = (field: string, values: readonly string[]) => {
      if (values.length > 0) parts.push(`${fieldLabel(field)}: ${values.map((v) => valueLabel(field, v)).join(', ')}`);
    };
    add('area', s.areas);
    add('status', s.statuses);
    add('actor', s.actors);
    add('kind', s.kinds);
    add('tags', s.tags);
    add('plan', s.plans);
    if (s.query) parts.push(`"${s.query}"`);
    return parts.length > 0 ? parts.join(' · ') : t('views.selection_all');
  }
</script>

<div class="wrap">
  <div class="bar" role="group" aria-label={t('views.bar')}>
    {#if saved.list.length > 0 || saved.draft || app.can('reorder')}
      <label>
        {t('views.choose')}
        <select value={board ? BOARD_ID : (open?.id ?? '')} onchange={(e) => choose(e.currentTarget.value)}>
          <!-- The built-in view: the board. It is no file and cannot be deleted. -->
          {#if app.can('reorder')}<option value={BOARD_ID}>{t('views.board_builtin')}</option>{/if}
          {#if saved.draft}<option value={DRAFT_ID}>{t('views.draft_option', { name: saved.draft.title })}</option>{/if}
          {#each saved.list as view (view.id)}
            <option value={view.id}>{view.title}</option>
          {/each}
        </select>
      </label>
    {/if}
    <button type="button" onclick={startMaking} disabled={making || app.locked || groupings === null}>{t('views.new')}</button>
  </div>

  <!-- The notes of the saved views are the views' own: the board does not show them. -->
  {#if !board}
    {#if saved.failed}
      <p class="note" role="alert">{t('views.failed')}</p>
    {/if}
    {#if (saved.doc?.problems.length ?? 0) > 0}
      <p class="note">{t('views.problems', { list: saved.doc!.problems.map((p) => `${p.id}: ${p.message}`).join('; ') })}</p>
    {/if}
  {/if}
  <!-- Why the button of a new view is greyed out: also on the board, whose bar has that button. -->
  {#if saved.groupingsFailed && groupings === null}
    <p class="note" role="alert">{t('views.groupings_failed')}</p>
  {:else if groupings === null && !board}
    <p class="note">{t('views.loading')}</p>
  {/if}

  {#if making}
    <form class="card form" aria-label={t('views.new')} onsubmit={(e) => void make(e)}>
      <label>
        {t('views.form.title')}
        <input bind:this={titleBox} bind:value={title} maxlength="300" required />
      </label>
      <label>
        {t('views.form.area')}
        <select bind:value={area}>
          {#each areas as name (name)}
            <option value={name}>{name}</option>
          {/each}
        </select>
      </label>
      <label>
        {t('views.form.group_by')}
        <select bind:value={groupBy}>
          {#each fields as field (field)}
            <option value={field}>{fieldLabel(field)}</option>
          {/each}
        </select>
      </label>
      <label>
        {t('views.form.display')}
        <select bind:value={display}>
          <option value="columns">{t('views.display.columns')}</option>
          <option value="list">{t('views.display.list')}</option>
          <option value="matrix">{t('views.display.matrix')}</option>
        </select>
      </label>
      {#if display === 'matrix'}
        <label>
          {t('views.form.rows')}
          <select bind:value={groupBy2}>
            {#each fields.filter((f) => f !== groupBy) as field (field)}
              <option value={field}>{fieldLabel(field)}</option>
            {/each}
          </select>
        </label>
      {/if}
      {#if draftSelect === null}
        <label class="check">
          <input type="checkbox" bind:checked={fromList} />
          {t('views.form.from_list')}
        </label>
      {/if}
      {#if draftSelect === null && fromList && fromFilter.dropped}
        <p class="note">{t('views.form.dropped')}</p>
      {/if}
      <dl class="preview" aria-label={t('views.preview.title')}>
        <dt>{t('views.preview.name')}</dt>
        <dd>{cleanTitle(title) ?? t('views.preview.untitled')} · {area}</dd>
        <dt>{t('views.preview.groups')}</dt>
        <dd>
          {fieldLabel(groupBy)}{#if display === 'matrix'} × {fieldLabel(groupBy2 !== undefined && groupBy2 !== groupBy ? groupBy2 : (fields.find((f) => f !== groupBy) ?? groupBy))}{/if}, {t(`views.display.${display}` as Key)}
        </dd>
        <dt>{t('views.preview.shows')}</dt>
        <dd>
          {#each parts as part (part.key)}
            <span class="chip"><b>{t(`views.sel.${part.key}` as Key)}</b> {part.values.map((v) => partValue(part.key, v)).join(', ')}</span>
          {:else}
            {t('views.preview.all')}
          {/each}
        </dd>
      </dl>
      {#if makeProblem}<p class="note" role="alert">{makeProblem}</p>{/if}
      <div class="actions">
        <button type="submit" disabled={app.locked || area === ''}>{t('views.create')}</button>
        <button type="button" onclick={() => (making = false)}>{t('views.cancel')}</button>
      </div>
    </form>
  {/if}

  {#if board}
    <BoardView {app} />
  {:else if open === null}
    {#if saved.doc !== null && !making}
      <p class="note">{t('views.none_yet')}</p>
    {/if}
  {:else}
    <section class="open" aria-label={open.title} aria-busy={app.saving}>
      <h2 bind:this={heading} tabindex="-1">{open.title}</h2>
      <div class="head">
        <form class="rename" onsubmit={(e) => void rename(e, open)}>
          <label>
            {t('views.form.title')}
            <input bind:value={renaming} maxlength="300" readonly={app.locked && open.id !== DRAFT_ID} />
          </label>
          <button type="submit" disabled={app.locked}>{t('views.rename')}</button>
        </form>
        <label>
          {t('views.form.group_by')}
          <select
            value={open.group_by}
            disabled={(open.id === DRAFT_ID ? app.saving : app.locked) || fields.length === 0}
            onchange={(e) => setGroupBy(open, e.currentTarget.value as GroupField)}
          >
            {#each fields.includes(open.group_by) ? fields : [open.group_by, ...fields] as field (field)}
              <option value={field}>{fieldLabel(field)}</option>
            {/each}
          </select>
        </label>
        <label>
          {t('views.form.display')}
          <select value={open.display} disabled={open.id === DRAFT_ID ? app.saving : app.locked} onchange={(e) => setDisplay(open, e.currentTarget.value as View['display'])}>
            <option value="columns">{t('views.display.columns')}</option>
            <option value="list">{t('views.display.list')}</option>
            <option value="matrix" disabled={fields.length < 2}>{t('views.display.matrix')}</option>
          </select>
        </label>
        {#if open.display === 'matrix'}
          <label>
            {t('views.form.rows')}
            <select value={open.group_by2 ?? ''} disabled={open.id === DRAFT_ID ? app.saving : app.locked} onchange={(e) => save(open, { group_by2: e.currentTarget.value as GroupField })}>
              {#each fields.filter((f) => f !== open.group_by) as field (field)}
                <option value={field}>{fieldLabel(field)}</option>
              {/each}
            </select>
          </label>
        {/if}
        {#if open.id === DRAFT_ID}
          <button type="button" disabled={app.locked || making} onclick={() => saveDraft(open)}>{t('views.save_draft')}</button>
          <button type="button" onclick={() => void saved.remove(open)}>{t('views.discard')}</button>
        {:else}
          <button type="button" class="danger" disabled={app.locked} onclick={() => void saved.remove(open)}>{t('views.delete')}</button>
        {/if}
        <ExportMenu {app} />
      </div>
      {#if open.id === DRAFT_ID}<p class="note">{t('views.draft')}</p>{/if}
      <p class="muted">{t('views.selection', { what: selectionText(open) })}{open.id === DRAFT_ID ? '' : ` · ${open.id}`}</p>
      {#if renameProblem}<p class="note" role="alert">{renameProblem}</p>{/if}
      {#if open.display === 'matrix'}
        {#if matrixMovable && !app.readOnly}<p class="muted">{t('views.matrix_help')}</p>{/if}
      {:else if movable && !app.readOnly}<p class="muted">{t('views.help')}</p>{/if}
      <p class="sr-only" aria-live="polite">{moved}</p>
      <div class="layout">
        <div class="main">
          {#if open.display === 'matrix' && grouping && grouping2}
            <GroupMatrix
              rows={rowGroups}
              columns={groups}
              count={(cell) => cellOf(cell)?.items.length ?? 0}
              rowLabel={(value) => valueLabel(open.group_by2 ?? '', value)}
              columnLabel={(value) => valueLabel(open.group_by, value)}
              label={t('views.matrix_label', { name: open.title })}
              corner={t('views.matrix_corner', { rows: fieldLabel(open.group_by2 ?? ''), columns: fieldLabel(open.group_by) })}
              cellLabel={(cell, n) => t(n === 1 ? 'views.cell_one' : 'views.cell', { cell: cellText(cell), n })}
              opened={openedCell}
              onopen={(cell) => (openedCell = cell)}
              dragging={cellDrag !== null}
              fingerOver={fingerCell}
              ondropcell={(cell) => {
                const drag = cellDrag;
                cellDrag = null;
                if (drag) void moveInMatrix(drag.id, drag.from, cell);
              }}
            />
            {#if openedCell}
              {@const cell = openedCell}
              <section class="cell" aria-label={cellText(cell)}>
                <h3>{cellText(cell)} <span class="muted">({cellOf(cell)?.items.length ?? 0})</span></h3>
                <ul>
                  {#each cellOf(cell)?.items ?? [] as task (task.id)}
                    <li
                      draggable={matrixMovable && !app.locked}
                      ondragstart={(e) => {
                        if (!matrixMovable || app.locked) return e.preventDefault();
                        cellDrag = { id: task.id, from: cell };
                        e.dataTransfer?.setData('text/plain', task.id);
                      }}
                      ondragend={() => (cellDrag = null)}
                    >
                      {#if matrixMovable}
                        <!-- A finger drags by this grip (the keys and a screen reader have the keys of the matrix). -->
                        <span
                          class="grip"
                          data-hint={t('hint.ui.board.grip')}
                          role="presentation"
                          aria-hidden="true"
                          onpointerdown={(e) => cellGrip(e, task.id, 'start')}
                          onpointermove={(e) => cellGrip(e, task.id, 'move')}
                          onpointerup={(e) => cellGrip(e, task.id, 'end')}
                          onpointercancel={(e) => cellGrip(e, task.id, 'cancel')}>⠿</span
                        >
                      {/if}
                      <button
                        type="button"
                        class="item"
                        data-matrix-item={task.id}
                        class:selected={task.id === app.selectedId}
                        aria-current={task.id === app.selectedId ? 'true' : undefined}
                        onclick={() => app.select(task.id)}
                        onkeydown={(e) => onCellItemKey(e, task.id, cell)}
                      >
                        <span class="title">{markHidden(task.title)}</span>
                        <span class="id">{task.id}</span>
                      </button>
                    </li>
                  {:else}
                    <li class="muted">{t('board.empty')}</li>
                  {/each}
                </ul>
              </section>
            {/if}
          {:else if open.display === 'matrix' && grouping && open.group_by2 === undefined}
            <p class="note">{t('views.matrix_rows')}</p>
          {:else if open.display !== 'matrix' && grouping}
            <Groups
              {groups}
              mode={open.display === 'list' ? 'list' : 'columns'}
              label={(value) => valueLabel(open.group_by, value)}
              collapsed={saved.collapsedOf(open)}
              ontoggle={(value) => void saved.toggle(open, formOf(open), value)}
              busy={app.locked}
              ondrop={movable ? (id, from, to, copy) => void move(id, from, to, copy) : undefined}
              canDrop={(_id, from, to) => from !== to}
              columnsLabel={t('views.columns', { name: open.title })}
              target={(value) => groupTarget(open, value)}
              gripHint={t('hint.ui.board.grip')}
            >
              {#snippet item(task, group)}
                <button
                  type="button"
                  class="item"
                  data-view-item={task.id}
                  class:selected={task.id === app.selectedId}
                  aria-current={task.id === app.selectedId ? 'true' : undefined}
                  onclick={() => app.select(task.id)}
                  onkeydown={(e) => onItemKey(e, task.id, group.value)}
                  use:contextTarget={groupTarget(open, group.value)}
                >
                  <span class="title">{markHidden(task.title)}</span>
                  <span class="id">{task.id}</span>
                </button>
              {/snippet}
            </Groups>
          {:else if groupings !== null}
            <p class="note">{t('views.unknown_field', { field: grouping ? (open.group_by2 ?? '') : open.group_by })}</p>
          {/if}
        </div>
        <Detail {app} />
      </div>
    </section>
  {/if}
</div>

<style>
  .wrap {
    display: flex;
    flex-direction: column;
    gap: 0.6rem;
    height: 100%;
    min-height: 0;
  }
  .bar,
  .head {
    display: flex;
    flex-wrap: wrap;
    gap: 0.6rem;
    align-items: end;
  }
  label {
    display: grid;
    gap: 0.2rem;
    font-size: 0.8rem;
    color: var(--muted);
  }
  label.check {
    display: flex;
    align-items: center;
    gap: 0.4rem;
  }
  .form {
    display: flex;
    flex-wrap: wrap;
    gap: 0.6rem;
    align-items: end;
  }
  .preview {
    flex-basis: 100%;
    margin: 0;
    padding: 0.5rem 0.7rem;
    display: grid;
    grid-template-columns: max-content 1fr;
    gap: 0.2rem 0.8rem;
    background: var(--surface-2);
    border-radius: var(--radius);
    font-size: 0.85rem;
  }
  .preview dt {
    color: var(--muted);
  }
  .preview dd {
    margin: 0;
  }
  .chip {
    display: inline-block;
    margin-right: 0.5rem;
  }
  .rename {
    display: flex;
    gap: 0.4rem;
    align-items: end;
  }
  .actions {
    display: flex;
    gap: 0.4rem;
  }
  .note,
  .muted {
    margin: 0;
    color: var(--muted);
    font-size: 0.85rem;
  }
  button {
    background: var(--surface-2);
    color: var(--text);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 0.35rem 0.8rem;
    cursor: pointer;
  }
  button:disabled {
    opacity: 0.6;
    cursor: default;
  }
  h2 {
    margin: 0;
    font-size: 1rem;
    overflow-wrap: anywhere;
  }
  .danger {
    color: var(--bad);
  }
  .open {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    min-height: 0;
    flex: 1;
  }
  .layout {
    display: grid;
    grid-template-columns: minmax(0, 1fr) minmax(16rem, 22rem);
    gap: 1rem;
    flex: 1;
    min-height: 0;
  }
  @media (max-width: 52rem) {
    .layout {
      grid-template-columns: 1fr;
    }
  }
  .main {
    min-width: 0;
    overflow: auto;
  }
  .item {
    display: grid;
    gap: 0.2rem;
    width: 100%;
    text-align: left;
    background: var(--surface-2);
    color: var(--text);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 0.4rem 0.5rem;
    cursor: pointer;
  }
  .cell {
    margin-top: 0.6rem;
    background: var(--surface);
    border: 1px solid var(--line);
    border-radius: var(--radius);
    padding: 0.4rem 0.5rem;
  }
  .cell h3 {
    margin: 0 0 0.4rem;
    font-size: 0.85rem;
  }
  .cell ul {
    list-style: none;
    margin: 0;
    padding: 0;
    display: grid;
    gap: 0.35rem;
  }
  .cell li {
    display: flex;
    gap: 0.3rem;
  }
  .cell li > .item {
    flex: 1;
    min-width: 0;
  }
  .cell li[draggable='true'] {
    cursor: grab;
  }
  .grip {
    display: flex;
    align-items: center;
    justify-content: center;
    min-width: 1.6rem;
    color: var(--muted);
    cursor: grab;
    touch-action: none;
    user-select: none;
  }
  .item.selected {
    box-shadow: inset 3px 0 0 var(--accent);
  }
  .title {
    overflow-wrap: anywhere;
  }
  .id {
    font-family: var(--mono);
    font-size: 0.75rem;
    color: var(--muted);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
</style>
