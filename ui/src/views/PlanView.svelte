<script lang="ts">
  // The plan, read only: what can be worked on at once (a stage), what holds
  // the rest up (the critical path) and what the plan warns about.
  import type { App } from '../lib/app.svelte';
  import { formatNumber, hintOf, labelOf, translate, type Key } from '../lib/i18n';
  import Info from './Info.svelte';
  import { chosenPlan, criticalIds, firstTasks, phaseCounts, stagesOf, warningsOf } from '../lib/plan';
  import { markHidden } from '../lib/text';
  import GraphPanel from './GraphPanel.svelte';
  import PlanFinished from './PlanFinished.svelte';

  let { app }: { app: App } = $props();
  const t = (key: Key, params: Record<string, string | number> = {}) =>
    translate(app.lang, key, params);

  const snapshot = $derived(app.snapshot);
  const plans = $derived(snapshot?.plans ?? []);
  // A plan that is gone (a change of the vault) is not kept chosen.
  const planId = $derived(chosenPlan(plans, app.planChoice));
  const stages = $derived(stagesOf(app.tasks, planId === '' ? null : planId));
  // The first tasks are drawn at once and the rest in the frames after, like the list: a plan of two thousand tasks
  // is not one block of work between the click and the first stage (measured: 50 ms for 600, 150 ms for 2000).
  const FIRST = 200;
  const STEP = 400;
  // How far the drawing has grown, and for which plan: the limit is a function of the plan, so another plan starts
  // from the first tasks at once and never from the number the last one had grown to (an effect that reset it would
  // run after the first draw of the new plan, which would then be drawn with the old number).
  let grown = $state({ plan: '', n: FIRST });
  const limit = $derived(grown.plan === planId ? grown.n : FIRST);
  const total = $derived(stages.reduce((n, s) => n + s.tasks.length, 0));
  const drawn = $derived(firstTasks(stages, limit));
  $effect(() => {
    if (limit >= total) return;
    const plan = planId;
    const frame = requestAnimationFrame(() => {
      grown = { plan, n: Math.min(total, limit + STEP) };
    });
    return () => cancelAnimationFrame(frame);
  });
  const critical = $derived(criticalIds(snapshot?.plan));
  const phases = $derived(
    phaseCounts(
      app.tasks,
      plans.find((p) => p.id === planId),
    ),
  );
  const summary = $derived(snapshot?.plan.summary);
  const path = $derived(snapshot?.plan.critical_path);
  const estimate = $derived(snapshot?.estimate);
  const titles = $derived(new Map(app.tasks.map((x) => [x.id, x.title] as const)));

  // A chosen plan that is gone (a change of the vault) is dropped, so the select agrees.
  $effect(() => {
    if (app.planChoice !== '' && planId === '') app.planChoice = '';
  });

  function open(id: string): void {
    app.reveal(id);
  }

  // What the six counters mean, in one text for the button that can be reached with the keyboard.
  const STATES = ['ready', 'decision', 'waiting', 'stuck', 'freed', 'parked'] as const;
  const statesLegend = $derived(
    STATES.map((s) => `${labelOf(app.lang, 'state', s)}: ${hintOf(app.lang, 'hint.state', s)}`).join('\n'),
  );
  const daysText = (days: number): string =>
    t(days === 1 ? 'plan.day' : 'plan.days', { days: formatNumber(app.lang, days) });

  const narrowed = $derived(warningsOf(snapshot?.plan, app.tasks, planId === '' ? null : planId));
  const warnings = $derived(narrowed.warnings);
  const cycles = $derived(narrowed.cycles);
  const sameFile = $derived(narrowed.conflict_groups);
</script>

