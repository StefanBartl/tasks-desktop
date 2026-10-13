<script lang="ts">
  // The conflict center: every change the engine refused because the file had moved on, in one list. For each, what
  // was wanted beside what is there now; "try again" writes it on the version that is there, "let go" drops it.
  import type { App } from '../lib/app.svelte';
  import { alreadyDone, differences, retryOp } from '../lib/conflicts';
  import { labelOf, translate, type Key } from '../lib/i18n';
  import { markHidden } from '../lib/text';

  let { app }: { app: App } = $props();
  const t = (key: Key, params: Record<string, string | number> = {}) =>
    translate(app.lang, key, params);

  let dialog: HTMLDialogElement | undefined = $state();
  const open = $derived(app.conflictsOpen);

  $effect(() => {
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  });

  const rows = $derived(
    app.conflicts.map((conflict) => {
      const task = app.tasks.find((x) => x.id === conflict.id);
      return {
        conflict,
        task,
        diff: differences(conflict, task),
        same: alreadyDone(conflict, task),
        canRetry: retryOp(conflict, task) !== null,
      };
    }),
  );

  /** A key of the frontmatter as the person knows it; a key this version does not know is shown as it is. */
  function keyLabel(key: string): string {
    const known: Record<string, Key> = {
      status: 'field.status',
      prio: 'field.prio',
      actor: 'field.actor',
      effort: 'field.effort',
      tags: 'field.tags',
      remind: 'remind.field',
    };
    const hit = known[key];
    return hit ? t(hit) : key;
  }

  function valueLabel(key: string, value: string): string {
    return key === 'status' || key === 'actor' ? labelOf(app.lang, key, value) : value;
  }
</script>

<dialog
  bind:this={dialog}
  aria-labelledby="conflicts-title"
  oncancel={() => app.closeConflicts()}
  onclose={() => {
    if (!dialog?.open) app.closeConflicts();
  }}
>
  <h2 id="conflicts-title">{t('conflicts.title')} ({app.conflicts.length})</h2>
  <p class="intro">{t('conflicts.intro')}</p>
  <ul>
    {#each rows as row (row.conflict.key)}
      <li>
        <p class="what">{markHidden(row.task?.title ?? row.conflict.id)}</p>
        <p class="id"><code>{row.conflict.id}</code></p>
        {#if row.conflict.code === 'not_found' || !row.task}
          <p class="note">{t('conflicts.gone')}</p>
        {:else if row.conflict.code === 'locked' || row.conflict.code === 'lock_stuck'}
          <p class="note">{t('conflicts.locked')}</p>
        {/if}
        {#if row.conflict.op.op === 'reorder'}
          <p class="note">{t('conflicts.order')}</p>
        {:else if row.same}
          <p class="note">{t('conflicts.done_already')}</p>
        {:else}
          <table>
            <thead>
              <tr>
                <th scope="col"><span class="sr-only">{t('conflicts.field')}</span></th>
                <th scope="col">{t('conflicts.wanted')}</th>
                <th scope="col">{t('conflicts.now')}</th>
              </tr>
            </thead>
            <tbody>
              {#each row.diff as d (d.key)}
                <tr>
                  <th scope="row">{keyLabel(d.key)}</th>
                  <td>{markHidden(valueLabel(d.key, d.wanted))}</td>
                  <td class:same={d.wanted === d.now}>{markHidden(valueLabel(d.key, d.now))}</td>
                </tr>
              {/each}
            </tbody>
          </table>
        {/if}
        <div class="actions">
          {#if row.canRetry && !row.same}
            <button
              type="button"
              class="primary"
              disabled={app.saving}
              onclick={() => void app.retryConflict(row.conflict.key)}>{t('conflicts.retry')}</button
            >
          {/if}
          <button type="button" onclick={() => app.discardConflict(row.conflict.key)}
            >{t('conflicts.discard')}</button
          >
        </div>
      </li>
    {/each}
  </ul>
  <div class="actions foot">
    <button type="button" onclick={() => app.discardAllConflicts()}>{t('conflicts.discard_all')}</button>
    <button type="button" onclick={() => app.closeConflicts()}>{t('conflicts.close')}</button>
  </div>
</dialog>

<style>
  dialog {
    background: var(--surface);
    color: var(--text);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 1rem 1.25rem;
    width: min(40rem, calc(100vw - 2rem));
    max-height: 80vh;
    overflow: auto;
  }
  dialog::backdrop {
    background: rgb(0 0 0 / 0.45);
  }
  h2 {
    margin: 0 0 0.4rem;
    font-size: 1.1rem;
  }
  .intro {
    color: var(--muted);
    font-size: 0.85rem;
    margin: 0 0 0.8rem;
  }
  ul {
    list-style: none;
    margin: 0;
    padding: 0;
    display: grid;
    gap: 0.7rem;
  }
  li {
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 0.6rem 0.8rem;
  }
  .what {
    font-weight: 600;
    margin: 0;
  }
  .id {
    margin: 0.1rem 0 0.4rem;
    color: var(--muted);
  }
  .note {
    margin: 0.3rem 0;
    color: var(--muted);
  }
  table {
    border-collapse: collapse;
    width: 100%;
    font-size: 0.85rem;
  }
  th,
  td {
    text-align: left;
    padding: 0.15rem 0.5rem 0.15rem 0;
  }
  thead th {
    color: var(--muted);
    font-weight: normal;
  }
  .same {
    color: var(--muted);
  }
  .actions {
    display: flex;
    justify-content: flex-end;
    gap: 0.5rem;
    margin-top: 0.5rem;
  }
  .foot {
    margin-top: 0.9rem;
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
