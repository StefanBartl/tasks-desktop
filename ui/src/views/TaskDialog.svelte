<script lang="ts">
  import { tick } from 'svelte';
  import { closeOnBackdrop } from 'appkit-ui/backdrop';
  // A task looked at without leaving the view: the list, the overview and the plan open it here, over themselves. The
  // detail is the one of the other views (the same card, with the same fields). The float can be moved and sized (its
  // head and the handle in it, the grip in its lower right corner; lib/floating.ts), and detached into a window of its
  // own. "Show in the list" puts the list behind it, at the row of the task, from the views that are not the list (as
  // the context menu's entry of that name does). Escape closes, the focus
  // goes back to where it was (the dialog does that).
  import type { App } from '../lib/app.svelte';
  import { floating } from '../lib/floating';
  import { translate, type Key } from '../lib/i18n';
  import Detail from './Detail.svelte';
  import Toast from './Toast.svelte';

  let { app }: { app: App } = $props();
  const t = (key: Key, params: Record<string, string | number> = {}) => translate(app.lang, key, params);

  let dialog: HTMLDialogElement | undefined = $state();

  $effect(() => {
    if (!dialog) return;
    if (app.peeking && app.selectedId !== null && !dialog.open) {
      dialog.showModal();
      // A task opens at its top, with the focus on Close: the handle before it would open its long hint over the task.
      dialog.scrollTop = 0;
      dialog.querySelector<HTMLButtonElement>('button[data-close]')?.focus();
    }
    if ((!app.peeking || app.selectedId === null) && dialog.open) dialog.close();
  });
</script>

<dialog
  bind:this={dialog}
  use:closeOnBackdrop
  use:floating={{ kind: 'task', moveLabel: t('float.move'), moveHint: t('hint.float.move'), handle: false }}
  class="peek"
  aria-label={t('peek.label')}
  onclose={() => {
    // The event comes a moment after the close: a float the page opened again meanwhile (a task that moved to another
    // area comes back under its new id) stays open.
    if (!dialog?.open) app.closePeek();
  }}
>
  {#if app.peeking && app.selectedId !== null}
    <div class="bar" data-float-handle>
      <button type="button" class="move" data-float-move aria-label={t('float.move')} data-hint={t('hint.float.move')}
        ><span aria-hidden="true">✥</span></button
      >
      <span class="spacer"></span>
      <!-- The float is modal: the button of the refused changes in the bar of the page cannot be reached from here. -->
      {#if app.conflicts.length > 0}
        <button type="button" class="conflicts" onclick={() => app.openConflicts()}
          >{t('conflicts.button', { n: app.conflicts.length })}</button
        >
      {/if}
      {#if app.view !== 'list'}
        <!-- As the entry of the context menu of the same name: the list behind, at the row of the task, and the task in
             this float over it. The button is gone then (the list is behind): the focus goes on to Close. -->
        <button
          type="button"
          onclick={() => {
            app.reveal(app.selectedId as string);
            void tick().then(() => dialog?.querySelector<HTMLButtonElement>('button[data-close]')?.focus());
          }}>{t('peek.in_list')}</button
        >
      {/if}
      {#if app.canDetach}
        <button
          type="button"
          class="detach"
          aria-label={t('peek.detach')}
          data-hint={t('hint.ui.peek.detach')}
          onclick={() => app.detach(app.selectedId as string)}><span aria-hidden="true">⧉</span></button
        >
      {/if}
      <button type="button" data-close onclick={() => dialog?.close()}>{t('peek.close')}</button>
    </div>
    <Detail {app} />
    <!-- The float is modal: the toast of a change made in it, with its Undo, stands inside it (App draws it otherwise). -->
    {#if app.taskFloatOpen}<Toast {app} />{/if}
  {/if}
</dialog>

<style>
  dialog {
    background: var(--surface);
    color: var(--text);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 0 1rem 1rem;
    width: min(52rem, calc(100vw - 2rem));
    max-height: calc(100vh - 3rem);
    overflow: auto;
  }
  dialog::backdrop {
    background: var(--backdrop);
  }
  /* The head of the float: it is what a drag takes, and it stays at the top while the task scrolls under it. */
  .bar {
    position: sticky;
    top: 0;
    z-index: 1;
    display: flex;
    align-items: center;
    gap: 0.5rem;
    margin: 0 -1rem 0.5rem;
    padding: 0.5rem 1rem;
    background: var(--surface);
    border-bottom: 1px solid var(--border);
  }
  .spacer {
    flex: 1;
  }
  /* The buttons are drawn like those of the other dialogs: without a background of their own the browser's grey
     stood behind the light text in the dark theme (contrast 4.38, axe wants 4.5). */
  .bar button {
    background: var(--surface-2);
    color: var(--text);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 0.3rem 0.7rem;
    font-size: 0.9rem;
    cursor: pointer;
  }
  .bar .move {
    cursor: move;
    touch-action: none;
    padding: 0.3rem 0.5rem;
  }
  .bar .conflicts {
    color: var(--bad);
    border-color: var(--bad);
  }
  .bar .detach {
    padding: 0.3rem 0.55rem;
  }
  /* The card is the one of the other views; here it is not a column beside a list but the content of the float. */
  /* It does not scroll by itself either: the float does, and the button that finishes the task sticks to the float's
     lower edge. */
  dialog :global(aside.detail) {
    overflow: visible;
    max-height: none;
    border: 0;
    padding: 0;
    background: transparent;
  }
</style>
