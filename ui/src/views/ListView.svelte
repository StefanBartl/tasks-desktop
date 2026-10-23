<script lang="ts">
  import type { App } from '../lib/app.svelte';
  import { hintOf, labelOf, translate, type Key } from '../lib/i18n';
  import { markHidden } from '../lib/text';
  import Detail from './Detail.svelte';
  import FinishedList from './FinishedList.svelte';
  import TextHits from './TextHits.svelte';
  import TaskRow from './TaskRow.svelte';
  import MultiSelect from 'appkit-ui/MultiSelect.svelte';
  import Info from 'appkit-ui/Info.svelte';
  import { marksLegend } from '../lib/legend';
  import {
    DATE_KEYS,
    FIELD_KEYS,
    NONE,
    RANGE_KEYS,
    REMINDER_CHOICES,
    UPDATED_WINDOWS,
    activeFilters,
    areaLabel,
    boundOptions,
    extraCount,
    fieldOptions,
    without,
    withSelected,
    type ActiveFilter,
    type Bound,
    type DateKey,
    type FieldKey,
    type RangeKey,
    type ReminderChoice,
    type UpdatedWindow,
  } from '../lib/filter';
  import { boundLabel, chipLabel as chipText, valueLabel as valueText } from '../lib/filter-chips';
  import { tick, untrack } from 'svelte';
  import { badTag, parseTags } from '../lib/fields';
  import { classChange, isApplyKey, marksKeyOf, type MoveCheck } from '../lib/bulk';
  import { REMIND_CHOICES } from '../lib/remind';
  import { parseSort, SORTS } from '../lib/sort';

  let { app, searchBox = $bindable(null) }: { app: App; searchBox?: HTMLInputElement | null } =
    $props();

  const t = (key: Key, params: Record<string, string | number> = {}) =>
    translate(app.lang, key, params);

  // The engine names the values (`hello.enums`); a word this version has no text for is shown as it is.
  const statuses = $derived(app.ranges.statuses);
  const actors = $derived([...app.ranges.actors, 'none']);

  // A name for the filter and the order shown now: kept in this browser, for the vault that is read.
  let saveListOpen = $state(false);
  let listName = $state('');
  function keepList(): void {
    if (listName.trim() === '') return;
    if (app.saveList(listName) === 'saved') {
      listName = '';
      saveListOpen = false;
    }
  }

  // The filters beyond area, status and actor: one choice per field, the values the tasks have, with how many.
  let moreOpen = $state(false);
  const fieldLabel = (key: FieldKey): string => t(`filter.field.${key}` as Key);
  const valueLabel = (key: FieldKey, value: string): string => valueText(app.lang, key, value);

  // "At least / at most" for the fields with an order: the values the tasks have, in their order.
  const rangeChoices = $derived(
    RANGE_KEYS.map((key) => ({ key, options: boundOptions(app.tasks, key) })).filter(
      (r) => r.options.length > 0 || app.filter.ranges[r.key] !== undefined,
    ),
  );
  /** The values to choose from; a bound that is on although no task has it any more stays, so it can be seen and changed. */
  const boundsWith = (options: readonly Bound[], on: Bound | undefined): Bound[] =>
    on && !options.some((o) => o.label === on.label) ? [...options, on].sort((a, b) => a.n - b.n) : [...options];
  /** One end of a range chosen (or taken away with the empty choice); the other end stays. */
  function setBound(key: RangeKey, end: 'min' | 'max', options: readonly Bound[], label: string): void {
    const found = options.find((o) => o.label === label);
    const range = { ...(app.filter.ranges[key] ?? {}) };
    if (found) range[end] = found;
    else delete range[end];
    app.filter = { ...app.filter, ranges: { ...app.filter.ranges, [key]: range } };
  }
  /** One end of a span of days typed (or cleared). */
  function setDay(key: DateKey, end: 'from' | 'to', value: string): void {
    const span = { ...(app.filter.dates[key] ?? {}) };
    if (/^\d{4}-\d{2}-\d{2}$/.test(value)) span[end] = value;
    else delete span[end];
    app.filter = { ...app.filter, dates: { ...app.filter.dates, [key]: span } };
  }
  // What the tasks have: it follows the tasks and the language only, not every change of a filter.
  const baseChoices = $derived(
    FIELD_KEYS.map((key) => ({
      key,
      options: fieldOptions(app.tasks, key).map((o) => ({
        value: o.value,
        label: valueLabel(key, o.value),
        suffix: String(o.count),
      })),
    })),
  );
  const fieldChoices = $derived(
    baseChoices
      // A field that no task has a value for offers nothing to choose, unless it is on.
      .filter((f) => f.options.some((o) => o.value !== NONE) || (app.filter.fields[f.key]?.length ?? 0) > 0)
      // A value that is on although no task has it any more stays in the choice (with 0), so it can be switched off.
      .map((f) => ({
        ...f,
        options: withSelected(f.options, app.filter.fields[f.key] ?? [], (v) => ({
          value: v,
          label: valueLabel(f.key, v),
          suffix: '0',
        })),
      })),
  );
  const chipLabel = (item: ActiveFilter): string =>
    chipText(app.lang, app.filter, item, { short: app.shortAreas, all: app.allAreaNames });
  const chips = $derived(activeFilters(app.filter).map((item) => ({ item, label: chipLabel(item) })));
  let chipList: HTMLUListElement | undefined = $state();
  let moreSummary: HTMLElement | undefined = $state();
  /** Switch one filter off and keep the focus where it was: on the chip that took its place, else on the fold. */
  async function removeChip(item: ActiveFilter, index: number): Promise<void> {
    app.filter = without(app.filter, item);
    await tick();
    const buttons = chipList?.querySelectorAll<HTMLButtonElement>('li button');
    (buttons && buttons.length > 0 ? buttons[Math.min(index, buttons.length - 1)] : moreSummary)?.focus();
  }
  async function clearFilters(): Promise<void> {
    app.resetFilter();
    await tick();
    moreSummary?.focus();
  }
  const extraOn = $derived(extraCount(app.filter));
  const areaOptions = $derived(
    app.areaNames
      .map((name) => ({
        value: name,
        label: app.shortAreas ? areaLabel(name, app.allAreaNames) : name,
        title: name,
      }))
      .sort((x, y) => x.label.localeCompare(y.label)),
  );
  const shown = $derived(app.shown);

  // A mark that the filter hides is not changed behind the person's back: marks follow what the list shows.
  $effect(() => {
    void shown;
    untrack(() => app.keepMarksShown());
  });

  // The bulk bar changes what is chosen in it, all at once, when the button is pressed (a select alone never writes).
  // `effort` and `remind` are '' (keep), '-' (take away) or a value; the tags are typed.
  const blank = { status: '', prio: '', actor: '', effort: '', remind: '', addTags: '', removeTags: '' };
  let draft = $state({ ...blank });
  $effect(() => {
    if (app.marks.length === 0) draft = { ...blank };
  });
  const chosen = $derived(
    Object.values(draft).some((value) => value.trim() !== ''),
  );
  async function applyDraft(): Promise<void> {
    const patch: Record<string, unknown> = {};
    if (draft.status) patch.status = draft.status;
    if (draft.prio) patch.prio = Number(draft.prio);
    if (draft.actor) patch.actor = draft.actor;
    if (draft.effort) patch.effort = draft.effort === '-' ? null : draft.effort;
    if (draft.remind) patch.remind = draft.remind === '-' ? null : draft.remind;
    const add = parseTags(draft.addTags);
    const remove = parseTags(draft.removeTags);
    const bad = badTag(add);
    // A tag the engine would refuse is told here, and the text stays for the person to change.
    if (bad !== null) {
      app.tell('error', 'field.tags_invalid', { tag: bad });
      return;
    }
    if (Object.keys(patch).length === 0 && add.length === 0 && remove.length === 0) return;
    // What stays marked (a failure) keeps the choice for the second try; with no marks left it starts over.
    await app.bulkSet(patch, add.length > 0 || remove.length > 0 ? { add, remove } : undefined);
  }

  // Moving the marked tasks: an area is chosen, ONE dry run says per task what would happen, and only then the button
  // moves those that can go. The answer belongs to the area and the marks it was asked for: another choice hides it.
  let moveTo = $state('');
  let moveSelect = $state<HTMLSelectElement>();
  let moveResult = $state<{ to: string; marks: string; checks: MoveCheck[] } | null>(null);
  const marksKey = $derived(marksKeyOf(app.marks, app.tasks));
  const moveShown = $derived(
    moveResult !== null && moveResult.to === moveTo && moveResult.marks === marksKey ? moveResult.checks : null,
  );
  const movable = $derived(moveShown?.filter((c) => c.reasons.length === 0 && c.newId !== '').length ?? 0);
  $effect(() => {
    if (app.marks.length === 0) {
      moveTo = '';
      moveResult = null;
    }
  });
  // The data class of an area decides where its tasks may be kept: a move across classes is told, counted per pair.
  const moveClasses = $derived.by(() => {
    if (!moveShown) return [];
    const classOf = (name: string) => app.hubAreas.find((a) => a.name === name)?.data_class;
    const to = classOf(moveTo);
    const counts = new Map<string, number>();
    for (const c of moveShown) {
      if (c.reasons.length > 0) continue;
      const area = app.tasks.find((task) => task.id === c.id)?.area;
      if (area === undefined) continue;
      const change = classChange(classOf(area), to);
      if (change) counts.set(change.from, (counts.get(change.from) ?? 0) + 1);
    }
    return [...counts].map(([from, n]) => ({ from, to: to ?? '?', n }));
  });
  // The dry run takes seconds with many tasks: while it runs the button says it is busy and a click does nothing, so
  // it is asked once (not `disabled`: a disabled button drops the focus the person is working with).
  let checking = $state(false);
  async function checkMoves(): Promise<void> {
    const to = moveTo;
    const key = marksKey;
    if (to === '' || checking) return;
    checking = true;
    try {
      const checks = await app.previewBulkMove(to);
      // The person may have chosen another area or other tasks meanwhile: a late answer is not shown for them.
      if (checks !== null && moveTo === to && marksKey === key) moveResult = { to, marks: key, checks };
    } finally {
      checking = false;
    }
  }
  async function doMoves(): Promise<void> {
    if (!moveShown || movable === 0) return;
    if ((await app.bulkMove(moveTo, moveShown)) > 0) {
      moveTo = '';
      moveResult = null;
      // The button is off now (no area chosen): the focus goes to the choice of the area, not to the page.
      await tick();
      moveSelect?.focus();
    }
  }

  function applyOnEnter(event: KeyboardEvent): void {
    // An Enter that ends the composition of an input method is not the person asking to apply.
    if (!isApplyKey(event) || app.saving || !chosen) return;
    event.preventDefault();
    void applyDraft();
  }

  // The first rows are drawn at once and the rest in the frames after: a
  // list of six hundred rows is not one block of work between the click and
  // the first row (measured: about 150 ms).
  const FIRST = 60;
  const STEP = 200;
  let limit = $state(FIRST);
  const visible = $derived(shown.slice(0, limit));
  $effect(() => {
    if (limit >= shown.length) return;
    const frame = requestAnimationFrame(() => {
      limit = Math.min(shown.length, limit + STEP);
    });
    return () => cancelAnimationFrame(frame);
  });

  // The row that j and k moved to stays in view. The rows come in frames:
  // a selected row that is not drawn yet is scrolled to when it is (the
  // count of the rows that are drawn is read here for that).
  $effect(() => {
    if (app.selectedId === null) return;
    void visible.length;
    const frame = requestAnimationFrame(() => {
      document
        .querySelector('.rows [aria-current="true"]')
        ?.scrollIntoView({ block: 'nearest' });
    });
    return () => cancelAnimationFrame(frame);
  });

