<script lang="ts">
  import type { App, Tile } from '../lib/app.svelte';
  import type { TaskBrief } from '../lib/contract';
  import { waitingForMe } from '../lib/filter';
  import { dueItems } from '../lib/remind';
  import { labelOf, translate, type Key } from '../lib/i18n';
  import { markHidden } from '../lib/text';
  import { tasksOf, type CountKey } from '../lib/counts';
  import CountPanel from './CountPanel.svelte';

  let { app }: { app: App } = $props();

  const t = (key: Key, params: Record<string, string | number> = {}) =>
    translate(app.lang, key, params);

  const next = $derived(app.next);
  const snapshot = $derived(app.snapshot);
  const waiting = $derived(waitingForMe(app.tasks).slice(0, 8));
  const empty = $derived(next?.empty);
  const reminders = $derived(dueItems(app.tasks, snapshot?.reminders, app.today));
  const shown = (tile: Tile) => !app.hiddenTiles.includes(tile);
  // The counts need the snapshot; without them there is no block to keep room for.
  const showOverview = $derived(shown('counts') && snapshot !== null);

  const tiles = $derived.by(() => {
    if (!snapshot) return [];
    const by = snapshot.counts.by_status;
    return [
      { count: 'ready' as CountKey, key: 'today.tiles.ready' as Key, value: snapshot.plan.summary.ready },
      { count: 'doing' as CountKey, key: 'today.tiles.doing' as Key, value: by['doing'] ?? 0 },
      { count: 'blocked' as CountKey, key: 'today.tiles.blocked' as Key, value: by['blocked'] ?? 0 },
      {
        count: 'estimated' as CountKey,
        key: 'today.tiles.estimated' as Key,
        value: `${snapshot.estimate.n_with_value}/${snapshot.estimate.tasks}`,
        // What the engine counts as estimated is the first number.
        total: snapshot.estimate.n_with_value,
      },
    ];
  });

  /** The tasks of the open number, and how many the engine says there are. */
  const opened = $derived.by(() => {
    const key = app.countOpen;
    const tile = tiles.find((x) => x.count === key);
    if (!key || !tile) return null;
    const total = 'total' in tile && tile.total !== undefined ? tile.total : Number(tile.value);
    return { key, label: tile.key, tasks: tasksOf(key, app.tasks), total };
  });

  /** `v` on a number walks its views; Escape closes (handled by the panel). */
  function onTileKey(event: KeyboardEvent, key: CountKey): void {
    if (event.key === 'v' && !event.ctrlKey && !event.metaKey && !event.altKey) {
      event.preventDefault();
      event.stopPropagation();
      app.cycleCountView(key);
    }
  }

  function open(id: string): void {
    app.reveal(id);
  }

  function why(brief: TaskBrief): string {
    return brief.reason ? t(`today.why.${brief.reason}` as Key) : '';
  }
</script>

<div class="today" class:solo={!showOverview}>
  {#if showOverview}
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
          <button
            type="button"
            class="tile"
            data-count={tile.count}
            aria-expanded={app.countOpen === tile.count}
            aria-controls="count-panel"
            title={t('count.hint')}
            onclick={() => app.toggleCount(tile.count)}
            onkeydown={(e) => onTileKey(e, tile.count)}
          >
            <span class="num">{tile.value}</span>
            <span class="muted">{t(tile.key)}</span>
          </button>
        {/each}
      </div>
    </aside>
  {/if}

  <div class="main">
    {#if opened}
      <CountPanel {app} key={opened.key} label={t(opened.label)} tasks={opened.tasks} total={opened.total} />
    {/if}
    {#if app.hiddenTiles.length > 0}
      <p class="restore">
        <button type="button" class="link" onclick={() => app.showTiles()}
          >{t('today.hidden', { n: app.hiddenTiles.length })}</button
        >
      </p>
    {/if}
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

    {#if shown('remind') && reminders.length > 0}
      <section class="card" aria-label={t('remind.title')}>
        <header>
          <h2 class="eyebrow">{t('remind.title')} ({reminders.length})</h2>
          <button
            type="button"
            class="hide"
            aria-label={t('today.hide')}
            title={t('today.hide')}
            onclick={() => app.hideTile('remind')}>×</button
          >
        </header>
        <ul class="plain">
          {#each reminders.slice(0, 8) as item, i (`${item.id}:${i}`)}
            <li>
              {#if item.finished}
                <span>{markHidden(item.title)}</span>
                <button
                  type="button"
                  class="clear"
                  disabled={app.saving || !app.can('reopen')}
                  aria-label={`${t('reopen.button')}: ${item.id}`}
                  onclick={() => void app.reopen(item.id)}>{t('reopen.button')}</button
                >
              {:else}
                <button type="button" class="link" onclick={() => open(item.id)}
                  >{markHidden(item.title)}</button
                >
              {/if}
              <span class="muted"
                ><code>{item.id}</code> · {item.remind}{item.finished
                  ? ` · ${t('remind.finished')}`
                  : ''}</span
              >
              <button
                type="button"
                class="clear"
                disabled={app.saving}
                aria-label={`${t('remind.clear')}: ${item.id}`}
                title={t('remind.clear')}
                onclick={() => void app.clearReminder(item.id, item.etag)}>×</button
              >
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
    grid-template-areas: 'main overview';
    gap: 1rem;
    align-items: start;
  }
  /* Without the overview the blocks take the whole width. */
  .today.solo {
    grid-template-columns: minmax(0, 1fr);
    grid-template-areas: 'main';
  }
  .restore {
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
  .clear {
    background: none;
    border: 0;
    color: var(--muted);
    cursor: pointer;
    padding: 0 0.3rem;
    border-radius: var(--radius);
  }
  .clear:hover {
    color: var(--text);
    background: var(--surface-2);
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
    align-items: flex-start;
    color: var(--text);
    font: inherit;
    text-align: left;
    cursor: pointer;
  }
  .tile:hover,
  .tile[aria-expanded='true'] {
    border-color: var(--accent);
  }
  .num {
    font-size: 1.5rem;
    font-weight: 600;
  }
</style>
