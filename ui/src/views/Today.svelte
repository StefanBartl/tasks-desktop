<script lang="ts">
  import type { App, Tile } from '../lib/app.svelte';
  import type { TaskBrief } from '../lib/contract';
  import { waitingForMe } from '../lib/filter';
  import { labelOf, translate, type Key } from '../lib/i18n';
  import { markHidden } from '../lib/text';

  let { app }: { app: App } = $props();

  const t = (key: Key, params: Record<string, string | number> = {}) =>
    translate(app.lang, key, params);

  const next = $derived(app.next);
  const snapshot = $derived(app.snapshot);
  const waiting = $derived(waitingForMe(app.tasks).slice(0, 8));
  const empty = $derived(next?.empty);
  const shown = (tile: Tile) => !app.hiddenTiles.includes(tile);

  const tiles = $derived.by(() => {
    if (!snapshot) return [];
    const by = snapshot.counts.by_status;
    return [
      { key: 'today.tiles.ready' as Key, value: snapshot.plan.summary.ready },
      { key: 'today.tiles.doing' as Key, value: by['doing'] ?? 0 },
      { key: 'today.tiles.blocked' as Key, value: by['blocked'] ?? 0 },
      {
        key: 'today.tiles.estimated' as Key,
        value: `${snapshot.estimate.n_with_value}/${snapshot.estimate.tasks}`,
      },
    ];
  });

  function open(id: string): void {
    app.select(id);
    app.setView('list');
  }

  function why(brief: TaskBrief): string {
    return brief.reason ? t(`today.why.${brief.reason}` as Key) : '';
  }
</script>

