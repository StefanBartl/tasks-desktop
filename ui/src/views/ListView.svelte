<script lang="ts">
  import type { App } from '../lib/app.svelte';
  import { labelOf, translate, type Key } from '../lib/i18n';
  import { markHidden } from '../lib/text';
  import Detail from './Detail.svelte';
  import TextHits from './TextHits.svelte';
  import TaskRow from './TaskRow.svelte';
  import MultiSelect from './MultiSelect.svelte';
  import {
    FIELD_KEYS,
    NONE,
    REMINDER_CHOICES,
    UPDATED_WINDOWS,
    activeFilters,
    areaLabel,
    extraCount,
    fieldOptions,
    without,
    type ActiveFilter,
    type FieldKey,
    type ReminderChoice,
    type UpdatedWindow,
  } from '../lib/filter';
  import { untrack } from 'svelte';
  import { EFFORT_SIZES, badTag, parseTags } from '../lib/fields';
  import { isApplyKey } from '../lib/bulk';
  import { REMIND_CHOICES } from '../lib/remind';

  let { app, searchBox = $bindable(null) }: { app: App; searchBox?: HTMLInputElement | null } =
    $props();

  const t = (key: Key, params: Record<string, string | number> = {}) =>
    translate(app.lang, key, params);

  const statuses = ['doing', 'decision', 'blocked', 'open', 'parked'] as const;
  const actors = ['me', 'cdx', 'pair', 'none'] as const;

  // The filters beyond area, status and actor: one choice per field, the values the tasks have, with how many.
  let moreOpen = $state(false);
  const fieldLabel = (key: FieldKey): string => t(`filter.field.${key}` as Key);
  function valueLabel(key: FieldKey, value: string): string {
    if (value === NONE) return t('filter.none');
    if (key === 'prio') return `P${value}`;
    if (key === 'state') return labelOf(app.lang, 'state', value);
    return markHidden(value);
  }
  const fieldChoices = $derived(
    FIELD_KEYS.map((key) => ({
      key,
      options: fieldOptions(app.tasks, key).map((o) => ({
        value: o.value,
        label: `${valueLabel(key, o.value)} (${o.count})`,
      })),
    }))
      // A field that no task has a value for offers nothing to choose, unless it is on.
      .filter((f) => f.options.some((o) => o.value !== NONE) || (app.filter.fields[f.key]?.length ?? 0) > 0),
  );
  function chipLabel(item: ActiveFilter): string {
    switch (item.kind) {
      case 'area':
        return `${t('nav.areas')}: ${item.value}`;
      case 'status':
        return `${t('list.filter.status')}: ${t(`status.${item.value}` as Key)}`;
      case 'actor':
        return `${t('list.filter.actor')}: ${t(`actor.${item.value}` as Key)}`;
      case 'updated':
        return `${t('filter.updated')}: ${t(`filter.updated.${item.value}` as Key)}`;
      case 'reminder':
        return `${t('filter.reminder')}: ${t(`filter.reminder.${item.value}` as Key)}`;
      case 'cross':
        return t('filter.cross.on');
      default:
        return `${fieldLabel(item.kind)}: ${valueLabel(item.kind, item.value)}`;
    }
  }
  const chips = $derived(activeFilters(app.filter).map((item) => ({ item, label: chipLabel(item) })));
  const extraOn = $derived(extraCount(app.filter));
  const areaOptions = $derived(
    app.areaNames
      .map((name) => ({
        value: name,
        label: app.shortAreas ? areaLabel(name, app.areaNames) : name,
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
        placeholder={t('list.search')}
        aria-label={t('list.search')}
        value={app.filter.query}
        oninput={(e) => app.setQuery(e.currentTarget.value)}
      />
      <MultiSelect
        label={t('nav.areas')}
        options={areaOptions}
        selected={app.filter.areas}
        onchange={(areas) => (app.filter = { ...app.filter, areas })}
        resetLabel={t('multi.reset')}
        searchLabel={t('multi.search')}
      />
      <MultiSelect
        label={t('list.filter.status')}
        options={statuses.map((s) => ({ value: s, label: t(`status.${s}` as Key) }))}
        selected={app.filter.statuses}
        onchange={(statuses) => (app.filter = { ...app.filter, statuses })}
        resetLabel={t('multi.reset')}
        searchLabel={t('multi.search')}
      />
      <MultiSelect
        label={t('list.filter.actor')}
        options={actors.map((a) => ({
          value: a,
          label: t(`actor.${a}` as Key),
          title: t(`actor.${a}.hint` as Key),
        }))}
        selected={app.filter.actors}
        onchange={(actors) => (app.filter = { ...app.filter, actors })}
        resetLabel={t('multi.reset')}
        searchLabel={t('multi.search')}
      />
    </div>
    <details class="more" open={moreOpen} ontoggle={(e) => (moreOpen = e.currentTarget.open)}>
      <summary>{t('filter.more')}{extraOn > 0 ? ` (${extraOn})` : ''}</summary>
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
        <label class="pick">
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
      </div>
    </details>
    {#if chips.length > 0}
      <ul class="active" aria-label={t('filter.active')}>
        {#each chips as c (c.item.kind + ':' + c.item.value)}
          <li>
            <span>{c.label}</span>
            <button
              type="button"
              aria-label={t('filter.remove', { what: c.label })}
              onclick={() => (app.filter = without(app.filter, c.item))}>×</button
            >
          </li>
        {/each}
        <li><button type="button" class="linkish" onclick={() => app.resetFilter()}>{t('filter.clear')}</button></li>
      </ul>
    {/if}
    <p class="count" role="status">
      {t('list.count', { shown: shown.length, total: app.tasks.length })}
      <span class="help"
        ><button type="button" class="linkish" onclick={() => app.markShown()}>{t('bulk.all')}</button> ·
        {#if app.can('check')}<button type="button" class="linkish" onclick={() => void app.openChecks()}>{t('check.open')}</button> ·{/if}
        {#if app.can('estimate')}<button type="button" class="linkish" onclick={() => app.openMatrix()}>{t('matrix.open')}</button> ·{/if}
        {t('list.help')}</span
      >
    </p>
    {#if app.marks.length > 0}
      <div class="bulk" role="group" aria-label={t('bulk.change')}>
        <strong aria-live="polite">{t('bulk.count', { n: app.marks.length })}</strong>
        <label>
          <span class="sr-only">{t('field.status')}</span>
          <select bind:value={draft.status} disabled={app.saving}>
            <option value="">{t('field.status')}: {t('bulk.keep')}</option>
            {#each statuses as s (s)}<option value={s}>{t(`status.${s}` as Key)}</option>{/each}
          </select>
        </label>
        <label>
          <span class="sr-only">{t('field.prio')}</span>
          <select bind:value={draft.prio} disabled={app.saving}>
            <option value="">{t('field.prio')}: {t('bulk.keep')}</option>
            <option value="1">P1</option>
            <option value="2">P2</option>
            <option value="3">P3</option>
          </select>
        </label>
        <label>
          <span class="sr-only">{t('field.actor')}</span>
          <select bind:value={draft.actor} disabled={app.saving}>
            <option value="">{t('field.actor')}: {t('bulk.keep')}</option>
            {#each actors.filter((a) => a !== 'none') as a (a)}<option value={a}>{t(`actor.${a}` as Key)}</option>{/each}
          </select>
        </label>
        <label>
          <span class="sr-only">{t('field.effort')}</span>
          <select bind:value={draft.effort} disabled={app.saving}>
            <option value="">{t('field.effort')}: {t('bulk.keep')}</option>
            <option value="-">{t('field.effort')}: {t('bulk.unset')}</option>
            {#each EFFORT_SIZES as size (size)}<option value={size}>{size}</option>{/each}
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
        />
      {:else}
        <p class="empty">{t('list.none')}</p>
      {/each}
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
