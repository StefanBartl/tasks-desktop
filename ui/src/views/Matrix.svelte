<script lang="ts">
  // The estimate matrix: effort and value of many tasks side by side. The figures under the table are the engine's
  // answer to what is chosen (`lib/estimate.ts`); this view only shows them.
  import type { App } from '../lib/app.svelte';
  import { EFFORT_SIZES, VALUES } from '../lib/fields';
  import { formatNumber, hintOf, translate, type Key } from '../lib/i18n';
  import Info from 'appkit-ui/Info.svelte';
  import { markHidden } from '../lib/text';

  let { app }: { app: App } = $props();
  const t = (key: Key, params: Record<string, string | number> = {}) => translate(app.lang, key, params);
  const n = (value: number) => formatNumber(app.lang, value);

  let dialog: HTMLDialogElement | undefined = $state();
  const open = $derived(app.matrix !== null);
  const rows = $derived(app.matrixRows);
  const figures = $derived(app.matrixFigures);
  const changed = $derived(app.matrixChanges);

  $effect(() => {
    if (!dialog) return;
    if (open && !dialog.open) {
      dialog.showModal();
      dialog.querySelector<HTMLSelectElement>('select')?.focus();
    }
    if (!open && dialog.open) dialog.close();
  });

  // What the effort cell offers: the sizes, and the effort the file has when it is none of them (`3d`).
  function efforts(current: string | undefined): string[] {
    return current && !(EFFORT_SIZES as readonly string[]).includes(current) ? [current, ...EFFORT_SIZES] : [...EFFORT_SIZES];
  }
</script>

<dialog bind:this={dialog} aria-labelledby="matrix-title" onclose={() => app.closeMatrix()}>
  {#if app.matrix}
    <h2 id="matrix-title">{t('matrix.title')}</h2>
    <p class="help">{t('matrix.help')}</p>
    <div class="scroll">
      <table>
        <thead>
          <tr>
            <th scope="col">{t('matrix.task')}</th>
            <th scope="col" aria-label={t('matrix.effort')}
              >{t('matrix.effort')}
              <Info hint={hintOf(app.lang, 'hint.field', 'effort')} label={t('hint.about', { what: t('matrix.effort') })} /></th
            >
            <th scope="col" aria-label={t('matrix.value')}
              >{t('matrix.value')}
              <Info hint={hintOf(app.lang, 'hint.field', 'value')} label={t('hint.about', { what: t('matrix.value') })} /></th
            >
          </tr>
        </thead>
        <tbody>
          {#each rows as task (task.id)}
            {@const cell = app.matrixDraft[task.id]}
            <tr class:edited={cell !== undefined}>
              <th scope="row">
                <span class="title">{markHidden(task.title)}</span>
                <span class="id">{task.id}</span>
              </th>
              <td>
                <select
                  aria-label={`${t('matrix.effort')}: ${task.id}`}
                  value={cell?.effort ?? ''}
                  disabled={app.saving}
                  onchange={(e) => app.setCell(task.id, 'effort', e.currentTarget.value === '' ? undefined : e.currentTarget.value)}
                >
                  <option value="">{task.effort ? `${task.effort} (${t('matrix.as_file')})` : `- (${t('matrix.as_file')})`}</option>
                  {#each efforts(task.effort) as size (size)}
                    <option value={size}>{size}</option>
                  {/each}
                </select>
              </td>
              <td>
                <select
                  aria-label={`${t('matrix.value')}: ${task.id}`}
                  value={cell?.value === undefined ? '' : String(cell.value)}
                  disabled={app.saving}
                  onchange={(e) => app.setCell(task.id, 'value', e.currentTarget.value === '' ? undefined : Number(e.currentTarget.value))}
                >
                  <option value="">{task.value !== undefined ? `${task.value} (${t('matrix.as_file')})` : `- (${t('matrix.as_file')})`}</option>
                  {#each VALUES as v (v)}
                    <option value={String(v)}>{v}</option>
                  {/each}
                </select>
              </td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
    <div class="figures" role="status" aria-live="polite" aria-busy={app.matrixPending} class:pending={app.matrixPending}>
      {#if app.matrixProblem}
        <p class="problem">{app.matrixProblem}</p>
      {:else if figures}
        <p class="sum">
          {t('matrix.sum', { tasks: figures.tasks, days: n(figures.days), low: n(figures.range.low), high: n(figures.range.high), value: figures.value })}
          <Info hint={t('hint.matrix.sum')} label={t('hint.about', { what: t('matrix.title') })} />
        </p>
        <p class="coverage">
          {t('matrix.coverage', { e: figures.n_with_effort, v: figures.n_with_value, n: figures.tasks })}
          <Info hint={t('hint.matrix.coverage')} label={t('hint.about', { what: t('matrix.coverage_what') })} />
        </p>
      {:else}
        <p class="coverage">{t('matrix.waiting')}</p>
      {/if}
    </div>
    <div class="actions">
      <button type="button" onclick={() => app.closeMatrix()}>{t('dialog.cancel')}</button>
      <button type="button" class="primary" disabled={app.saving || changed === 0} onclick={() => void app.applyMatrix()}>{t('matrix.apply')}</button>
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
    width: min(46rem, calc(100vw - 2rem));
  }
  dialog::backdrop {
    background: var(--backdrop);
  }
  h2 {
    margin: 0 0 0.4rem;
    font-size: 1.1rem;
  }
  .help {
    margin: 0 0 0.6rem;
    color: var(--muted);
    font-size: 0.85rem;
  }
  .scroll {
    max-height: 50vh;
    overflow: auto;
    border: 1px solid var(--border);
    border-radius: var(--radius);
  }
  table {
    width: 100%;
    border-collapse: collapse;
  }
  th,
  td {
    text-align: left;
    padding: 0.3rem 0.5rem;
    border-bottom: 1px solid var(--border);
    vertical-align: middle;
  }
  thead th {
    position: sticky;
    top: 0;
    background: var(--surface-2);
    font-size: 0.8rem;
  }
  /* A header cell stays a table cell (flex on it takes the row semantics away); the two lines stack as blocks. */
  tbody th {
    font-weight: normal;
  }
  tbody th .title,
  tbody th .id {
    display: block;
  }
  .title {
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .id {
    font-family: var(--mono);
    font-size: 0.75rem;
    color: var(--muted);
  }
  tr.edited {
    background: var(--surface-2);
  }
  select {
    background: var(--surface);
    color: var(--text);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 0.2rem 0.4rem;
  }
  .figures {
    margin: 0.6rem 0;
    min-height: 2.6rem;
  }
  .figures p {
    margin: 0;
  }
  .sum {
    font-weight: 600;
  }
  .figures.pending {
    opacity: 0.55;
  }
  .coverage {
    color: var(--muted);
    font-size: 0.85rem;
  }
  .problem {
    color: var(--warn);
  }
  .actions {
    display: flex;
    justify-content: flex-end;
    gap: 0.5rem;
  }
  button {
    background: var(--surface-2);
    color: var(--text);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 0.35rem 0.8rem;
    cursor: pointer;
  }
  .primary {
    border-color: var(--accent);
  }
  button:disabled {
    opacity: 0.6;
    cursor: default;
  }
</style>
