<script lang="ts">
  import { contextTarget } from 'appkit-ui/contextmenu';
  import { selectionTarget } from '../lib/context';
  // The plan, read only: what can be worked on at once (a stage), what holds
  // the rest up (the critical path) and what the plan warns about.
  import type { App } from '../lib/app.svelte';
  import { formatNumber, hintOf, labelOf, translate, type Key } from '../lib/i18n';
  import Info from 'appkit-ui/Info.svelte';
  import { TIP_ID } from 'appkit-ui/tooltip';
  import { stagesLegend } from '../lib/legend';
  import { chosenPlan, criticalIds, firstTasks, phaseCounts, planEmptyKey, stagesOf, warningsOf } from '../lib/plan';
  import { markHidden } from '../lib/text';
  import { statusTags } from '../lib/statusTags';
  import { narrows } from '../lib/filter';
  import FilterNote from './FilterNote.svelte';
  import GraphPanel from './GraphPanel.svelte';
  import PlanFinished from './PlanFinished.svelte';
  import FoldButton from './FoldButton.svelte';
  import ExportMenu from './ExportMenu.svelte';
  import PlanGraph from './PlanGraph.svelte';
  import { allButtonFold, foldOf, withAll, withFold } from '../lib/fold';

  let { app }: { app: App } = $props();
  /** What the choice of the plan is for the context menu: the plan, opened as a view. */
  function planTarget() {
    const plan = plans.find((p) => p.id === planId);
    return plan ? selectionTarget(plan.title, { plans: [plan.id] }) : undefined;
  }
  const t = (key: Key, params: Record<string, string | number> = {}) =>
    translate(app.lang, key, params);

  const snapshot = $derived(app.snapshot);
  const plans = $derived(snapshot?.plans ?? []);
  // A plan that is gone (a change of the vault) is not kept chosen.
  const planId = $derived(chosenPlan(plans, app.planChoice));
  const stages = $derived(stagesOf(app.shown, planId === '' ? null : planId));
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
  // A stage is remembered by its number; the tasks of a cycle have none. The button for all of them takes every stage
  // of the plan, also the ones the next frames are still to draw.
  const stageKey = (n: number | null): string => (n === null ? 'cycle' : String(n));
  const stageKeys = $derived(stages.map((s) => stageKey(s.stage)));
  const allFold = $derived(allButtonFold(app.folds.plan, stageKeys));
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
    app.peek(id);
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
  <FilterNote {app} plan />
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
        <!-- The same words as the search of the list (one filter for every view): the stages narrow to them. -->
        <input
          type="search"
          class="plan-search"
          data-hint={t('hint.ui.list.search')}
          placeholder={t('list.search')}
          aria-label={t('list.search')}
          value={app.filter.query}
          oninput={(e) => app.setQuery(e.currentTarget.value)}
          onkeydown={(e) => {
            // An open hint of the field takes this Escape alone (the kit closes it, on the document).
            const hintOpen = (e.currentTarget.getAttribute('aria-describedby') ?? '').split(' ').includes(TIP_ID);
            if (e.key === 'Escape' && !e.isComposing && !hintOpen && app.filter.query !== '') {
              e.preventDefault();
              app.setQuery('');
            }
          }}
        />
        {#if plans.length > 0}
          <label
            class="plan-select"
            data-hint={t('hint.ui.plan.select')}
            use:contextTarget={planTarget()}
          >
            <span>{t('plan.which')}</span>
            <select bind:value={app.planChoice}>
              <option value="">{t('plan.all')}</option>
              {#each plans as p (p.id)}
                <option value={p.id}>{markHidden(p.title)}</option>
              {/each}
            </select>
          </label>
        {/if}
        <div class="display" role="group" aria-label={t('plan.display')}>
          {#each ['stages', 'graph'] as const as display (display)}
            <button type="button" aria-pressed={app.planDisplay === display} onclick={() => app.setPlanDisplay(display)}
              >{t(`plan.display.${display}`)}</button
            >
          {/each}
        </div>
        <button type="button" class="newplan" data-hint={t('hint.ui.plan.new')} disabled={!app.can('plan_new')} onclick={() => app.openPlanWizard()}>{t('plan.new.button')}</button>
        <ExportMenu {app} />
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
          <h2 class="eyebrow" data-hint={t('hint.critical')}>{t('plan.critical')}: {daysText(path.days)}</h2>
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
      <!-- Folded when the page opens: the warnings are there to look at, not to stand over the plan. -->
      <div class="card warn-tile">
      <details class="warn" aria-label={t('plan.warnings')}>
        <summary class="headline">
          <h2 class="eyebrow">
            {t('plan.warnings')} ({warnings.length + cycles.length + sameFile.length})
          </h2>
        </summary>
        <ul class="plain">
          {#each cycles as cycle, i (i)}
            <li>{t('plan.cycle')}: <code>{markHidden(cycle.join(' → '))}</code></li>
          {/each}
          {#each sameFile as group, i (i)}
            <li>
              <code>{markHidden(group.file)}</code>
              {t('plan.same_file_named', { stage: group.stage })}
              {markHidden(group.ids.join(', '))}
              <Info hint={t('hint.same_file')} label={t('hint.about', { what: t('plan.same_file_what') })} />
            </li>
          {/each}
          {#each warnings as w, i (i)}
            <li><code>{markHidden(w.code)}</code> {markHidden(w.msg)}</li>
          {/each}
        </ul>
      </details>
      <!-- Beside the folding part, not in its head (a button in a summary is a nested control): drawn at the head, so
           that it shows folded too. -->
      <span class="about"><Info hint={t('hint.warnings')} label={t('hint.about', { what: t('plan.warnings') })} /></span>
      </div>
    {/if}

    <GraphPanel {app} />

    <PlanFinished {app} {planId} />

    {#if app.planDisplay === 'graph'}
      {#if stages.length > 0}
        <PlanGraph {app} {stages} {critical} path={path?.path ?? []} {cycles} onopen={open} />
      {:else}
        <p class="muted">{t(planEmptyKey(narrows(app.filter), stagesOf(app.tasks, planId === '' ? null : planId).length))}</p>
      {/if}
    {:else}
    <section class="stages" tabindex="-1" aria-label={t('plan.stages')}>
      <p class="legend">
        <Info hint={stagesLegend(app.lang)} label={t('hint.about', { what: t('plan.legend.what') })} />
        {#if stages.length > 1}
          <FoldButton
            lang={app.lang}
            fold={allFold}
            what={t('fold.all_stages')}
            onfold={(next) => app.setFolds('plan', withAll(app.folds.plan, stageKeys, next))}
          />
        {/if}
      </p>
      {#each drawn as stage (stage.stage ?? 'cycle')}
        {@const key = stageKey(stage.stage)}
        {@const fold = foldOf(app.folds.plan, key)}
        {@const name = stage.stage === null ? t('plan.no_stage') : t('plan.stage', { n: stage.stage })}
        <div class="stage card" class:folded={fold !== 'open'} class:narrow={fold === 'narrow'} data-stage={key}>
          <div class="stage-head">
            <FoldButton
              lang={app.lang}
              {fold}
              what={name}
              onfold={(next) => app.setFolds('plan', withFold(app.folds.plan, key, next))}
            />
            <h2 class="eyebrow">{name} ({stage.total})</h2>
          </div>
          {#if fold === 'open'}
          <ul class="plain stage-list">
            {#each stage.tasks as task (task.id)}
              {@const shownState = task.readiness?.state === 'ready' || task.readiness?.state === 'unknown' ? undefined : task.readiness?.state}
              {@const tags = statusTags(app.lang, task.status, shownState)}
              <li class:critical={critical.has(task.id)} data-id={task.id}>
                <button
                  type="button"
                  class="link"
                  aria-current={task.id === app.selectedId ? 'true' : undefined}
                  onclick={() => open(task.id)}>{markHidden(task.title)}</button
                >
                <span class="meta">
                  {#if critical.has(task.id)}<span class="tag crit">{t('plan.on_path')}</span>{/if}
                  {#if app.crossAreas(task.id).length >= 2}
                    <span class="tag soft" data-hint={t('cross.mark', { n: app.crossAreas(task.id).length, areas: app.crossAreas(task.id).join(', ') })}><span aria-hidden="true">↔ {app.crossAreas(task.id).length}</span><span class="sr-only">{t('mark.cross', { n: app.crossAreas(task.id).length })}</span></span>
                  {/if}
                  <!-- The same marks as a row of the list, explained the same way. -->
                  <span class="tag" data-hint={tags.status.hint}>{tags.status.label}</span>
                  {#if tags.state}<span class="tag soft" data-hint={tags.state.hint}>{tags.state.label}</span>{/if}
                  <span class="tag soft" data-hint={hintOf(app.lang, 'hint', 'prio')}>{#if task.prio !== undefined}P{task.prio}{:else}<span aria-hidden="true">?</span><span class="sr-only">{t('mark.no_prio')}</span>{/if}</span>
                  {#if task.effort}<span class="tag soft" data-hint={hintOf(app.lang, 'hint', 'effort')}>{markHidden(task.effort)}</span>{/if}
                </span>
              </li>
            {/each}
          </ul>
          {/if}
        </div>
      {:else}
        <p class="muted">{t(planEmptyKey(narrows(app.filter), stagesOf(app.tasks, planId === '' ? null : planId).length))}</p>
      {/each}
    </section>
    {/if}
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
  .card.warn-tile {
    position: relative;
    border-color: var(--warn);
  }
  /* A summary laid out as flex loses the browser's triangle: the page draws its own. */
  details.warn > summary {
    cursor: pointer;
    margin-bottom: 0;
    list-style: none;
  }
  details.warn > summary::-webkit-details-marker {
    display: none;
  }
  details.warn > summary::before {
    content: '▸';
    color: var(--muted);
  }
  details.warn[open] > summary::before {
    content: '▾';
  }
  details.warn[open] > summary {
    margin-bottom: 0.5em;
  }
  .about {
    position: absolute;
    top: 0.9rem;
    right: 1rem;
    display: inline-flex;
    align-items: center;
  }
  /* The plan and its button are one row: the label belongs to the choice, the button comes after it. */
  .toolbar {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.5rem 1rem;
    margin: 0.5rem 0;
  }
  .plan-search {
    min-width: 12rem;
    background: var(--surface-2);
    color: var(--text);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 0.3rem 0.5rem;
  }
  .newplan {
    background: var(--surface-2);
    color: var(--text);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 0.25rem 0.6rem;
    cursor: pointer;
  }
  /* Stages or graph: two buttons of one choice, the chosen one pressed (as the directions of the graph panel). */
  .display {
    display: inline-flex;
    gap: 0.4rem;
  }
  .display button {
    background: var(--surface-2);
    color: var(--text);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 0.25rem 0.6rem;
    cursor: pointer;
  }
  .display button[aria-pressed='true'] {
    border-color: var(--accent);
    font-weight: 600;
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
  /* The stages wrap like words: an open one is about 21rem wide, a narrow one only as wide as its head on its side, so
     folded stages make room for the ones beside them. */
  .stages {
    display: flex;
    flex-wrap: wrap;
    gap: 1rem;
    align-items: flex-start;
  }
  .legend {
    flex: 1 0 100%;
    display: flex;
    align-items: center;
    gap: 0.5rem;
    margin: 0;
  }
  .stage {
    flex: 1 1 21rem;
    max-width: 32rem;
    min-width: 0;
  }
  .stage.folded {
    flex-grow: 0;
  }
  .stage.narrow {
    flex: 0 0 auto;
    padding: 0.6rem 0.3rem;
  }
  .stage-head {
    display: flex;
    align-items: center;
    gap: 0.3rem;
  }
  .stage-head .eyebrow {
    margin: 0;
  }
  .stage.narrow .stage-head {
    flex-direction: column;
  }
  .stage.narrow .stage-head .eyebrow {
    writing-mode: vertical-rl;
    white-space: nowrap;
  }
  /* A stage with many tasks scrolls in itself: the stages of the next row stay in reach. */
  .stage-list {
    margin-top: 0.5em;
    max-height: min(50vh, 28rem);
    overflow: auto;
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
