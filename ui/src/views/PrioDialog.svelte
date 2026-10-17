<script lang="ts">
  // A card dropped among cards of another priority: the order has no meaning across that border, so the
  // person is asked whether the priority changes with the move.
  import type { App } from '../lib/app.svelte';
  import { translate, type Key } from '../lib/i18n';
  import { markHidden } from '../lib/text';

  let { app }: { app: App } = $props();
  const t = (key: Key, params: Record<string, string | number> = {}) =>
    translate(app.lang, key, params);

  let dialog: HTMLDialogElement | undefined = $state();
  const asking = $derived(app.repriority);
  const card = $derived(asking ? app.tasks.find((x) => x.id === asking.id) : undefined);

  $effect(() => {
    if (!dialog) return;
    if (asking && !dialog.open) dialog.showModal();
    if (!asking && dialog.open) dialog.close();
  });
</script>

<dialog bind:this={dialog} aria-labelledby="prio-title" onclose={() => app.cancelRepriority()}>
  {#if asking}
    <h2 id="prio-title">{t('board.prio.title', { prio: asking.prio })}</h2>
    <p class="what">{markHidden(card?.title ?? asking.id)}</p>
    <p class="id"><code>{asking.id}</code></p>
    <p>{t('board.prio.body', { from: asking.from, prio: asking.prio })}</p>
    <div class="actions">
      <button type="button" onclick={() => app.cancelRepriority()}>{t('dialog.cancel')}</button>
      <button
        type="button"
        class="primary"
        disabled={app.saving}
        onclick={() => void app.confirmRepriority()}>{t('board.prio.confirm', { prio: asking.prio })}</button
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
