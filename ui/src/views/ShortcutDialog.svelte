<script lang="ts">
  import { closeOnBackdrop } from 'appkit-ui/backdrop';
  import { floating } from '../lib/floating';
  // A shortcut to the page of the web variant (a file opened from disk): the lines for Windows' "New > Shortcut"
  // (lib/shortcut.ts) and the start script of tasks-web. The two that start a program carry the warning.
  import type { App } from '../lib/app.svelte';
  import { translate, type Key } from '../lib/i18n';
  import { chromeTarget, pageAddress } from '../lib/shortcut';

  let { app, open, onclose }: { app: App; open: boolean; onclose: () => void } = $props();
  const t = (key: Key, params: Record<string, string | number> = {}) => translate(app.lang, key, params);

  let dialog: HTMLDialogElement | undefined = $state();
  // Read when the dialog opens: the address of the page can change (a task after #), the shortcut opens the page.
  const address = $derived(open ? pageAddress(location.href) : '');
  const ways = $derived([
    { id: 'chrome', line: chromeTarget(address), warn: true },
    { id: 'browser', line: address, warn: false },
  ] as const);

  $effect(() => {
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  });

  async function copy(line: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(line);
      app.tell('ok', 'shortcut.copied');
    } catch {
      app.tell('error', 'shortcut.copy_failed');
    }
  }
</script>

<dialog
  bind:this={dialog}
  use:floating={{ kind: 'shortcut', moveLabel: t('float.move'), moveHint: t('hint.float.move') }}
  use:closeOnBackdrop
  aria-labelledby="shortcut-title"
  onclose={() => {
    if (open) onclose();
  }}
>
  <h2 id="shortcut-title">{t('shortcut.title')}</h2>
  <p class="muted">{t('shortcut.intro')}</p>
  {#each ways as way (way.id)}
    <section aria-labelledby="shortcut-{way.id}">
      <h3 id="shortcut-{way.id}">{t(`shortcut.${way.id}.title` as Key)}</h3>
      <p>{t(`shortcut.${way.id}.body` as Key)}</p>
      <div class="line">
        <input type="text" readonly value={way.line} aria-label={t(`shortcut.${way.id}.title` as Key)} />
        <button type="button" onclick={() => void copy(way.line)}>{t('shortcut.copy')}</button>
      </div>
      {#if way.warn}<p class="warn" role="note">{t('shortcut.warning')}</p>{/if}
    </section>
  {/each}
  <section aria-labelledby="shortcut-script">
    <h3 id="shortcut-script">{t('shortcut.script.title')}</h3>
    <p>{t('shortcut.script.body')}</p>
    <p class="warn" role="note">{t('shortcut.warning')}</p>
  </section>
  <div class="actions">
    <button type="button" class="primary" onclick={() => onclose()}>{t('shortcut.close')}</button>
  </div>
</dialog>

<style>
  dialog {
    background: var(--surface);
    color: var(--text);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 1rem 1.25rem;
    width: min(38rem, calc(100vw - 2rem));
  }
  dialog::backdrop {
    background: var(--backdrop);
  }
  h2 {
    margin: 0 0 0.5rem;
    font-size: 1.1rem;
  }
  h3 {
    margin: 0.9rem 0 0.3rem;
    font-size: 0.95rem;
  }
  p {
    margin: 0 0 0.5rem;
  }
  .muted {
    color: var(--muted);
  }
  .warn {
    color: var(--warn);
    font-size: 0.85rem;
  }
  .line {
    display: flex;
    gap: 0.5rem;
    margin: 0 0 0.5rem;
  }
  .line input {
    flex: 1;
    min-width: 0;
    font-family: var(--mono);
    font-size: 0.8rem;
    background: var(--surface-2);
    color: var(--text);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 0.3rem 0.4rem;
  }
  .actions {
    display: flex;
    justify-content: flex-end;
    gap: 0.5rem;
    margin-top: 0.8rem;
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
</style>
