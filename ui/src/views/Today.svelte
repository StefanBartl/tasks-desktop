<script lang="ts">
  import type { App } from '../lib/app.svelte';
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
    app.view = 'list';
  }

  function why(brief: TaskBrief): string {
    return brief.reason ? t(`today.why.${brief.reason}` as Key) : '';
  }
</script>

<div class="today">
  <section class="card next" aria-label={t('today.next')}>
    <h2 class="eyebrow">{t('today.next')}</h2>
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

  <section class="card" aria-label={t('today.waiting')}>
    <h2 class="eyebrow">{t('today.waiting')} ({waiting.length})</h2>
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

  {#if next && next.cdx.length > 0}
    <section class="card" aria-label={t('today.cdx')}>
      <h2 class="eyebrow">{t('today.cdx')} ({next.cdx.length})</h2>
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

  {#if tiles.length > 0}
    <section class="tiles" aria-label={t('counts.label')}>
      {#each tiles as tile (tile.key)}
        <div class="tile">
          <span class="num">{tile.value}</span>
          <span class="muted">{t(tile.key)}</span>
        </div>
      {/each}
    </section>
  {/if}
</div>

<style>
  .today {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(20rem, 1fr));
    gap: 1rem;
    align-items: start;
  }
  .card {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 1rem;
  }
  .next {
    grid-column: 1 / -1;
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
    grid-column: 1 / -1;
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(8rem, 1fr));
    gap: 1rem;
  }
  .tile {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 0.75rem 1rem;
    display: flex;
    flex-direction: column;
  }
  .num {
    font-size: 1.5rem;
    font-weight: 600;
  }
</style>
