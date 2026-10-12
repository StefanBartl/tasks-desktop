<script lang="ts">
  import type { App } from '../lib/app.svelte';
  import { formatNumber, translate, type Key } from '../lib/i18n';
  import { hasHidden, markHidden } from '../lib/text';

  let { app }: { app: App } = $props();

  const t = (key: Key, params: Record<string, string | number> = {}) =>
    translate(app.lang, key, params);

  const task = $derived(app.selected);
  const detail = $derived(app.detail);
  const body = $derived(detail.state === 'ok' ? detail.doc.body : '');
  const byId = $derived(new Map(app.tasks.map((x) => [x.id, x] as const)));

  const unknown = '?';
  function show(value: string | number | undefined): string {
    return value === undefined ? unknown : String(value);
  }
  function statusOf(id: string): string {
    const status = byId.get(id)?.status;
    return status ? t(`status.${status}` as Key) : unknown;
  }
</script>

<aside class="detail" aria-label={t('detail.props')} aria-live="polite">
  {#if !task}
    <p class="muted">{t('detail.none')}</p>
  {:else}
    <h1>{markHidden(task.title)}</h1>
    <p class="id"><code>{task.id}</code></p>

    {#if task.problems.length > 0 || !task.valid}
      <div class="problems" role="alert">
        <h3>{t('detail.problems')}</h3>
        <ul>
          {#each task.problems as problem (problem.code + problem.msg)}
            <li><code>{problem.code}</code> {markHidden(problem.msg)}</li>
          {/each}
        </ul>
      </div>
    {/if}

    {#if task.summary}<p>{markHidden(task.summary)}</p>{/if}

    <h3>{t('detail.props')}</h3>
    <dl>
      <dt>{t('prop.status')}</dt>
      <dd>{task.status ? t(`status.${task.status}` as Key) : unknown}</dd>
      <dt>{t('prop.state')}</dt>
      <dd>{task.readiness ? t(`state.${task.readiness.state}` as Key) : unknown}</dd>
      <dt>{t('prop.area')}</dt>
      <dd>{task.area}</dd>
      <dt>{t('prop.prio')}</dt>
      <dd>{task.prio === undefined ? unknown : `P${task.prio}`}</dd>
      <dt>{t('prop.effort')}</dt>
      <dd>{show(task.effort)}</dd>
      <dt>{t('prop.value')}</dt>
      <dd>{show(task.value)}</dd>
      <dt>{t('prop.roi')}</dt>
      <dd>{task.roi === undefined ? unknown : formatNumber(app.lang, task.roi)}</dd>
      <dt>{t('prop.actor')}</dt>
      <dd>{task.actor ? t(`actor.${task.actor}` as Key) : unknown}</dd>
      {#if task.plan}
        <dt>{t('prop.plan')}</dt>
        <dd>{task.plan}{task.phase ? ` · ${task.phase}` : ''}</dd>
      {/if}
      <dt>{t('prop.updated')}</dt>
      <dd>{show(task.updated)}</dd>
    </dl>

    {#if task.blocked_by.length > 0}
      <h3>{t('detail.waits_on')}</h3>
      <ul class="plain">
        {#each task.blocked_by as id (id)}
          <li>
            <button type="button" class="link" onclick={() => byId.has(id) && app.select(id)}
              ><code>{id}</code></button
            >
            <span class="muted">{statusOf(id)}</span>
          </li>
        {/each}
      </ul>
    {/if}
    {#if task.after.length > 0}
      <h3>{t('detail.after')}</h3>
      <ul class="plain">
        {#each task.after as id (id)}
          <li><code>{id}</code> <span class="muted">{statusOf(id)}</span></li>
        {/each}
      </ul>
    {/if}

    {#if detail.state === 'loading'}
      <p class="muted">{t('detail.loading')}</p>
    {:else if detail.state === 'failed'}
      <p class="bad" role="alert">{t('detail.failed')}</p>
    {:else if detail.state === 'ok'}
      {#if detail.doc.steps.length > 0}
        <h3>{t('detail.steps')}</h3>
        <ul class="plain">
          {#each detail.doc.steps as step (step.n)}
            <li class:dropped={step.dropped}>
              <span aria-hidden="true">{step.ticked ? '☑' : step.dropped ? '⊘' : '☐'}</span>
              <span class="sr-only">{step.ticked ? 'done' : step.dropped ? 'dropped' : 'open'}</span>
              {markHidden(step.text)}
            </li>
          {/each}
        </ul>
      {/if}
      <h3>{t('detail.body')}</h3>
      {#if hasHidden(body)}<p class="warn">{t('detail.invisible')}</p>{/if}
      <!-- Text only: the body is untrusted and is never turned into HTML. -->
      <pre class="body">{markHidden(body)}</pre>
      {#if detail.doc.body_truncated}<p class="muted">{t('detail.body_truncated')}</p>{/if}
    {/if}

    <h3>{t('detail.file')}</h3>
    <p><code class="file">{task.file}</code></p>
  {/if}
</aside>

<style>
  .detail {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 1rem;
    overflow: auto;
    min-height: 0;
  }
  .id {
    margin: -0.25rem 0 0.75rem;
    color: var(--muted);
  }
  dl {
    display: grid;
    grid-template-columns: max-content 1fr;
    gap: 0.2rem 1rem;
    margin: 0 0 1rem;
  }
  dt {
    color: var(--muted);
  }
  dd {
    margin: 0;
  }
  .plain {
    list-style: none;
    padding: 0;
    margin: 0 0 1rem;
  }
  .plain li {
    padding: 0.1rem 0;
  }
  .dropped {
    text-decoration: line-through;
    color: var(--muted);
  }
  .muted {
    color: var(--muted);
  }
  .bad {
    color: var(--bad);
  }
  .warn {
    color: var(--warn);
  }
  .problems {
    border: 1px solid var(--bad);
    border-radius: var(--radius);
    padding: 0.5rem 0.75rem;
    margin-bottom: 1rem;
  }
  .link {
    background: none;
    border: 0;
    padding: 0;
    color: var(--accent);
    cursor: pointer;
  }
  .body {
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    background: var(--surface-2);
    border-radius: var(--radius);
    padding: 0.75rem;
    max-height: 24rem;
    overflow: auto;
  }
  .file {
    overflow-wrap: anywhere;
  }
</style>
