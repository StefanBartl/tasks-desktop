<script lang="ts">
  // A task looked at without leaving the view: the overview and the plan open it here, over themselves, instead of
  // jumping to the list. The detail is the one of the list (the same card, with the same fields); "Show in the list"
  // goes where the other views used to go. Escape closes, the focus goes back to where it was (the dialog does that).
  import type { App } from '../lib/app.svelte';
  import { translate, type Key } from '../lib/i18n';
  import Detail from './Detail.svelte';

  let { app }: { app: App } = $props();
  const t = (key: Key, params: Record<string, string | number> = {}) => translate(app.lang, key, params);

  let dialog: HTMLDialogElement | undefined = $state();

  $effect(() => {
    if (!dialog) return;
    if (app.peeking && app.selectedId !== null && !dialog.open) dialog.showModal();
    if ((!app.peeking || app.selectedId === null) && dialog.open) dialog.close();
  });
</script>

<dialog bind:this={dialog} class="peek" aria-label={t('peek.label')} onclose={() => app.closePeek()}>
  {#if app.peeking && app.selectedId !== null}
    <div class="bar">
      <button type="button" onclick={() => app.reveal(app.selectedId as string)}>{t('peek.in_list')}</button>
      <button type="button" onclick={() => dialog?.close()}>{t('peek.close')}</button>
    </div>
    <Detail {app} />
  {/if}
</dialog>

<style>
  dialog {
    background: var(--surface);
    color: var(--text);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 0.75rem 1rem 1rem;
    width: min(52rem, calc(100vw - 2rem));
    max-height: calc(100vh - 3rem);
    overflow: auto;
  }
  dialog::backdrop {
    background: var(--backdrop);
  }
  .bar {
    display: flex;
    justify-content: flex-end;
    gap: 0.5rem;
    margin-bottom: 0.5rem;
  }
  /* The card is the one of the list; here it is not a column beside a list but the content of the dialog. */
  dialog :global(aside.detail) {
    max-height: none;
    border: 0;
    padding: 0;
    background: transparent;
  }
</style>
