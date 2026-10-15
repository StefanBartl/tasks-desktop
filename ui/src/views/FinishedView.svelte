<script lang="ts">
  // The finished tasks: how many, of which area, kind and priority, and when. Every figure is the engine's
  // (`tasks.finished` counts all the tasks of the period, not the page); this only asks, and shows each figure as
  // a table row with a bar beside it (the number is always written, the bar is no colour-only sign).
  import { untrack } from 'svelte';
  import type { App } from '../lib/app.svelte';
  import type { Finished } from '../lib/contract';
  import { ApiError } from '../lib/api';
  import { PRESETS, intersect, monthRange, percent, rangeOf, weekRange, type Preset, type Range } from '../lib/finished';
  import { areaLabel } from '../lib/filter';
  import { formatNumber, labelOf, translate, type Key } from '../lib/i18n';
  import { markHidden } from '../lib/text';
  import Info from './Info.svelte';

  let { app }: { app: App } = $props();
  const t = (key: Key, params: Record<string, string | number> = {}) => translate(app.lang, key, params);

  const preset = $derived(app.finishedPrefs.preset);
  const custom = $derived({ from: app.finishedPrefs.from, to: app.finishedPrefs.to });
  const step = $derived(app.finishedPrefs.step);
  const remember = (change: Partial<typeof app.finishedPrefs>): void =>
    app.setFinishedPrefs({ ...app.finishedPrefs, ...change });
  /** A month or a week clicked in the table: it replaces the period until it is taken off. */
  let drill = $state<{ range: Range; label: string } | null>(null);
  let area = $state<string | undefined>(undefined);

  let doc = $state<Finished | null>(null);
  let items = $state<Finished['items']>([]);
  let problem = $state<string | null>(null);
  let loading = $state(false);
  let seq = 0;

  // A month or week clicked in a table is the part of it inside the period, so the row's number and the page agree.
  const range = $derived(
    drill ? intersect(drill.range, rangeOf(preset, app.today, custom)) : rangeOf(preset, app.today, custom),
  );
  const stats = $derived(doc?.stats);
  const total = $derived(doc?.total ?? 0);
  const nameOf = (name: string): string => (app.shortAreas ? areaLabel(name, app.areaNames) : name);
  const days = (n: number): string => formatNumber(app.lang, n);

  async function load(query: { area?: string } & Range, offset: number): Promise<void> {
    seq += 1;
    const mine = seq;
    loading = true;
    try {
      const next = await app.finished({ ...query, ...(offset > 0 ? { offset } : {}) });
      if (mine !== seq) return;
      doc = next;
      items = offset > 0 ? [...items, ...next.items] : next.items;
      problem = null;
    } catch (error) {
      if (mine !== seq) return;
      // The engine's own words (a day it refuses), not a guess.
      problem = error instanceof ApiError ? error.message : t('done.failed');
      if (offset === 0) {
        doc = null;
        items = [];
      }
    } finally {
      if (mine === seq) loading = false;
    }
  }

  // Asks again when the period, the area or the vault changes (a task finished meanwhile shows up).
  $effect(() => {
    const query = { ...(area ? { area } : {}), ...range };
    void app.snapshot?.rev;
    untrack(() => void load(query, 0));
  });

  function more(): void {
    if (doc?.next_offset === undefined) return;
    void load({ ...(area ? { area } : {}), ...range }, doc.next_offset);
  }
  function takeOff(): void {
    drill = null;
    area = undefined;
  }
  const narrowed = $derived(drill !== null || area !== undefined);
  const narrowedText = $derived(
    [area ? nameOf(area) : '', drill?.label ?? ''].filter((s) => s !== '').join(' · '),
  );

  const maxOf = (rows: readonly { count: number }[]): number => rows.reduce((m, r) => Math.max(m, r.count), 1);
  const period = $derived(step === 'month' ? (stats?.by_month ?? []) : (stats?.by_week ?? []));
  const periodKey = (row: { month?: string; week?: string }): string | undefined =>
    step === 'month' ? row.month : row.week;
</script>

