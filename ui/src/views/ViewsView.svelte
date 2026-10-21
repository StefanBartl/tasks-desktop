<script lang="ts">
  // The tab of the saved views: which view is open, a form to make one, and the open view drawn in groups. A view is a
  // file of the vault (the engine reads and writes it); the fields it can be grouped by and their values are the
  // engine's (`tasks.groupings`). Nothing here names a field's values or judges a view: a change is sent, and the engine
  // says what came of it.
  import { tick, untrack } from 'svelte';
  import type { App } from '../lib/app.svelte';
  import type { GroupField, View, ViewSelect } from '../lib/contract';
  import { groupsOf, keepsGroup, neighbourGroup, NONE, type Grouping } from '../lib/groups';
  import { labelOf, translate, type Key } from '../lib/i18n';
  import { markHidden } from '../lib/text';
  import { cleanTitle, emptySelect, formOf, selectOfFilter, type ViewForm } from '../lib/views';
  import { selectOfGroup } from '../lib/viewMenu';
  import { DRAFT_ID } from '../lib/state/views.svelte';
  import Detail from './Detail.svelte';
  import Groups from './Groups.svelte';

  let { app }: { app: App } = $props();
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
    if (field === 'status' || field === 'actor' || field === 'state') return labelOf(app.lang, field, value);
    if (field === 'prio') return `P${value}`;
    return value;
  }

  // ── the form of a new view ──
  let making = $state(false);
  let title = $state('');
  let area = $state('');
  let groupBy = $state<GroupField>('status');
  let display = $state<'columns' | 'list'>('columns');
  let fromList = $state(true);
  /** The selection of the view being tried, when it is the one being saved (then not the filter of the list). */
  let draftSelect = $state.raw<ViewSelect | null>(null);
  let makeProblem = $state('');
  let titleBox = $state<HTMLInputElement | null>(null);

  const fromFilter = $derived(selectOfFilter(app.filter));

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
    const form: ViewForm = {
      title: clean,
      display,
      group_by: groupBy,
      collapsed: [],
      select: draftSelect ?? (fromList ? fromFilter.select : emptySelect()),
    };
    if (await saved.create(area, form)) making = false;
  }

  /** Save the view being tried: the form of a new view, with its name, field, form and selection. */
  function saveDraft(draft: View): void {
    startMaking();
    title = draft.title;
    groupBy = draft.group_by;
    display = draft.display === 'list' ? 'list' : 'columns';
    draftSelect = draft.select;
  }

  /** The context menu of a group: the same view narrowed to the group, where a view can hold that. */
  function groupMenu(event: MouseEvent, view: View, value: string): void {
    const select = selectOfGroup(view.select, view.group_by, value);
    if (select) void app.openViewMenu(event, `${view.title}: ${valueLabel(view.group_by, value)}`, select);
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
  const groups = $derived(grouping ? groupsOf(viewTasks, grouping) : []);
  /** A task is moved between groups only where the engine writes the field by a set or the list of tags (not the area). */
  const movable = $derived(grouping !== null && grouping.writable && (grouping.mode === 'set' || grouping.mode === 'tags'));

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

  /** Shift with h or l on a card: the group before or after, as the keys of the board. */
  function onItemKey(event: KeyboardEvent, id: string, from: string): void {
    if (!movable || !event.shiftKey || event.ctrlKey || event.altKey || event.metaKey) return;
    const key = event.key.toLowerCase();
    if (key !== 'h' && key !== 'l') return;
    event.preventDefault();
    event.stopPropagation();
    if (event.repeat) return;
    const to = neighbourGroup(groups, from, key === 'l' ? 1 : -1);
    if (to !== null) void move(id, from, to, false);
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
    {#if saved.list.length > 0 || saved.draft}
      <label>
        {t('views.choose')}
        <select value={open?.id ?? ''} onchange={(e) => e.currentTarget.value !== DRAFT_ID && saved.choose(e.currentTarget.value)}>
          {#if saved.draft}<option value={DRAFT_ID}>{t('views.draft_option', { name: saved.draft.title })}</option>{/if}
          {#each saved.list as view (view.id)}
            <option value={view.id}>{view.title}</option>
          {/each}
        </select>
      </label>
    {/if}
    <button type="button" onclick={startMaking} disabled={making || app.saving || groupings === null}>{t('views.new')}</button>
  </div>

  {#if saved.failed}
    <p class="note" role="alert">{t('views.failed')}</p>
  {/if}
  {#if (saved.doc?.problems.length ?? 0) > 0}
    <p class="note">{t('views.problems', { list: saved.doc!.problems.map((p) => `${p.id}: ${p.message}`).join('; ') })}</p>
  {/if}
  {#if saved.groupingsFailed && groupings === null}
    <p class="note" role="alert">{t('views.groupings_failed')}</p>
  {:else if groupings === null}
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
        </select>
      </label>
      {#if draftSelect === null}
        <label class="check">
          <input type="checkbox" bind:checked={fromList} />
          {t('views.form.from_list')}
        </label>
      {/if}
      {#if draftSelect === null && fromList && fromFilter.dropped}
        <p class="note">{t('views.form.dropped')}</p>
      {/if}
      {#if makeProblem}<p class="note" role="alert">{makeProblem}</p>{/if}
      <div class="actions">
        <button type="submit" disabled={app.saving || area === ''}>{t('views.create')}</button>
        <button type="button" onclick={() => (making = false)}>{t('views.cancel')}</button>
      </div>
    </form>
  {/if}

  {#if open === null}
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
            <input bind:value={renaming} maxlength="300" />
          </label>
          <button type="submit" disabled={app.saving}>{t('views.rename')}</button>
        </form>
        <label>
          {t('views.form.group_by')}
          <select
            value={open.group_by}
            disabled={app.saving || fields.length === 0}
            onchange={(e) => save(open, { group_by: e.currentTarget.value as GroupField, collapsed: [] })}
          >
            {#each fields.includes(open.group_by) ? fields : [open.group_by, ...fields] as field (field)}
              <option value={field}>{fieldLabel(field)}</option>
            {/each}
          </select>
        </label>
        <label>
          {t('views.form.display')}
          <select
            value={open.display === 'list' ? 'list' : 'columns'}
            disabled={app.saving}
            onchange={(e) => save(open, { display: e.currentTarget.value as 'columns' | 'list' })}
          >
            <option value="columns">{t('views.display.columns')}</option>
            <option value="list">{t('views.display.list')}</option>
          </select>
        </label>
        {#if open.id === DRAFT_ID}
          <button type="button" disabled={app.saving || making} onclick={() => saveDraft(open)}>{t('views.save_draft')}</button>
          <button type="button" onclick={() => void saved.remove(open)}>{t('views.discard')}</button>
        {:else}
          <button type="button" class="danger" disabled={app.saving} onclick={() => void saved.remove(open)}>{t('views.delete')}</button>
        {/if}
      </div>
      {#if open.id === DRAFT_ID}<p class="note">{t('views.draft')}</p>{/if}
      <p class="muted">{t('views.selection', { what: selectionText(open) })}{open.id === DRAFT_ID ? '' : ` · ${open.id}`}</p>
      {#if open.display === 'matrix'}
        <p class="note">{t('views.matrix_later')}</p>
      {/if}
      {#if renameProblem}<p class="note" role="alert">{renameProblem}</p>{/if}
      {#if movable}<p class="muted">{t('views.help')}</p>{/if}
      <p class="sr-only" aria-live="polite">{moved}</p>
      <div class="layout">
        <div class="main">
          {#if grouping}
            <Groups
              {groups}
              mode={open.display === 'list' ? 'list' : 'columns'}
              label={(value) => valueLabel(open.group_by, value)}
              collapsed={open.collapsed}
              ontoggle={(value) => void saved.toggle(open, formOf(open), value)}
              busy={app.saving}
              ondrop={movable ? (id, from, to, copy) => void move(id, from, to, copy) : undefined}
              canDrop={(_id, from, to) => from !== to}
              columnsLabel={t('views.columns', { name: open.title })}
              onmenu={(e, value) => groupMenu(e, open, value)}
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
                  oncontextmenu={(e) => groupMenu(e, open, group.value)}
                >
                  <span class="title">{markHidden(task.title)}</span>
                  <span class="id">{task.id}</span>
                </button>
              {/snippet}
            </Groups>
          {:else if groupings !== null}
            <p class="note">{t('views.unknown_field', { field: open.group_by })}</p>
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
