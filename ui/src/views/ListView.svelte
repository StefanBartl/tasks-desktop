<script lang="ts">
  import type { App } from '../lib/app.svelte';
  import { translate, type Key } from '../lib/i18n';
  import Detail from './Detail.svelte';
  import TextHits from './TextHits.svelte';
  import TaskRow from './TaskRow.svelte';
  import MultiSelect from './MultiSelect.svelte';
  import { areaLabel } from '../lib/filter';

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
        label: areaLabel(name, app.areaNames),
        title: name,
      }))
      .sort((x, y) => x.label.localeCompare(y.label)),
  );
  const shown = $derived(app.shown);

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
      <span class="help">{t('list.help')}</span>
    </p>
    <TextHits {app} />
    <div class="rows">
      {#each visible as task (task.file)}
        <TaskRow
          {task}
          lang={app.lang}
          selected={task.id === app.selectedId}
          onselect={(id) => app.select(id)}
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
