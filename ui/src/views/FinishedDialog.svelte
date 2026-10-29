<script lang="ts">
  import { closeOnBackdrop } from 'appkit-ui/backdrop';
  // A finished task looked at from the list under the open ones: the facts the Backlog list holds about it, read only.
  // The engine reads open tasks only, so the text of a finished task is not here.
  import type { App } from '../lib/app.svelte';
  import { labelOf, translate, type Key } from '../lib/i18n';
  import { markHidden } from '../lib/text';

  let { app }: { app: App } = $props();
  const t = (key: Key, params: Record<string, string | number> = {}) => translate(app.lang, key, params);

  let dialog: HTMLDialogElement | undefined = $state();
  const item = $derived(app.finishedPeek);

  $effect(() => {
    if (!dialog) return;
    if (item !== null && !dialog.open) {
      dialog.showModal();
      dialog.querySelector<HTMLButtonElement>('button[data-close]')?.focus();
    }
    if (item === null && dialog.open) dialog.close();
  });
</script>

<dialog
  bind:this={dialog}
  use:closeOnBackdrop
  class="finished-peek"
  aria-label={t('done.read.label')}
  onclose={() => (app.finishedPeek = null)}
>
  {#if item}
    <div class="bar">
      <h2>{markHidden(item.title)}</h2>
      <button type="button" data-close onclick={() => dialog?.close()}>{t('peek.close')}</button>
    </div>
    <p class="note">{t('done.read.note')}</p>
    <dl>
      <dt>{t('done.read.id')}</dt>
      <dd class="id">{item.id}</dd>
      <dt>{t('done.read.when')}</dt>
      <dd>{item.done ?? t('done.undated_row')}</dd>
      {#if item.kind}<dt>{t('field.kind')}</dt><dd>{labelOf(app.lang, 'kind', item.kind)}</dd>{/if}
      {#if item.prio !== undefined}<dt>{t('field.prio')}</dt><dd>P{item.prio}</dd>{/if}
      {#if item.effort}<dt>{t('field.effort')}</dt><dd>{item.effort}</dd>{/if}
      {#if item.value !== undefined}<dt>{t('field.value')}</dt><dd>{item.value}</dd>{/if}
      {#if item.tags.length > 0}<dt>{t('field.tags')}</dt><dd>{item.tags.map(markHidden).join(', ')}</dd>{/if}
      {#if item.plan}<dt>{t('field.plan')}</dt><dd>{markHidden(item.plan)}{item.phase ? ` · ${markHidden(item.phase)}` : ''}</dd>{/if}
      {#if item.done_in}<dt>{t('done.read.done_in')}</dt><dd>{markHidden(item.done_in)}</dd>{/if}
      {#if item.commits && item.commits.length > 0}
        <dt>{t('done.read.commits')}</dt>
        <dd class="id">{item.commits.map(markHidden).join(', ')}</dd>
      {/if}
    </dl>
  {/if}
</dialog>

<style>
  dialog {
    background: var(--surface);
    color: var(--text);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 0 1rem 1rem;
    width: min(36rem, calc(100vw - 2rem));
    max-height: calc(100vh - 3rem);
    overflow: auto;
  }
  dialog::backdrop {
    background: var(--backdrop);
  }
  .bar {
    position: sticky;
    top: 0;
    display: flex;
    align-items: center;
    gap: 0.75rem;
    margin: 0 -1rem 0.5rem;
    padding: 0.5rem 1rem;
    background: var(--surface);
    border-bottom: 1px solid var(--border);
  }
  h2 {
    flex: 1;
    margin: 0;
    font-size: 1.05rem;
    overflow-wrap: anywhere;
  }
  .bar button {
    background: var(--surface-2);
    color: var(--text);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 0.3rem 0.7rem;
    cursor: pointer;
  }
  .note {
    color: var(--muted);
    font-size: 0.85rem;
    margin: 0 0 0.5rem;
  }
  dl {
    display: grid;
    grid-template-columns: max-content 1fr;
    gap: 0.3rem 1rem;
    margin: 0;
  }
  dt {
    color: var(--muted);
  }
  dd {
    margin: 0;
    overflow-wrap: anywhere;
  }
  .id {
    font-family: var(--mono);
    font-size: 0.9rem;
  }
</style>
