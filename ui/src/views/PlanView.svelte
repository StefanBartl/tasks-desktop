<script lang="ts">
  // The plan, read only: what can be worked on at once (a stage), what holds
  // the rest up (the critical path) and what the plan warns about.
  import type { App } from '../lib/app.svelte';
  import { formatNumber, labelOf, translate, type Key } from '../lib/i18n';
  import { criticalIds, phaseCounts, stagesOf } from '../lib/plan';
  import { markHidden } from '../lib/text';

  let { app }: { app: App } = $props();
  const t = (key: Key, params: Record<string, string | number> = {}) =>
    translate(app.lang, key, params);

  const snapshot = $derived(app.snapshot);
  let chosen = $state<string>('');
  const plans = $derived(snapshot?.plans ?? []);
  // A plan that is gone (a change of the vault) is not kept chosen.
  const planId = $derived(plans.some((p) => p.id === chosen) ? chosen : '');
  const stages = $derived(stagesOf(app.tasks, planId === '' ? null : planId));
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

  function open(id: string): void {
    app.select(id);
    app.setView('list');
  }

  const warnings = $derived(snapshot?.plan.warnings ?? []);
  const cycles = $derived(snapshot?.plan.cycles ?? []);
  const sameFile = $derived(snapshot?.plan.conflict_groups ?? []);
</script>

<div class="plan">
  {#if !snapshot}
    <p class="muted">{t('state.loading')}</p>
  {:else}
    <section class="card head" aria-label={t('plan.summary')}>
      <div class="chips">
        {#if summary}
          {#each [['ready', summary.ready], ['decision', summary.decision], ['waiting', summary.waiting], ['stuck', summary.stuck], ['freed', summary.freed], ['parked', summary.parked]] as [state, n] (state)}
            <span class="chip"
              ><strong>{n}</strong> {labelOf(app.lang, 'state', String(state))}</span
            >
          {/each}
        {/if}
      </div>
      {#if plans.length > 0}
        <label class="plan-select">
          <span>{t('plan.which')}</span>
          <select bind:value={chosen}>
            <option value="">{t('plan.all')}</option>
            {#each plans as p (p.id)}
              <option value={p.id}>{p.title}</option>
            {/each}
          </select>
        </label>
      {/if}
      {#if phases.length > 0}
        <p class="phases">
          {#each phases as ph (ph.phase)}<span class="chip soft">{ph.phase}: {ph.n}</span>{/each}
        </p>
      {/if}
      {#if estimate}
        <p class="muted">
          {t('plan.estimate', {
            n: estimate.n_with_effort,
            total: estimate.tasks,
            days: formatNumber(app.lang, estimate.days),
          })}
        </p>
      {/if}
    </section>

    {#if path && path.path.length > 0}
      <section class="card" aria-label={t('plan.critical')}>
        <h2 class="eyebrow">
          {t('plan.critical')}: {t('plan.days', { days: formatNumber(app.lang, path.days) })}
        </h2>
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
        <h2 class="eyebrow">{t('plan.warnings')}</h2>
        <ul class="plain">
          {#each cycles as cycle, i (i)}
            <li>{t('plan.cycle')}: <code>{cycle.join(' → ')}</code></li>
          {/each}
          {#each sameFile as group, i (i)}
            <li>
              {t('plan.same_file', { stage: group.stage })}: <code>{group.file}</code>
              ({group.ids.join(', ')})
            </li>
          {/each}
          {#each warnings as w, i (i)}
            <li><code>{w.code}</code> {markHidden(w.msg)}</li>
          {/each}
        </ul>
      </section>
    {/if}

    <section class="stages" aria-label={t('plan.stages')}>
      {#each stages as stage (stage.stage ?? 'cycle')}
        <div class="stage card">
          <h2 class="eyebrow">
            {stage.stage === null ? t('plan.no_stage') : t('plan.stage', { n: stage.stage })}
            ({stage.tasks.length})
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
                  {#if task.effort}<span class="tag soft">{task.effort}</span>{/if}
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
  .chips,
  .phases {
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
    display: inline-grid;
    gap: 0.15rem;
    font-size: 0.8rem;
    color: var(--muted);
    margin-top: 0.4rem;
  }
  .plan-select select {
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