{#snippet bar(count: number, max: number)}
  <meter min="0" {max} value={count} aria-hidden="true">{count}</meter>
{/snippet}

<div class="done">
  <section class="card head" aria-label={t('done.controls')}>
    <div class="headline">
      <h2 class="eyebrow">{t('nav.done')}</h2>
      <Info hint={t('hint.done')} label={t('hint.about', { what: t('nav.done') })} />
    </div>
    <div class="bar">
      <label class="field"
        >{t('done.period')}
        <select
          value={preset}
          onchange={(e) => {
            remember({ preset: e.currentTarget.value as Preset });
            drill = null;
          }}
        >
          {#each PRESETS as p (p)}
            <option value={p}>{t(`done.preset.${p}` as Key)}</option>
          {/each}
        </select>
      </label>
      {#if preset === 'custom' && !drill}
        <label class="field">{t('done.from')} <input type="date" value={custom.from} oninput={(e) => remember({ from: e.currentTarget.value })} /></label>
        <label class="field">{t('done.to')} <input type="date" value={custom.to} oninput={(e) => remember({ to: e.currentTarget.value })} /></label>
      {/if}
      {#if narrowed}
        <span class="muted">{t('done.showing', { what: narrowedText })}</span>
        <button type="button" class="linkish" onclick={takeOff}>{t('done.take_off')}</button>
      {/if}
    </div>
    {#if problem}
      <p class="problem" role="alert">{problem}</p>
    {:else if doc}
      <p class="muted" role="status">
        {total === 1
          ? t('done.summary_one', { days: days(stats?.effort_days ?? 0) })
          : t('done.summary', { n: total, days: days(stats?.effort_days ?? 0) })}
        {#if (stats?.without_effort ?? 0) > 0}
          {t('done.without_effort', { n: stats?.without_effort ?? 0 })}
        {/if}
      </p>
      {#if doc.undated > 0}
        <p class="muted">{t('done.undated', { n: doc.undated })}</p>
      {/if}
    {/if}
  </section>

  {#if doc && total === 0 && !problem}
    <p class="muted">{t('done.none')}</p>
  {:else if stats && total > 0}
    <section class="card" aria-labelledby="done-by-area">
      <h3 id="done-by-area">{t('done.by_area')}</h3>
      <table>
        <thead>
          <tr>
            <th scope="col">{t('nav.areas')}</th>
            <th scope="col" class="num">{t('done.col.count')}</th>
            <th scope="col" class="num">{t('done.col.share')}</th>
            <th scope="col" class="num">{t('done.col.days')}</th>
            <th scope="col"><span class="sr-only">{t('done.col.bar')}</span></th>
          </tr>
        </thead>
        <tbody>
          {#each stats.by_area as row (row.area)}
            <tr>
              <th scope="row">
                <button type="button" class="link" onclick={() => (area = row.area)}
                  >{markHidden(nameOf(row.area))}</button
                >
              </th>
              <td class="num">{row.count}</td>
              <td class="num">{percent(row.count, total)} %</td>
              <td class="num">{days(row.effort_days)}</td>
              <td>{@render bar(row.count, maxOf(stats.by_area))}</td>
            </tr>
          {/each}
        </tbody>
      </table>
    </section>

    <section class="card" aria-labelledby="done-over-time">
      <div class="headline">
        <h3 id="done-over-time">{t('done.over_time')}</h3>
        <label class="field"
          >{t('done.step')}
          <select value={step} onchange={(e) => remember({ step: e.currentTarget.value === 'week' ? 'week' : 'month' })}>
            <option value="month">{t('done.step.month')}</option>
            <option value="week">{t('done.step.week')}</option>
          </select>
        </label>
      </div>
      <table>
        <thead>
          <tr>
            <th scope="col">{step === 'month' ? t('done.step.month') : t('done.step.week')}</th>
            <th scope="col" class="num">{t('done.col.count')}</th>
            <th scope="col" class="num">{t('done.col.days')}</th>
            <th scope="col"><span class="sr-only">{t('done.col.bar')}</span></th>
          </tr>
        </thead>
        <tbody>
          {#each period as row (periodKey(row) ?? '')}
            {@const key = periodKey(row)}
            <tr>
              <th scope="row">
                {#if key}
                  <button
                    type="button"
                    class="link"
                    onclick={() =>
                      (drill = {
                        range: step === 'month' ? monthRange(key) : weekRange(key),
                        label: step === 'month' ? key : t('done.week_of', { day: key }),
                      })}>{key}</button
                  >
                {:else}
                  <span class="muted">{t('done.undated_row')}</span>
                {/if}
              </th>
              <td class="num">{row.count}</td>
              <td class="num">{days(row.effort_days)}</td>
              <td>{@render bar(row.count, maxOf(period))}</td>
            </tr>
          {/each}
        </tbody>
      </table>
    </section>

    <div class="two">
      <section class="card" aria-labelledby="done-by-kind">
        <h3 id="done-by-kind">{t('done.by_kind')}</h3>
        <table>
          <thead>
            <tr>
              <th scope="col">{t('filter.field.kind')}</th>
              <th scope="col" class="num">{t('done.col.count')}</th>
              <th scope="col" class="num">{t('done.col.days')}</th>
              <th scope="col"><span class="sr-only">{t('done.col.bar')}</span></th>
            </tr>
          </thead>
          <tbody>
            {#each stats.by_kind as row (row.kind ?? '')}
              <tr>
                <th scope="row">{row.kind ? labelOf(app.lang, 'kind', row.kind) : t('filter.none')}</th>
                <td class="num">{row.count}</td>
                <td class="num">{days(row.effort_days)}</td>
                <td>{@render bar(row.count, maxOf(stats.by_kind))}</td>
              </tr>
            {/each}
          </tbody>
        </table>
      </section>
      <section class="card" aria-labelledby="done-by-prio">
        <h3 id="done-by-prio">{t('done.by_prio')}</h3>
        <table>
          <thead>
            <tr>
              <th scope="col">{t('filter.field.prio')}</th>
              <th scope="col" class="num">{t('done.col.count')}</th>
              <th scope="col" class="num">{t('done.col.days')}</th>
              <th scope="col"><span class="sr-only">{t('done.col.bar')}</span></th>
            </tr>
          </thead>
          <tbody>
            {#each stats.by_prio as row (row.prio ?? 0)}
              <tr>
                <th scope="row">{row.prio ? `P${row.prio}` : t('filter.none')}</th>
                <td class="num">{row.count}</td>
                <td class="num">{days(row.effort_days)}</td>
                <td>{@render bar(row.count, maxOf(stats.by_prio))}</td>
              </tr>
            {/each}
          </tbody>
        </table>
      </section>
    </div>

    <section class="card" aria-labelledby="done-tasks">
      <h3 id="done-tasks">{t('done.tasks')}</h3>
      <ul class="plain tasks">
        {#each items as item (item.file)}
          <li>
            <span class="when">{item.done ?? t('done.undated_row')}</span>
            <span class="title">{markHidden(item.title)}</span>
            <span class="muted">{markHidden(nameOf(item.area))}</span>
            {#if item.kind}<span class="muted">{labelOf(app.lang, 'kind', item.kind)}</span>{/if}
            {#if item.effort}<span class="muted">{item.effort}</span>{/if}
          </li>
        {/each}
      </ul>
      <p class="muted">{t('list.count', { shown: items.length, total })}</p>
      {#if doc?.next_offset !== undefined}
        <button type="button" disabled={loading} onclick={more}>{t('done.more')}</button>
      {/if}
    </section>
  {/if}
</div>

<style>
  .done {
    display: grid;
    gap: 1rem;
    align-content: start;
  }
  .card {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 0.9rem 1rem;
  }
  .two {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(18rem, 1fr));
    gap: 1rem;
  }
  .headline {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    margin-bottom: 0.5em;
  }
  .eyebrow {
    font-size: 0.8rem;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--muted);
    margin: 0;
  }
  h3 {
    font-size: 0.95rem;
    margin: 0 0 0.5rem;
  }
  .bar {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.5rem 1rem;
  }
  .field {
    display: inline-flex;
    align-items: center;
    gap: 0.4rem;
  }
  .muted {
    color: var(--muted);
  }
  .problem {
    color: var(--bad);
  }
  table {
    width: 100%;
    border-collapse: collapse;
  }
  th,
  td {
    padding: 0.25rem 0.5rem 0.25rem 0;
    text-align: left;
    font-weight: normal;
  }
  thead th {
    color: var(--muted);
    font-size: 0.8rem;
  }
  .num {
    text-align: right;
    font-variant-numeric: tabular-nums;
  }
  meter {
    width: 7rem;
    height: 0.7rem;
  }
  .plain {
    list-style: none;
    padding: 0;
    margin: 0;
  }
  .tasks li {
    display: flex;
    flex-wrap: wrap;
    gap: 0.25rem 0.75rem;
    padding: 0.3rem 0;
    border-bottom: 1px solid var(--border);
  }
  .title {
    overflow-wrap: anywhere;
  }
  .when {
    font-variant-numeric: tabular-nums;
    color: var(--muted);
  }
  .link,
  .linkish {
    background: none;
    border: 0;
    padding: 0;
    color: var(--accent);
    cursor: pointer;
    text-align: left;
  }
</style>
