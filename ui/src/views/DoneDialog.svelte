<script lang="ts">
  import { closeOnBackdrop } from 'appkit-ui/backdrop';
  // Finishing a task takes two steps on purpose: this shows what it would do
  // (the engine's preview) and asks.
  import type { App } from '../lib/app.svelte';
  import { translate, type Key } from '../lib/i18n';
  import { markHidden } from '../lib/text';

  let { app }: { app: App } = $props();
  const t = (key: Key, params: Record<string, string | number> = {}) =>
    translate(app.lang, key, params);

  let dialog: HTMLDialogElement | undefined = $state();
  let busy = $state(false);
  let remind = $state('');
  const finishing = $derived(app.finishing);
  const title = $derived(
    finishing ? (app.tasks.find((x) => x.id === finishing.id)?.title ?? finishing.id) : '',
  );

  $effect(() => {
    if (!dialog) return;
    if (finishing && !dialog.open) {
      remind = '';
      dialog.showModal();
    }
    if (!finishing && dialog.open) dialog.close();
  });

  async function confirm(): Promise<void> {
    if (busy) return;
    busy = true;
    try {
      await app.confirmFinish(remind === '' ? undefined : remind);
    } finally {
      busy = false;
    }
  }
</script>

<dialog bind:this={dialog} use:closeOnBackdrop aria-labelledby="done-title" onclose={() => app.cancelFinish()}>
  {#if finishing}
    <h2 id="done-title">{t('done.title')}</h2>
    <p class="what">{markHidden(title)}</p>
    <p class="id"><code>{finishing.id}</code></p>
    <ul>
      <li>{t('done.moves', { to: finishing.preview.to })}</li>
      {#if (finishing.preview.steps_ticked ?? 0) > 0}
        <li>{t('done.steps', { n: finishing.preview.steps_ticked ?? 0 })}</li>
      {/if}
      {#if finishing.preview.closes_plan}
        <li>{t('done.closes_plan', { plan: finishing.preview.closes_plan })}</li>
      {/if}
      {#if (finishing.preview.freed?.length ?? 0) > 0}
        <li>
          {t('done.freed', { n: finishing.preview.freed?.length ?? 0 })}:
          {#each finishing.preview.freed ?? [] as id, i (id)}{i > 0 ? ', ' : ''}<code>{id}</code
            >{/each}
        </li>
      {/if}
    </ul>
    <label class="remind">
      <span>{t('remind.after_finish')}</span>
      <select bind:value={remind}>
        <option value="">{t('remind.none')}</option>
        <option value="+0d">{t('remind.today')}</option>
        <option value="+3d">{t('remind.in', { n: 3 })}</option>
        <option value="+7d">{t('remind.in', { n: 7 })}</option>
        <option value="+14d">{t('remind.in', { n: 14 })}</option>
        <option value="+30d">{t('remind.in', { n: 30 })}</option>
      </select>
    </label>
    <div class="actions">
      <button type="button" onclick={() => app.cancelFinish()}>{t('dialog.cancel')}</button>
      <button type="button" class="primary" disabled={busy} onclick={confirm}
        >{t('done.confirm')}</button
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
  ul {
    margin: 0 0 1rem;
    padding-left: 1.2rem;
  }
  .remind {
    display: grid;
    gap: 0.2rem;
    margin-bottom: 0.9rem;
  }
  .remind select {
    background: var(--surface-2);
    color: var(--text);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 0.3rem 0.5rem;
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
