<script lang="ts">
  // The tile Today: what happened in a period, in the evaluations the person chose. Three icons in its corner: turn the
  // page (a day, a week, a month, or days that are typed, and back and forth through them), print or save it (an image,
  // or a page for the printer or a PDF), and choose what is counted. The made and the changed tasks are counted from the
  // snapshot; the finished ones and what is derived from them are asked of the engine (the Backlogs).
  import type { App } from '../lib/app.svelte';
  import type { Finished } from '../lib/contract';
  import {
    canPage,
    currentPeriod,
    FINISHED_PAGE,
    FINISHED_READ,
    METRICS,
    metricValues,
    PERIOD_MODES,
    periodDays,
    shiftPeriod,
    type DailyPrefs,
    type Metric,
    type Period,
    type PeriodMode,
  } from '../lib/daily';
  import { dailyPng, printDaily, saveBlob, type DailyRow } from '../lib/dailyExport';
  import { translate, type Key } from '../lib/i18n';

  let { app }: { app: App } = $props();
  const t = (key: Key, params: Record<string, string | number> = {}) => translate(app.lang, key, params);

  const prefs = $derived(app.dailyPrefs);
  /** The day the period is turned to; it falls back to today whenever the mode is chosen anew. */
  let anchor = $state<string | null>(null);
  // A custom period carries its own days (kept in the profile); the others are the one around the anchor.
  const period = $derived<Period>(
    prefs.mode === 'custom'
      ? currentPeriod('custom', app.today, { from: prefs.from, to: prefs.to })
      : { mode: prefs.mode, anchor: anchor ?? app.today },
  );
  const days = $derived(periodDays(period));
  const isToday = $derived(prefs.mode === 'day' && days.since === app.today);

  // Which popup is open (the three icons share one place).
  let open = $state<'period' | 'print' | 'metrics' | null>(null);
  let card = $state<HTMLElement | undefined>();

  function choose(next: Partial<DailyPrefs>): void {
    app.setDailyPrefs({ ...prefs, ...next });
  }

  function pickMode(mode: PeriodMode): void {
    anchor = null;
    choose({ mode });
  }

  function turn(direction: -1 | 1): void {
    const moved = shiftPeriod(period, direction);
    if (moved.mode === 'custom') choose({ from: moved.from, to: moved.to });
    else anchor = moved.anchor;
  }

  function toggleMetric(metric: Metric, on: boolean): void {
    const next = METRICS.filter((m) => (m === metric ? on : prefs.metrics.includes(m)));
    choose({ metrics: next });
  }

  /** The finished tasks of the days, a page at a time (the engine's page is short), up to `FINISHED_READ`; `null` on a failure. */
  async function readFinished(since: string, until: string, signal: AbortSignal): Promise<Finished | null> {
    try {
      let all: Finished | undefined;
      let offset = 0;
      for (;;) {
        const page = await app.finished({ since, until, limit: FINISHED_PAGE, offset }, signal);
        all = all ? { ...all, items: [...all.items, ...page.items] } : page;
        offset += FINISHED_PAGE;
        if (page.items.length < FINISHED_PAGE || offset >= Math.min(page.total, FINISHED_READ)) return all;
      }
    } catch {
      return null;
    }
  }

  // The finished tasks of the period: asked again when the snapshot or the period changes, and only when a chosen
  // evaluation needs them.
  // An answer is kept with the days it is for: while the next period is on its way the old numbers are not shown under
  // the new days (a dash instead).
  let answer = $state<{ since: string; until: string; doc: Finished } | null>(null);
  const finished = $derived(answer !== null && answer.since === days.since && answer.until === days.until ? answer.doc : null);
  const needsFinished = $derived(prefs.metrics.some((m) => m !== 'created' && m !== 'changed'));
  $effect(() => {
    const { since, until } = days;
    void app.snapshot?.rev;
    if (!needsFinished || !app.can('finished')) {
      answer = null;
      return;
    }
    const controller = new AbortController();
    void readFinished(since, until, controller.signal).then((doc) => {
      if (!controller.signal.aborted) answer = doc === null ? null : { since, until, doc };
    });
    return () => controller.abort();
  });

  const values = $derived(metricValues(app.tasks, finished, days));
  const shownMetrics = $derived(METRICS.filter((m) => prefs.metrics.includes(m)));

  const title = $derived(
    isToday ? t('daily.title') : t(`daily.mode.${prefs.mode}` as Key),
  );
  const rangeText = $derived(days.since === days.until ? days.since : `${days.since} – ${days.until}`);

  function textOf(metric: Metric): string {
    const v = values[metric];
    if (v.value === null) return '–';
    return `${v.partial ? '≥ ' : ''}${v.value}`;
  }

  const rows = $derived<DailyRow[]>(shownMetrics.map((m) => ({ label: t(`daily.m.${m}` as Key), value: textOf(m) })));

  /** What the page shows, as plain colours for the canvas: asked of an element, so that `light-dark()` follows the theme. */
  function colors() {
    const resolve = (css: string): string => {
      const probe = document.createElement('span');
      probe.style.color = css;
      document.body.append(probe);
      const colour = getComputedStyle(probe).color;
      probe.remove();
      return colour;
    };
    return { background: resolve('var(--bg)'), text: resolve('var(--text)'), muted: resolve('var(--muted)') };
  }

  async function saveImage(): Promise<void> {
    open = null;
    const blob = await dailyPng(document, colors(), title, rangeText, rows);
    if (blob === null || !saveBlob(document, `tasks-${days.since}${days.since === days.until ? '' : `_${days.until}`}.png`, blob)) {
      app.tell('error', 'daily.png_failed');
    }
  }

  function print(): void {
    open = null;
    printDaily(document, window, title, rangeText, rows);
  }

  function onWindowClick(event: MouseEvent): void {
    if (open !== null && card && event.target instanceof Node && !card.contains(event.target)) open = null;
  }
  function onKey(event: KeyboardEvent): void {
    if (event.key === 'Escape' && open !== null) {
      event.stopPropagation();
      open = null;
    }
  }