</script>

<div class="split">
  <section class="list" aria-label={t('nav.list')}>
    <div class="filters">
      <input
        bind:this={searchBox}
        type="search"
        data-hint={t('hint.ui.list.search')}
        placeholder={t('list.search')}
        aria-label={t('list.search')}
        value={app.filter.query}
        oninput={(e) => app.setQuery(e.currentTarget.value)}
      />
      <MultiSelect
        label={t('nav.areas')}
        hint={t('hint.ui.list.areas')}
        options={areaOptions}
        selected={app.filter.areas}
        onchange={(areas) => (app.filter = { ...app.filter, areas })}
        resetLabel={t('multi.reset')}
        searchLabel={t('multi.search')}
      />
      <MultiSelect
        label={t('list.filter.status')}
        hint={t('hint.ui.list.status')}
        options={statuses.map((s) => ({ value: s, label: labelOf(app.lang, 'status', s) }))}
        selected={app.filter.statuses}
        onchange={(statuses) => (app.filter = { ...app.filter, statuses })}
        resetLabel={t('multi.reset')}
        searchLabel={t('multi.search')}
      />
      <MultiSelect
        label={t('list.filter.actor')}
        hint={t('hint.ui.list.actor')}
        options={actors.map((a) => ({
          value: a,
          label: labelOf(app.lang, 'actor', a),
          title: hintOf(app.lang, 'actor', `${a}.hint`),
        }))}
        selected={app.filter.actors}
        onchange={(actors) => (app.filter = { ...app.filter, actors })}
        resetLabel={t('multi.reset')}
        searchLabel={t('multi.search')}
      />
      <label class="pick sort" data-hint={t('hint.ui.list.sort')}>
        <span>{t('sort.label')}</span>
        <select data-sort value={app.sort} onchange={(e) => app.setSort(parseSort(e.currentTarget.value))}>
          {#each SORTS as word (word)}<option value={word}>{t(`sort.${word}` as Key)}</option>{/each}
        </select>
      </label>
      <label class="pick lists" data-hint={t('hint.ui.list.lists')}>
        <span>{t('lists.label')}</span>
        <select
          data-lists
          value={app.shownList ? `mine:${app.shownList.name}` : ''}
          onchange={(e) => {
            const value = e.currentTarget.value;
            if (value.startsWith('mine:')) app.applyList(value.slice(5));
            else if (value.startsWith('engine:')) {
              app.applyEngineList(value.slice(7));
              // The list of the engine is not kept as the chosen one: the choice goes back to what is shown.
              e.currentTarget.value = app.shownList ? `mine:${app.shownList.name}` : '';
            }
          }}
        >
          <option value="">{t('lists.none')}</option>
          {#if app.lists.length > 0}
            <optgroup label={t('lists.mine')}>
              {#each app.lists as list (list.name)}<option value={`mine:${list.name}`}>{list.name}</option>{/each}
            </optgroup>
          {/if}
          {#if app.engineLists.length > 0}
            <optgroup label={t('lists.engine')}>
              {#each app.engineLists as list (list.name)}
                <option value={`engine:${list.name}`} title={list.summary}>{list.name}</option>
              {/each}
            </optgroup>
          {/if}
        </select>
      </label>
      {#if app.shownList}
        {@const shown = app.shownList}
        <button
          type="button"
          class="list-delete"
          aria-label={t('lists.delete', { name: shown.name })}
          title={t('lists.delete', { name: shown.name })}
          onclick={() => app.deleteList(shown.name)}>×</button
        >
      {/if}
      <details class="save-list" bind:open={saveListOpen}>
        <summary data-hint={t('hint.ui.list.save')}>{t('lists.save')}</summary>
        <!-- Not a form: a page of tasks has none (the tests of markup count them), and Enter does the same. -->
        <div class="save-row" role="group" aria-label={t('lists.save')}>
          <input
            type="text"
            aria-label={t('lists.name')}
            placeholder={t('lists.name')}
            maxlength="40"
            bind:value={listName}
            onkeydown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                keepList();
              }
            }}
          />
          <button type="button" disabled={listName.trim() === ''} onclick={keepList}>{t('lists.save_go')}</button>
        </div>
      </details>
    </div>
    <details class="more" open={moreOpen} ontoggle={(e) => (moreOpen = e.currentTarget.open)}>
      <summary bind:this={moreSummary} data-hint={t('hint.ui.list.more')}>{t('filter.more')}{extraOn > 0 ? ` (${extraOn})` : ''}</summary>
      <div class="more-body">
        {#each fieldChoices as f (f.key)}
          <MultiSelect
            label={fieldLabel(f.key)}
            options={f.options}
            selected={app.filter.fields[f.key] ?? []}
            onchange={(next) => (app.filter = { ...app.filter, fields: { ...app.filter.fields, [f.key]: next } })}
            resetLabel={t('multi.reset')}
            searchLabel={t('multi.search')}
          />
        {/each}
        {#if app.quickWinSet !== undefined || app.filter.quickWin}
          <label class="pick" data-hint={t('hint.quick_win')}>
            <input
              type="checkbox"
              checked={app.filter.quickWin}
              onchange={(e) => (app.filter = { ...app.filter, quickWin: e.currentTarget.checked })}
            />
            <span>{t('filter.quick_win')}</span>
          </label>
        {/if}
        <label class="pick" data-hint={t('hint.cross')}>
          <input
            type="checkbox"
            checked={app.filter.cross}
            onchange={(e) => (app.filter = { ...app.filter, cross: e.currentTarget.checked })}
          />
          <span>{t('filter.cross')}</span>
        </label>
        <label class="pick">
          <span>{t('filter.updated')}</span>
          <select
            value={app.filter.updated}
            onchange={(e) => (app.filter = { ...app.filter, updated: e.currentTarget.value as UpdatedWindow })}
          >
            <option value="">{t('filter.whatever')}</option>
            {#each UPDATED_WINDOWS as w (w)}<option value={w}>{t(`filter.updated.${w}` as Key)}</option>{/each}
          </select>
        </label>
        <label class="pick">
          <span>{t('filter.reminder')}</span>
          <select
            value={app.filter.reminder}
            onchange={(e) => (app.filter = { ...app.filter, reminder: e.currentTarget.value as ReminderChoice })}
          >
            <option value="">{t('filter.whatever')}</option>
            {#each REMINDER_CHOICES as r (r)}<option value={r}>{t(`filter.reminder.${r}` as Key)}</option>{/each}
          </select>
        </label>
        {#each rangeChoices as r (r.key)}
          {#each ['min', 'max'] as const as end (end)}
            <label class="pick" data-hint={r.key === 'prio' ? t('filter.range.prio_hint') : r.key === 'effort' ? t('filter.range.effort_hint') : undefined}>
              <span>{t(`filter.range.${end}` as Key, { field: t(`filter.field.${r.key}` as Key) })}</span>
              <select
                data-range={`${r.key}-${end}`}
                value={app.filter.ranges[r.key]?.[end]?.label ?? ''}
                onchange={(e) => setBound(r.key, end, r.options, e.currentTarget.value)}
              >
                <option value="">{t('filter.whatever')}</option>
                {#each boundsWith(r.options, app.filter.ranges[r.key]?.[end]) as o (o.label)}
                  <option value={o.label}>{boundLabel(r.key, o.label)}</option>
                {/each}
              </select>
            </label>
          {/each}
        {/each}
        {#each DATE_KEYS as key (key)}
          {#each ['from', 'to'] as const as end (end)}
            <label class="pick">
              <span>{t(`filter.date.${end}` as Key, { field: t(`filter.date.${key}` as Key) })}</span>
              <input
                type="date"
                data-date={`${key}-${end}`}
                value={app.filter.dates[key]?.[end] ?? ''}
                onchange={(e) => setDay(key, end, e.currentTarget.value)}
              />
            </label>
          {/each}
        {/each}
      </div>
    </details>
    {#if chips.length > 0}
      <ul class="active" aria-label={t('filter.active')} bind:this={chipList}>
        {#each chips as c, index (c.item.kind + ':' + c.item.value)}
          <li>
            <span>{c.label}</span>
            <button
              type="button"
              aria-label={t('filter.remove', { what: c.label })}
              onclick={() => void removeChip(c.item, index)}>×</button
            >
          </li>
        {/each}
        <li><button type="button" class="linkish" onclick={() => void clearFilters()}>{t('filter.clear')}</button></li>
      </ul>
    {/if}
    <!-- Only the count is a live region: the buttons and the key help beside it are not to be read out again on every change. -->
    <p class="count">
      <span role="status" data-hint={t('hint.ui.list.count')}>{t('list.count', { shown: shown.length, total: app.tasks.length })}</span>
      <span class="help"
        ><button type="button" class="linkish" data-hint={t('hint.ui.list.mark_all')} onclick={() => app.markShown()}>{t('bulk.all')}</button> ·
        {#if app.can('check')}<button type="button" class="linkish" data-hint={t('hint.ui.list.check')} onclick={() => void app.openChecks()}>{t('check.open')}</button> ·{/if}
        {#if app.can('estimate')}<button type="button" class="linkish" data-hint={t('hint.ui.list.estimate')} onclick={() => app.openMatrix()}>{t('matrix.open')}</button> ·{/if}
        {t('list.help')}</span
      >
      <!-- The marks of the rows, explained with one tab stop (the rows themselves would be hundreds). -->
      <Info hint={marksLegend(app.lang)} label={t('hint.about', { what: t('mark.legend.what') })} />
    </p>
    {#if app.can('finished')}
      <label class="show-finished" data-hint={t('hint.ui.list.show_finished')}
        ><input type="checkbox" bind:checked={app.showFinished} /> {t('list.show_finished')}</label
      >
    {/if}
    {#if app.marks.length > 0}
      <div class="bulk" role="group" aria-label={t('bulk.change')}>
        <strong aria-live="polite">{t('bulk.count', { n: app.marks.length })}</strong>
        <label>
          <span class="sr-only">{t('field.status')}</span>
          <select bind:value={draft.status} disabled={app.saving}>
            <option value="">{t('field.status')}: {t('bulk.keep')}</option>
            {#each statuses as s (s)}<option value={s}>{labelOf(app.lang, 'status', s)}</option>{/each}
          </select>
        </label>
        <label>
          <span class="sr-only">{t('field.prio')}</span>
          <select bind:value={draft.prio} disabled={app.saving}>
            <option value="">{t('field.prio')}: {t('bulk.keep')}</option>
            {#each app.ranges.prios as p (p)}<option value={String(p)}>P{p}</option>{/each}
          </select>
        </label>
        <label>
          <span class="sr-only">{t('field.actor')}</span>
          <select bind:value={draft.actor} disabled={app.saving}>
            <option value="">{t('field.actor')}: {t('bulk.keep')}</option>
            {#each app.ranges.actors as a (a)}<option value={a}>{labelOf(app.lang, 'actor', a)}</option>{/each}
          </select>
        </label>
        <label>
          <span class="sr-only">{t('field.effort')}</span>
          <select bind:value={draft.effort} disabled={app.saving}>
            <option value="">{t('field.effort')}: {t('bulk.keep')}</option>
            <option value="-">{t('field.effort')}: {t('bulk.unset')}</option>
            {#each app.ranges.efforts as size (size)}<option value={size}>{size}</option>{/each}
          </select>
        </label>
        <label>
          <span class="sr-only">{t('remind.field')}</span>
          <select bind:value={draft.remind} disabled={app.saving}>
            <option value="">{t('remind.field')}: {t('bulk.keep')}</option>
            <option value="-">{t('remind.field')}: {t('bulk.unset')}</option>
            {#each REMIND_CHOICES as choice (choice)}
              <option value={choice}
                >{choice === '+0d' ? t('remind.today') : t('remind.in', { n: choice.slice(1, -1) })}</option
              >
            {/each}
          </select>
        </label>
        <label>
          <span class="sr-only">{t('bulk.tags_add')}</span>
          <input type="text" placeholder={t('bulk.tags_add')} bind:value={draft.addTags} disabled={app.saving} onkeydown={applyOnEnter} />
        </label>
        <label>
          <span class="sr-only">{t('bulk.tags_remove')}</span>
          <input type="text" placeholder={t('bulk.tags_remove')} bind:value={draft.removeTags} disabled={app.saving} onkeydown={applyOnEnter} />
        </label>
        <button
          type="button"
          class="apply"
          disabled={app.saving || !chosen}
          onclick={applyDraft}>{t('bulk.apply')}</button
        >
        <button type="button" onclick={() => app.clearMarks()}>{t('bulk.clear')}</button>
        {#if app.can('move_area')}
          <div class="bulk-move" role="group" aria-label={t('bulk.move_label')}>
            <label>
              <span class="sr-only">{t('bulk.move_label')}</span>
              <select bind:this={moveSelect} bind:value={moveTo} disabled={app.saving}>
                <option value="">{t('bulk.move_label')}: {t('bulk.keep')}</option>
                {#each app.allAreaNames as area (area)}<option value={area}>{area}</option>{/each}
              </select>
            </label>
            <!-- One button for both steps: the same element keeps the focus when "Check the moves" becomes "Move n". -->
            <button
              type="button"
              class:apply={moveShown && movable > 0}
              disabled={app.saving || moveTo === ''}
              aria-disabled={checking}
              aria-busy={checking}
              onclick={() => void (moveShown && movable > 0 ? doMoves() : checkMoves())}
              >{moveShown && movable > 0 ? t('bulk.move_go', { n: movable }) : t('bulk.move_check')}</button
            >
          </div>
          <!-- Always there, so that a screen reader has the region before it gets its text. -->
          <div class="bulk-move-result" role="status" aria-label={t('bulk.move_result')}>
            {#if moveShown}
              <ul>
                {#each moveShown as c (c.id)}
                  <li class:bad={c.reasons.length > 0}>
                    {#if c.reasons.length > 0}
                      {t('bulk.move_refused', { id: c.id, reason: markHidden(c.reasons.join(' ')) })}
                    {:else}
                      {t('bulk.move_ok', { id: c.id, new_id: c.newId, n: c.references })}
                    {/if}
                  </li>
                {:else}
                  <li>{t('bulk.nothing')}</li>
                {/each}
              </ul>
              {#each moveClasses as m (m.from)}<p>{t('bulk.move_class', m)}</p>{/each}
            {/if}
          </div>
        {/if}
      </div>
    {/if}
    <TextHits {app} />
    <div class="rows">
      {#each visible as task (task.file)}
        <TaskRow
          {task}
          lang={app.lang}
          today={app.today}
          selected={task.id === app.selectedId}
          marked={app.marks.includes(task.id)}
          onselect={(id) => app.select(id)}
          onmark={(id) => app.toggleMark(id)}
          markLabel={t('bulk.mark', { id: task.id })}
          flagged={app.findingsFor(task.id).length}
          flagTitle={t('check.flag', { n: app.findingsFor(task.id).length })}
          crossAreas={app.crossAreas(task.id)}
          crossTitle={t('cross.mark', { n: app.crossAreas(task.id).length, areas: app.crossAreas(task.id).join(', ') })}
          onmenu={(e) => void app.openViewMenu(e, task.area, { areas: [task.area] })}
        />
      {:else}
        <p class="empty">{t('list.none')}</p>
      {/each}
      {#if app.showFinished && app.can('finished')}
        <FinishedList {app} />
      {/if}
    </div>
  </section>
  <Detail {app} />
</div>

<style>
  .split {
    display: grid;
    grid-template-columns: minmax(0, 3fr) minmax(0, 2fr);
    gap: 1rem;
    height: 100%;
    min-height: 0;
  }
  @media (max-width: 52rem) {
    .split {
      grid-template-columns: 1fr;
    }
  }
  .list {
    display: flex;
    flex-direction: column;
    min-height: 0;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius);
  }
  .filters {
    display: flex;
    gap: 0.5rem;
    padding: 0.5rem;
    border-bottom: 1px solid var(--border);
    flex-wrap: wrap;
  }
  .filters input[type='search'] {
    flex: 1;
    min-width: 10rem;
  }
  .more {
    padding: 0.25rem 0.6rem;
    border-bottom: 1px solid var(--border);
  }
  .more summary {
    cursor: pointer;
    color: var(--muted);
    font-size: 0.85rem;
  }
  .more-body {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.4rem 0.6rem;
    padding: 0.5rem 0 0.25rem;
  }
  .pick {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    font-size: 0.85rem;
    color: var(--muted);
  }
  .pick select {
    background: var(--surface-2);
    color: var(--text);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 0.25rem 0.4rem;
  }
  .list-delete {
    background: var(--surface-2);
    color: var(--text);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 0.15rem 0.5rem;
    cursor: pointer;
  }
  .save-list {
    font-size: 0.85rem;
    color: var(--muted);
  }
  .save-list summary {
    cursor: pointer;
  }
  .save-row {
    display: flex;
    gap: 0.4rem;
    align-items: center;
    margin-top: 0.3rem;
  }
  .save-list input {
    background: var(--surface-2);
    color: var(--text);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 0.25rem 0.4rem;
  }
  .save-list button {
    background: var(--surface-2);
    color: var(--text);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 0.25rem 0.6rem;
    cursor: pointer;
  }
  .active {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.35rem;
    list-style: none;
    margin: 0;
    padding: 0.35rem 0.6rem;
    border-bottom: 1px solid var(--border);
  }
  .active li {
    display: inline-flex;
    align-items: center;
    gap: 0.25rem;
    background: var(--surface-2);
    border: 1px solid var(--border);
    border-radius: 999px;
    padding: 0.05rem 0.2rem 0.05rem 0.6rem;
    font-size: 0.8rem;
  }
  .active li:last-child {
    background: none;
    border: none;
    padding: 0;
  }
  .active li button:not(.linkish) {
    background: none;
    border: none;
    color: var(--muted);
    cursor: pointer;
    padding: 0 0.3rem;
    font-size: 1rem;
    line-height: 1;
  }
  .filters input {
    background: var(--surface-2);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 0.3rem 0.5rem;
  }
  .count {
    margin: 0;
    padding: 0.3rem 0.6rem;
    color: var(--muted);
    font-size: 0.8rem;
    display: flex;
    justify-content: space-between;
    gap: 1rem;
  }
  .help {
    text-align: right;
  }
  .linkish {
    background: none;
    border: 0;
    padding: 0;
    color: var(--accent);
    cursor: pointer;
    font-size: inherit;
  }
  .bulk {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
    align-items: center;
    padding: 0.4rem 0.6rem;
    background: var(--surface-2);
    border-bottom: 1px solid var(--border);
    font-size: 0.85rem;
  }
  .bulk input {
    width: 9rem;
  }
  .bulk input,
  .bulk select,
  .bulk button {
    background: var(--surface);
    color: var(--text);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 0.2rem 0.5rem;
  }
  .bulk-move {
    display: flex;
    gap: 0.5rem;
    align-items: center;
    flex-basis: 100%;
  }
  .bulk-move-result {
    flex-basis: 100%;
  }
  .bulk-move-result ul,
  .bulk-move-result p {
    margin: 0;
    padding-left: 1.1rem;
  }
  .bulk-move-result .bad {
    color: var(--bad);
  }
  .show-finished {
    display: block;
    padding: 0 0.75rem 0.5rem;
  }
  .rows {
    overflow: auto;
    flex: 1;
    min-height: 0;
  }
  .empty {
    padding: 1rem;
    color: var(--muted);
  }
</style>
