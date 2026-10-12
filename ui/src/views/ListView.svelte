<script lang="ts">
  import type { App } from '../lib/app.svelte';
  import { translate, type Key } from '../lib/i18n';
  import Detail from './Detail.svelte';
  import TaskRow from './TaskRow.svelte';

  let { app, searchBox = $bindable(null) }: { app: App; searchBox?: HTMLInputElement | null } =
    $props();

  const t = (key: Key, params: Record<string, string | number> = {}) =>
    translate(app.lang, key, params);

  const statuses = ['doing', 'decision', 'blocked', 'open', 'parked'] as const;
  const actors = ['me', 'cdx', 'pair'] as const;
  const shown = $derived(app.shown);

  function pick(value: string): string | null {
    return value === '' ? null : value;
  }
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
        oninput={(e) => (app.filter = { ...app.filter, query: e.currentTarget.value })}
      />
      <select
        aria-label={t('nav.areas')}
        value={app.filter.area ?? ''}
        onchange={(e) => (app.filter = { ...app.filter, area: pick(e.currentTarget.value) })}
      >
        <option value="">{t('nav.all')}</option>
        {#each app.areaNames as name (name)}
          <option value={name}>{name}</option>
        {/each}
      </select>
      <select
        aria-label={t('list.filter.status')}
        value={app.filter.status ?? ''}
        onchange={(e) => (app.filter = { ...app.filter, status: pick(e.currentTarget.value) })}
      >
        <option value="">{t('list.filter.status')}</option>
        {#each statuses as status (status)}
          <option value={status}>{t(`status.${status}` as Key)}</option>
        {/each}
      </select>
      <select
        aria-label={t('list.filter.actor')}
        value={app.filter.actor ?? ''}
        onchange={(e) => (app.filter = { ...app.filter, actor: pick(e.currentTarget.value) })}
      >
        <option value="">{t('list.filter.actor')}</option>
        {#each actors as actor (actor)}
          <option value={actor}>{t(`actor.${actor}` as Key)}</option>
        {/each}
      </select>
    </div>
    <p class="count" role="status">
      {t('list.count', { shown: shown.length, total: app.tasks.length })}
      <span class="help">{t('list.help')}</span>
    </p>
    <div class="rows">
      {#each shown as task (task.file)}
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
  .filters input,
  .filters select {
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