</script>

<svelte:window onclick={onWindowClick} />

<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
<section data-tile="daily" class="card daily" aria-label={t('daily.title')} bind:this={card} onkeydown={onKey}>
  <header>
    <h2 class="eyebrow" data-hint={t('hint.ui.daily')}>{title} <span class="muted day" data-range>{rangeText}</span></h2>
    <div class="icons">
      <button type="button" class="icon" data-turn="prev" aria-label={t('daily.prev')} data-hint={t('daily.prev')} disabled={!canPage(period, -1, app.today)} onclick={() => turn(-1)}>
        <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M10 3 5 8l5 5" /></svg>
      </button>
      <button type="button" class="icon" data-turn="next" aria-label={t('daily.next')} data-hint={t('daily.next')} disabled={!canPage(period, 1, app.today)} onclick={() => turn(1)}>
        <svg viewBox="0 0 16 16" aria-hidden="true"><path d="m6 3 5 5-5 5" /></svg>
      </button>
      <button type="button" class="icon" data-popup="period" aria-expanded={open === 'period'} aria-label={t('daily.period')} data-hint={t('hint.ui.daily.period')} onclick={() => (open = open === 'period' ? null : 'period')}>
        <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 2h9a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H3zM3 2v12M6 5h4M6 8h4" /></svg>
      </button>
      <button type="button" class="icon" data-popup="print" aria-expanded={open === 'print'} aria-label={t('daily.print')} data-hint={t('hint.ui.daily.print')} onclick={() => (open = open === 'print' ? null : 'print')}>
        <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 6V2h8v4M4 11H2V6h12v5h-2M4 9h8v5H4z" /></svg>
      </button>
      <button type="button" class="icon" data-popup="metrics" aria-expanded={open === 'metrics'} aria-label={t('daily.metrics')} data-hint={t('hint.ui.daily.metrics')} onclick={() => (open = open === 'metrics' ? null : 'metrics')}>
        <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2.5 4 4 5.5 6.5 3M2.5 9 4 10.5 6.5 8M9 4h5M9 9h5M2.5 14 4 15M9 14h5" /></svg>
      </button>
      <button type="button" class="hide" aria-label={t('today.hide')} title={t('today.hide')} onclick={() => app.hideTile('daily')}>×</button>
    </div>
  </header>

  {#if open === 'period'}
    <div class="popup" role="group" aria-label={t('daily.period')}>
      <fieldset>
        <legend class="muted">{t('daily.view')}</legend>
        {#each PERIOD_MODES as mode (mode)}
          <label><input type="radio" name="daily-mode" value={mode} checked={prefs.mode === mode} onchange={() => pickMode(mode)} /> {t(`daily.mode.${mode}` as Key)}</label>
        {/each}
      </fieldset>
      {#if prefs.mode === 'custom'}
        <div class="custom">
          <label>{t('daily.from')} <input type="date" data-date="from" value={days.since} max={app.today} onchange={(e) => choose({ from: e.currentTarget.value, to: prefs.to ?? days.until })} /></label>
          <label>{t('daily.to')} <input type="date" data-date="to" value={days.until} max={app.today} onchange={(e) => choose({ to: e.currentTarget.value, from: prefs.from ?? days.since })} /></label>
        </div>
      {/if}
    </div>
  {:else if open === 'print'}
    <div class="popup" role="group" aria-label={t('daily.print')}>
      <button type="button" data-action="png" onclick={() => void saveImage()}>{t('daily.save_png')}</button>
      <button type="button" data-action="print" onclick={print}>{t('daily.print_pdf')}</button>
    </div>
  {:else if open === 'metrics'}
    <div class="popup" role="group" aria-label={t('daily.metrics')}>
      {#each METRICS as metric (metric)}
        <label data-hint={t(`hint.ui.daily.m.${metric}` as Key)}>
          <input type="checkbox" data-metric={metric} checked={prefs.metrics.includes(metric)} onchange={(e) => toggleMetric(metric, e.currentTarget.checked)} />
          {t(`daily.m.${metric}` as Key)}
        </label>
      {/each}
    </div>
  {/if}

  {#if shownMetrics.length === 0}
    <p class="muted none">{t('daily.none')}</p>
  {:else}
    <ul class="figures">
      {#each shownMetrics as metric (metric)}
        <li data-figure={metric} data-hint={t(`hint.ui.daily.m.${metric}` as Key)}>
          <span class="num">{textOf(metric)}</span>
          <span class="muted">{t(`daily.m.${metric}` as Key)}</span>
        </li>
      {/each}
    </ul>
  {/if}
</section>

<style>
  .daily header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.5rem;
  }
  .daily .day {
    font-weight: normal;
    text-transform: none;
    letter-spacing: 0;
    margin-left: 0.4rem;
  }
  .icons {
    display: flex;
    align-items: center;
    gap: 0.15rem;
  }
  .icon,
  .hide {
    background: none;
    border: 1px solid transparent;
    border-radius: var(--radius);
    color: var(--muted);
    cursor: pointer;
    padding: 0.2rem 0.3rem;
    line-height: 1;
  }
  .icon:hover:not(:disabled),
  .icon[aria-expanded='true'] {
    background: var(--surface-2);
    color: var(--text);
  }
  .icon:disabled {
    opacity: 0.35;
    cursor: default;
  }
  .icon svg {
    width: 1rem;
    height: 1rem;
    display: block;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.4;
    stroke-linecap: round;
    stroke-linejoin: round;
  }
  .popup {
    display: flex;
    flex-wrap: wrap;
    gap: 0.4rem 1rem;
    align-items: center;
    margin: 0.4rem 0;
    padding: 0.5rem 0.6rem;
    background: var(--surface-2);
    border: 1px solid var(--line);
    border-radius: var(--radius);
  }
  .popup fieldset {
    display: flex;
    gap: 0.8rem;
    flex-wrap: wrap;
    border: 0;
    margin: 0;
    padding: 0;
  }
  .popup legend {
    float: left;
    margin-right: 0.6rem;
    padding: 0;
  }
  .custom {
    display: flex;
    gap: 0.8rem;
    flex-wrap: wrap;
  }
  .popup button {
    background: var(--surface);
    border: 1px solid var(--line);
    border-radius: var(--radius);
    color: var(--text);
    cursor: pointer;
    padding: 0.25rem 0.7rem;
  }
  .figures {
    display: flex;
    gap: 0.4rem 1.5rem;
    flex-wrap: wrap;
    list-style: none;
    margin: 0.3rem 0 0;
    padding: 0;
  }
  .figures li {
    display: flex;
    align-items: baseline;
    gap: 0.4rem;
  }
  .figures .num {
    font-size: 1.4rem;
    font-weight: 600;
  }
  .none {
    margin: 0.3rem 0 0;
  }
  .hide {
    font-size: 1.1rem;
  }

  /* The page for the printer or a PDF stands in the document only while the print dialog is open; while it does, the
     rest of the page is not printed. */
  :global(#daily-print) {
    display: none;
  }
  @media print {
    :global(html.print-daily body > *:not(#daily-print)) {
      display: none !important;
    }
    :global(html.print-daily #daily-print) {
      display: block;
      padding: 1.5cm;
      color: black;
      background: white;
    }
    :global(#daily-print table) {
      border-collapse: collapse;
      margin-top: 1rem;
    }
    :global(#daily-print th),
    :global(#daily-print td) {
      text-align: left;
      padding: 0.3rem 1.5rem 0.3rem 0;
    }
  }
</style>
