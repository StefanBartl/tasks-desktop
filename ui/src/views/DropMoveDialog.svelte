<script lang="ts">
  // A task dropped on an area: what the engine says the move would do (a dry run, nothing written yet), and the
  // choice to go on or to give up. A taken name in the target is told, and then there is nothing to confirm.
  import type { App } from '../lib/app.svelte';
  import { classChange as classChangeOf } from '../lib/bulk';
  import { translate, type Key } from '../lib/i18n';
  import { markHidden } from '../lib/text';

  let { app }: { app: App } = $props();
  const t = (key: Key, params: Record<string, string | number> = {}) => translate(app.lang, key, params);

  let dialog: HTMLDialogElement | undefined = $state();
  const asking = $derived(app.dropMove);
  const task = $derived(asking ? app.tasks.find((x) => x.id === asking.id) : undefined);
  const answer = $derived(asking?.answer ?? null);
  const classChange = $derived.by(() => {
    if (!asking || !task) return null;
    const of = (name: string) => app.hubAreas.find((a) => a.name === name)?.data_class;
    return classChangeOf(of(task.area), of(asking.toArea));
  });
  const confirmable = $derived(answer?.kind === 'ok' && answer.move.conflicts.length === 0);

  $effect(() => {
    if (!dialog) return;
    if (asking && !dialog.open) dialog.showModal();
    if (!asking && dialog.open) dialog.close();
  });
</script>

<dialog bind:this={dialog} aria-labelledby="drop-move-title" onclose={() => app.cancelDropMove()}>
  {#if asking}
    <h2 id="drop-move-title">{t('drop.title', { area: asking.toArea })}</h2>
    <p class="what">{markHidden(task?.title ?? asking.id)}</p>
    <p class="id"><code>{asking.id}</code></p>
    {#if answer === null}
      <p class="muted" role="status">{t('drop.checking')}</p>
    {:else if answer.kind === 'ok'}
      <p class="muted" role="status">
        {#if answer.move.conflicts.length > 0}
          {#each answer.move.conflicts as c, i (i)}{markHidden(c.message)} {/each}
        {:else}
          {t('move.rewrites', { n: answer.move.references.length })}
        {/if}
        {#if classChange}
          {t('move.class_differs', classChange)}
        {/if}
      </p>
    {:else if answer.kind === 'refused'}
      <p class="bad" role="alert">{markHidden(answer.message)}</p>
    {:else}
      <p class="bad" role="alert">{t('move.unknown')}</p>
    {/if}
    <div class="actions">
      <button type="button" onclick={() => app.cancelDropMove()}>{t('dialog.cancel')}</button>
      <button
        type="button"
        class="primary"
        disabled={app.saving || !confirmable}
        onclick={() => void app.confirmDropMove()}
        >{answer?.kind === 'ok' ? t('move.confirm', { id: answer.move.new_id }) : t('move.check')}</button
      >
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
    width: min(30rem, calc(100vw - 2rem));
  }
  dialog::backdrop {
    background: var(--backdrop);
  }
  h2 {
    margin: 0 0 0.5rem;
    font-size: 1.1rem;
  }
  .what {
    font-weight: 600;
    margin: 0;
  }
  .id {
    margin: 0.1rem 0 0.6rem;
    color: var(--muted);
  }
  .muted {
    color: var(--muted);
  }
  .bad {
    color: var(--bad);
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