<div class="today">
  {#if app.hiddenTiles.length > 0}
    <p class="restore">
      <button type="button" class="link" onclick={() => app.showTiles()}
        >{t('today.hidden', { n: app.hiddenTiles.length })}</button
      >
    </p>
  {/if}

  {#if shown('counts') && tiles.length > 0}
    <aside class="card overview" aria-label={t('today.overview')}>
      <header>
        <h2 class="eyebrow">{t('today.overview')}</h2>
        <button
          type="button"
          class="hide"
          aria-label={t('today.hide')}
          title={t('today.hide')}
          onclick={() => app.hideTile('counts')}>×</button
        >
      </header>
      <div class="tiles">
        {#each tiles as tile (tile.key)}
          <div class="tile">
            <span class="num">{tile.value}</span>
            <span class="muted">{t(tile.key)}</span>
          </div>
        {/each}
      </div>
    </aside>
  {/if}

  <div class="main">
    {#if shown('next')}
      <section class="card next" aria-label={t('today.next')}>
        <header>
          <h2 class="eyebrow">{t('today.next')}</h2>
          <button
            type="button"
            class="hide"
            aria-label={t('today.hide')}
            title={t('today.hide')}
            onclick={() => app.hideTile('next')}>×</button
          >
        </header>
        {#if next?.task}
          <button type="button" class="big" onclick={() => open(next.task!.id)}>
            {markHidden(next.task.title)}
          </button>
          <p class="id"><code>{next.task.id}</code></p>
          <p class="muted">
            {labelOf(app.lang, 'status', next.task.status)} ·
            {next.task.prio !== undefined ? `P${next.task.prio}` : '?'} ·
            {next.task.effort ?? '?'}
            {#if why(next.task)} · {why(next.task)}{/if}
          </p>
          {#if next.alternatives.length > 0}
            <h2 class="eyebrow">{t('today.alternatives')}</h2>
            <ul class="plain">
              {#each next.alternatives as alt, i (`${alt.id}:${i}`)}
                <li>
                  <button type="button" class="link" onclick={() => open(alt.id)}
                    >{markHidden(alt.title)}</button
                  >
                  <span class="muted"><code>{alt.id}</code></span>
                </li>
              {/each}
            </ul>
          {/if}
        {:else if empty}
          <p>
            {#if empty.kind === 'all_done'}
              {t('today.empty.all_done')}
            {:else if empty.kind === 'only_cdx'}
              {t('today.empty.only_cdx')}
            {:else}
              {t('today.empty.nothing_startable', {
                for_me: empty.for_me,
                waiting: empty.waiting,
                blocked_status: empty.blocked_status,
                parked: empty.parked,
              })}
            {/if}
          </p>
        {:else}
          <p class="muted">{t('state.loading')}</p>
        {/if}
      </section>
    {/if}

    {#if shown('waiting')}
      <section class="card" aria-label={t('today.waiting')}>
        <header>
          <h2 class="eyebrow">{t('today.waiting')} ({waiting.length})</h2>
          <button
            type="button"
            class="hide"
            aria-label={t('today.hide')}
            title={t('today.hide')}
            onclick={() => app.hideTile('waiting')}>×</button
          >
        </header>
        <ul class="plain">
          {#each waiting as task, i (`${task.id}:${i}`)}
            <li>
              <button type="button" class="link" onclick={() => open(task.id)}
                >{markHidden(task.title)}</button
              >
              <span class="muted"><code>{task.id}</code></span>
            </li>
          {/each}
        </ul>
      </section>
    {/if}

    {#if shown('cdx') && next && next.cdx.length > 0}
      <section class="card" aria-label={t('today.cdx')}>
        <header>
          <h2 class="eyebrow">{t('today.cdx')} ({next.cdx.length})</h2>
          <button
            type="button"
            class="hide"
            aria-label={t('today.hide')}
            title={t('today.hide')}
            onclick={() => app.hideTile('cdx')}>×</button
          >
        </header>
        <ul class="plain">
          {#each next.cdx.slice(0, 8) as brief, i (`${brief.id}:${i}`)}
            <li>
              <button type="button" class="link" onclick={() => open(brief.id)}
                >{markHidden(brief.title)}</button
              >
              <span class="muted"><code>{brief.id}</code></span>
            </li>
          {/each}
        </ul>
      </section>
    {/if}
  </div>
</div>

<style>
  /* The overview sits at the top right, in view when the page opens; the
     blocks of the work stand to its left. */
  .today {
    display: grid;
    grid-template-columns: minmax(0, 1fr) 18rem;
    grid-template-areas:
      'restore restore'
      'main overview';
    gap: 1rem;
    align-items: start;
  }
  .restore {
    grid-area: restore;
    margin: 0;
  }
  .overview {
    grid-area: overview;
    position: sticky;
    top: 0;
  }
  .main {
    grid-area: main;
    display: grid;
    gap: 1rem;
    min-width: 0;
  }
  @media (max-width: 52rem) {
    .today {
      grid-template-columns: minmax(0, 1fr);
      grid-template-areas:
        'restore'
        'overview'
        'main';
    }
    .overview {
      position: static;
    }
  }
  .card {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 1rem;
  }
  .card header {
    display: flex;
    justify-content: space-between;
    align-items: start;
    gap: 0.5rem;
  }
  .hide {
    background: none;
    border: 0;
    color: var(--muted);
    cursor: pointer;
    font-size: 1.2rem;
    line-height: 1;
    padding: 0 0.25rem;
    border-radius: var(--radius);
  }
  .hide:hover {
    color: var(--text);
    background: var(--surface-2);
  }
  .big {
    font-size: 1.25rem;
    font-weight: 600;
    background: none;
    border: 0;
    padding: 0;
    text-align: left;
    cursor: pointer;
    color: var(--accent);
  }
  .eyebrow {
    font-size: 0.8rem;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--muted);
    margin: 0 0 0.5em;
  }
  .id {
    margin: 0.2rem 0;
  }
  .muted {
    color: var(--muted);
  }
  .plain {
    list-style: none;
    padding: 0;
    margin: 0;
  }
  .plain li {
    padding: 0.2rem 0;
    display: flex;
    gap: 0.5rem;
    flex-wrap: wrap;
  }
  .link {
    background: none;
    border: 0;
    padding: 0;
    color: var(--accent);
    cursor: pointer;
    text-align: left;
  }
  .tiles {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 0.75rem;
  }
  .tile {
    background: var(--surface-2);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 0.5rem 0.75rem;
    display: flex;
    flex-direction: column;
  }
  .num {
    font-size: 1.5rem;
    font-weight: 600;
  }
</style>
