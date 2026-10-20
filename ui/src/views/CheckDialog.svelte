<script lang="ts">
  // The check of the vault. It runs in the hub, in the background: this dialog starts it, shows what the hub says of
  // it, and lists the engine's findings with a jump to the task. Closing it does not stop the job.
  import type { App } from '../lib/app.svelte';
  import { hintOf, translate, type Key } from '../lib/i18n';
  import { markHidden } from '../lib/text';
  import { timeOf } from '../lib/check';
  import { checkLegend } from '../lib/legend';
  import Info from 'appkit-ui/Info.svelte';

  let { app }: { app: App } = $props();
  const t = (key: Key, params: Record<string, string | number> = {}) => translate(app.lang, key, params);

  let dialog: HTMLDialogElement | undefined = $state();
  let refs = $state(false);
  const job = $derived(app.checkJob);
  const running = $derived(job?.state === 'running');
  const findings = $derived(app.checkFindings);
  const stale = $derived(app.checkStale);
  const checkedAt = $derived(job?.state === 'done' ? timeOf(job.result.generated_at, app.lang) : null);

  $effect(() => {
    if (!dialog) return;
    if (app.checking && !dialog.open) dialog.showModal();
    if (!app.checking && dialog.open) dialog.close();
  });

  function jump(id: string): void {
    app.closeChecks();
    app.setView('list');
    app.reveal(id);
  }
</script>

<dialog bind:this={dialog} aria-labelledby="check-title" onclose={() => app.closeChecks()}>
  {#if app.checking}
    <h2 id="check-title">{t('check.title')}</h2>
    <!-- The codes of the findings are explained on hover; this is the way for the keyboard and a screen reader: one stop. -->
    {#if findings.length > 0 || stale.length > 0}
      <Info hint={checkLegend(app.lang, [...findings, ...stale].map((f) => f.code))} label={t('hint.about', { what: t('check.codes_what') })} />
    {/if}
    <p class="help">{t('check.help')}</p>
    <div class="run">
      <label><input type="checkbox" bind:checked={refs} disabled={running} /> {t('check.refs')}</label>
      <button type="button" class="primary" disabled={running && !app.checkProblem} onclick={() => void app.runCheck(refs)}>{t('check.run')}</button>
    </div>
    <div class="state" role="status" aria-live="polite">
      {#if app.checkProblem}
        <p class="problem">{app.checkProblem}</p>
      {:else if job?.state === 'running'}
        <p>{t('check.running')}</p>
      {:else if job?.state === 'failed'}
        <p class="problem">{t('check.job_failed', { message: markHidden(job.error.message) })}</p>
      {:else if job?.state === 'done'}
        {#if app.checkOutdated}
          <p class="problem">{t('check.outdated')}</p>
        {:else}
          <p class="summary">{t('check.summary', { errors: job.result.errors, warnings: job.result.warnings, tasks: job.result.tasks })}</p>
          {#if checkedAt}<p class="muted">{t('check.as_of', { time: checkedAt })}</p>{/if}
          {#if app.checkChanged > 0}<p class="notice">{t('check.changed', { n: app.checkChanged })}</p>{/if}
          {#if job.result.truncated}<p class="muted">{t('check.truncated', { n: job.result.findings.length, total: job.result.total })}</p>{/if}
          {#each job.result.notes as note, i (i)}<p class="muted">{markHidden(note)}</p>{/each}
          {#if findings.length === 0 && stale.length === 0}<p class="muted">{t('check.clean')}</p>{/if}
        {/if}
      {:else}
        <p class="muted">{t('check.idle')}</p>
      {/if}
    </div>
    {#if findings.length > 0 || stale.length > 0}
      <ul class="findings">
        {#each [...findings, ...stale] as f, i (i)}
          <li class:stale={i >= findings.length}>
            <span class="tag" class:err={f.severity === 'error'}>{f.severity === 'error' ? t('check.error') : t('check.warn')}</span>
            {#if i >= findings.length}<span class="tag">{t('check.stale_task')}</span>{/if}
            <code data-hint={hintOf(app.lang, 'hint.check', f.code) || t('hint.check.code')}>{markHidden(f.code)}</code>
            {#if f.id}
              <button type="button" class="linkish" onclick={() => jump(f.id as string)}>{markHidden(f.id)}</button>
            {:else}
              <span class="file">{markHidden(f.file)}</span>
            {/if}
            <span class="msg">{markHidden(f.message)}</span>
          </li>
        {/each}
      </ul>
    {/if}
    <div class="actions">
      <button type="button" onclick={() => app.closeChecks()}>{t('check.close')}</button>
    </div>
  {/if}
</dialog>

<style>
  dialog {
    background: var(--surface);
    color: var(--text);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 1rem 1.25rem;
    width: min(50rem, calc(100vw - 2rem));
  }
  dialog::backdrop {
    background: var(--backdrop);
  }
  h2 {
    margin: 0 0 0.4rem;
    font-size: 1.1rem;
  }
  .help,
  .muted {
    color: var(--muted);
    font-size: 0.85rem;
    margin: 0.2rem 0;
  }
  .run {
    display: flex;
    flex-wrap: wrap;
    gap: 0.75rem;
    align-items: center;
    margin: 0.5rem 0;
  }
  .state p {
    margin: 0.2rem 0;
  }
  .summary {
    font-weight: 600;
  }
  .notice {
    margin: 0.2rem 0;
    font-size: 0.85rem;
  }
  .findings li.stale {
    color: var(--muted);
  }
  .problem {
    color: var(--warn);
  }
  .findings {
    list-style: none;
    margin: 0.5rem 0;
    padding: 0;
    max-height: 45vh;
    overflow: auto;
    border: 1px solid var(--border);
    border-radius: var(--radius);
  }
  .findings li {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
    align-items: baseline;
    padding: 0.3rem 0.5rem;
    border-bottom: 1px solid var(--border);
  }
  .tag {
    font-size: 0.75rem;
    padding: 0 0.4rem;
    border-radius: 999px;
    border: 1px solid var(--border);
    color: var(--muted);
  }
  .tag.err {
    color: var(--warn);
    border-color: var(--warn);
  }
  .file {
    font-family: var(--mono);
    font-size: 0.8rem;
    color: var(--muted);
  }
  .msg {
    flex: 1 1 18rem;
  }
  .linkish {
    background: none;
    border: 0;
    padding: 0;
    color: var(--accent);
    cursor: pointer;
    font-family: var(--mono);
    font-size: 0.8rem;
  }
  .actions {
    display: flex;
    justify-content: flex-end;
  }
  button {
    background: var(--surface-2);
    color: var(--text);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 0.35rem 0.8rem;
    cursor: pointer;
  }
  .linkish {
    border: 0;
    background: none;
    padding: 0;
  }
  .primary {
    border-color: var(--accent);
  }
  button:disabled {
    opacity: 0.6;
    cursor: default;
  }
</style>
