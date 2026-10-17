<script lang="ts">
  // What a write did, in one line, and the way back when there is one.
  import type { App } from '../lib/app.svelte';
  import { translate, type Key } from '../lib/i18n';

  let { app }: { app: App } = $props();
  const t = (key: Key, params: Record<string, string | number> = {}) =>
    translate(app.lang, key, params);
  const toast = $derived(app.toast);
</script>

{#snippet body(shown: NonNullable<typeof toast>)}
  <div class="toast" class:error={shown.kind === 'error'}>
    <span>{shown.text}</span>
    {#if shown.undo}
      <button type="button" disabled={app.answering} onclick={() => void app.undo()}>{t('write.undo')}</button>
    {/if}
    <button type="button" class="close" aria-label={t('write.dismiss')} onclick={() => app.dismissToast()}
      >×</button
    >
  </div>
{/snippet}

<!-- Two live regions that stand from the start and never nest: a refusal is an alert (it interrupts), a "Saved."
     waits its turn in the status region. A live region inside another is read twice, or at the wrong time. -->
<div class="toasts">
  <div role="status" aria-live="polite">
    {#if toast && toast.kind !== 'error'}{@render body(toast)}{/if}
  </div>
  <div role="alert">
    {#if toast && toast.kind === 'error'}{@render body(toast)}{/if}
  </div>
</div>

<style>
  .toasts {
    position: fixed;
    left: 1rem;
    bottom: 1rem;
    z-index: 30;
    max-width: min(34rem, calc(100vw - 2rem));
  }
  .toast {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    background: var(--surface);
    border: 1px solid var(--border);
    border-left: 4px solid var(--ok);
    border-radius: var(--radius);
    box-shadow: var(--shadow);
    padding: 0.5rem 0.75rem;
  }
  .toast.error {
    border-left-color: var(--bad);
  }
  button {
    background: none;
    border: 1px solid var(--border);
    border-radius: var(--radius);
    color: var(--text);
    cursor: pointer;
    padding: 0.15rem 0.6rem;
  }
  .close {
    border: 0;
    color: var(--muted);
    font-size: 1.1rem;
    line-height: 1;
  }
</style>