<div class="plan">
  {#if !snapshot}
    <p class="muted">{t('state.loading')}</p>
  {:else}
    <section class="card head" aria-label={t('plan.summary')}>
      <div class="chips">
        {#if summary}
          {#each [['ready', summary.ready], ['decision', summary.decision], ['waiting', summary.waiting], ['stuck', summary.stuck], ['freed', summary.freed], ['parked', summary.parked]] as [state, n] (state)}
            <span class="chip" data-hint={hintOf(app.lang, 'hint.state', String(state))}
              ><strong>{n}</strong> {labelOf(app.lang, 'state', String(state))}</span
            >
          {/each}
          <Info hint={statesLegend} label={t('hint.about', { what: t('plan.counters') })} />
        {/if}
      </div>
      <div class="toolbar">
        {#if plans.length > 0}
          <label class="plan-select">
            <span>{t('plan.which')}</span>
            <select bind:value={app.planChoice}>
              <option value="">{t('plan.all')}</option>
              {#each plans as p (p.id)}
                <option value={p.id}>{markHidden(p.title)}</option>
              {/each}
            </select>
          </label>
        {/if}
        <button type="button" class="newplan" disabled={!app.can('plan_new')} onclick={() => app.openPlanWizard()}>{t('plan.new.button')}</button>
      </div>
      {#if phases.length > 0}
        <p class="phases">
          <span class="label">{t('plan.phases')}</span>
          {#each phases as ph (ph.phase)}<span class="chip soft">{markHidden(ph.phase)}: {ph.n}</span>{/each}
          <Info hint={t('hint.phases')} label={t('hint.about', { what: t('plan.phases') })} />
        </p>
      {/if}
      {#if planId !== ''}
        <p class="muted">{t('plan.whole_vault')}</p>
      {/if}
      {#if estimate}
        <p class="muted">
          {t('plan.estimate', {
            n: estimate.n_with_effort,
            total: estimate.tasks,
            days: formatNumber(app.lang, estimate.days),
          })}
          <Info hint={t('hint.estimate')} label={t('hint.about', { what: t('plan.estimate_what') })} />
        </p>
      {/if}
    </section>

    {#if path && path.path.length > 0}
      <section class="card" aria-label={t('plan.critical')}>
        <div class="headline">
          <h2 class="eyebrow">{t('plan.critical')}: {daysText(path.days)}</h2>
          <Info hint={t('hint.critical')} label={t('hint.about', { what: t('plan.critical') })} />
        </div>
        <ol class="path">
          {#each path.path as id (id)}
            <li>
              <button type="button" class="link" onclick={() => open(id)}
                >{markHidden(titles.get(id) ?? id)}</button
              >
            </li>
          {/each}
        </ol>
        {#if path.unknown_effort > 0}
          <p class="muted">{t('plan.unknown_effort', { n: path.unknown_effort })}</p>
        {/if}
      </section>
    {/if}

    {#if warnings.length > 0 || cycles.length > 0 || sameFile.length > 0}
      <section class="card warn" aria-label={t('plan.warnings')} role="note">
        <div class="headline">
          <h2 class="eyebrow">{t('plan.warnings')}</h2>
          <Info hint={t('hint.warnings')} label={t('hint.about', { what: t('plan.warnings') })} />
        </div>
        <ul class="plain">
          {#each cycles as cycle, i (i)}
            <li>{t('plan.cycle')}: <code>{markHidden(cycle.join(' → '))}</code></li>
          {/each}
          {#each sameFile as group, i (i)}
            <li>
              {t('plan.same_file', { stage: group.stage })}: <code>{markHidden(group.file)}</code>
              ({markHidden(group.ids.join(', '))})
              <Info hint={t('hint.same_file')} label={t('hint.about', { what: t('plan.same_file_what') })} />
            </li>
          {/each}
          {#each warnings as w, i (i)}
            <li><code>{markHidden(w.code)}</code> {markHidden(w.msg)}</li>
          {/each}
        </ul>
      </section>
    {/if}

    <GraphPanel {app} />

    <PlanFinished {app} {planId} />

    <section class="stages" tabindex="-1" aria-label={t('plan.stages')}>
      {#each drawn as stage (stage.stage ?? 'cycle')}
        <div class="stage card">
          <h2 class="eyebrow">
            {stage.stage === null ? t('plan.no_stage') : t('plan.stage', { n: stage.stage })}
            ({stage.total})
          </h2>
          <ul class="plain">
            {#each stage.tasks as task (task.id)}
              <li class:critical={critical.has(task.id)}>
                <button
                  type="button"
                  class="link"
                  aria-current={task.id === app.selectedId ? 'true' : undefined}
                  onclick={() => open(task.id)}>{markHidden(task.title)}</button
                >
                <span class="meta">
                  {#if critical.has(task.id)}<span class="tag crit">{t('plan.on_path')}</span>{/if}
                  <span class="tag">{labelOf(app.lang, 'status', task.status)}</span>
                  {#if task.readiness && task.readiness.state !== 'ready' && task.readiness.state !== 'unknown'}
                    <span class="tag soft">{labelOf(app.lang, 'state', task.readiness.state)}</span>
                  {/if}
                  <span class="tag soft">{task.prio !== undefined ? `P${task.prio}` : '?'}</span>
                  {#if task.effort}<span class="tag soft">{markHidden(task.effort)}</span>{/if}
                </span>
              </li>
            {/each}
          </ul>
        </div>
      {:else}
        <p class="muted">{t('plan.empty')}</p>
      {/each}
    </section>
  {/if}
</div>

<style>
  .plan {
    display: grid;
    gap: 1rem;
  }
  .card {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 0.9rem 1rem;
  }
  .card.warn {
    border-color: var(--warn);
  }
  /* The plan and its button are one row: the label belongs to the choice, the button comes after it. */
  .toolbar {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.5rem 1rem;
    margin: 0.5rem 0;
  }
  .newplan {
    background: var(--surface-2);
    color: var(--text);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 0.25rem 0.6rem;
    cursor: pointer;
  }
  .headline {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    margin-bottom: 0.5em;
  }
  .headline .eyebrow {
    margin: 0;
  }
  .label {
    color: var(--muted);
    font-size: 0.85rem;
  }
  .chips,
  .phases {
    align-items: center;
    display: flex;
    flex-wrap: wrap;
    gap: 0.4rem;
    margin: 0.2rem 0;
  }
  .chip {
    background: var(--surface-2);
    border: 1px solid var(--border);
    border-radius: 999px;
    padding: 0.1rem 0.6rem;
    font-size: 0.85rem;
  }
  .chip.soft {
    color: var(--muted);
  }
  .plan-select {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    min-width: 0;
    max-width: 100%;
    font-size: 0.85rem;
    color: var(--muted);
  }
  .plan-select select {
    min-width: 0;
    max-width: 100%;
    background: var(--surface-2);
    color: var(--text);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 0.25rem 0.5rem;
  }
  .eyebrow {
    font-size: 0.8rem;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--muted);
    margin: 0 0 0.5em;
  }
  .muted {
    color: var(--muted);
  }
  .path {
    margin: 0;
    padding-left: 1.4rem;
  }
  .stages {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(21rem, 1fr));
    gap: 1rem;
    align-items: start;
  }
  .plain {
    list-style: none;
    padding: 0;
    margin: 0;
  }
  .plain li {
    display: grid;
    gap: 0.15rem;
    padding: 0.3rem 0;
    border-bottom: 1px solid var(--border);
  }
  .plain li:last-child {
    border-bottom: 0;
  }
  .plain li.critical {
    border-left: 3px solid var(--accent);
    padding-left: 0.5rem;
  }
  .link {
    background: none;
    border: 0;
    padding: 0;
    color: var(--accent);
    cursor: pointer;
    text-align: left;
  }
  .meta {
    display: flex;
    flex-wrap: wrap;
    gap: 0.3rem;
  }
  .tag {
    font-size: 0.75rem;
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 0 0.35rem;
  }
  .tag.soft {
    color: var(--muted);
  }
  .tag.crit {
    border-color: var(--accent);
    color: var(--accent);
  }
</style>
