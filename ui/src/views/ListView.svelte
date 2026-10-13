<script lang="ts">
  import type { App } from '../lib/app.svelte';
  import { translate, type Key } from '../lib/i18n';
  import Detail from './Detail.svelte';
  import TextHits from './TextHits.svelte';
  import TaskRow from './TaskRow.svelte';
  import MultiSelect from './MultiSelect.svelte';
  import { areaLabel } from '../lib/filter';
  import { untrack } from 'svelte';

  let { app, searchBox = $bindable(null) }: { app: App; searchBox?: HTMLInputElement | null } =
    $props();

  const t = (key: Key, params: Record<string, string | number> = {}) =>
    translate(app.lang, key, params);

  const statuses = ['doing', 'decision', 'blocked', 'open', 'parked'] as const;
  const actors = ['me', 'cdx', 'pair', 'none'] as const;
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
  let draft = $state({ status: '', prio: '', actor: '' });
  $effect(() => {
    if (app.marks.length === 0) draft = { status: '', prio: '', actor: '' };
  });
  async function applyDraft(): Promise<void> {
    const patch: Record<string, unknown> = {};
    if (draft.status) patch.status = draft.status;
    if (draft.prio) patch.prio = Number(draft.prio);
    if (draft.actor) patch.actor = draft.actor;
    if (Object.keys(patch).length === 0) return;
    // What stays marked (a failure) keeps the choice for the second try; with no marks left it starts over.
    await app.bulkSet(patch);
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
    <p class="count" role="status">
      {t('list.count', { shown: shown.length, total: app.tasks.length })}
      <span class="help"
        ><button type="button" class="linkish" onclick={() => app.markShown()}>{t('bulk.all')}</button> ·
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
        <button
          type="button"
          class="apply"
          disabled={app.saving || !(draft.status || draft.prio || draft.actor)}
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
