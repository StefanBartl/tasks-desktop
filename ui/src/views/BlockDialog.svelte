<script lang="ts">
  import { closeOnBackdrop } from 'appkit-ui/backdrop';
  import { floating } from '../lib/floating';
  // A card that goes to the blocked column: say what blocks it (a task of the vault), or go on without. Without a
  // blocker the engine warns (`blocked-without-blocker`), so the person is asked once.
  import type { App } from '../lib/app.svelte';
  import { translate, type Key } from '../lib/i18n';
  import { markHidden } from '../lib/text';

  let { app }: { app: App } = $props();
  const t = (key: Key, params: Record<string, string | number> = {}) =>
    translate(app.lang, key, params);

  let dialog: HTMLDialogElement | undefined = $state();
  let text = $state('');
  let wrong = $state<string[]>([]);
  const asking = $derived(app.blocking);
  const card = $derived(asking ? app.tasks.find((x) => x.id === asking.id) : undefined);
  // The suggestions are the tasks of the same area, one box of them: a vault has thousands.
  const choices = $derived(
    asking
      ? app.tasks
          .filter((x) => x.id !== asking.id && x.area === card?.area)
          .slice(0, 300)
          .map((x) => x.id)
      : [],
  );

  $effect(() => {
    if (!dialog) return;
    if (asking && !dialog.open) {
      text = '';
      wrong = [];
      dialog.showModal();
    }
    if (!asking && dialog.open) dialog.close();
  });

  function ids(): string[] {
    return text
      .split(/[\s,]+/)
      .map((s) => s.trim())
      .filter((s) => s !== '');
  }

  async function confirm(withBlockers: boolean): Promise<void> {
    if (app.saving) return;
    const list = withBlockers ? ids() : [];
    wrong = app.unknownBlockers(list);
    if (wrong.length > 0) return;
    await app.confirmBlock(list);
  }
</script>

<dialog bind:this={dialog} use:floating={{ kind: 'block', moveLabel: t('float.move'), moveHint: t('hint.float.move') }} use:closeOnBackdrop aria-labelledby="block-title" onclose={() => app.cancelBlock()}>
  {#if asking}
    <h2 id="block-title">{t('board.block.title')}</h2>
    <p class="what">{markHidden(card?.title ?? asking.id)}</p>
    <p class="id"><code>{asking.id}</code></p>
    <form
      onsubmit={(e) => {
        e.preventDefault();
        void confirm(true);
      }}
    >
      <label>
        <span>{t('board.block.by')}</span>
        <input type="text" list="block-choices" bind:value={text} autocomplete="off" />
        <datalist id="block-choices">
          {#each choices as id (id)}<option value={id}></option>{/each}
        </datalist>
      </label>
      {#if wrong.length > 0}
        <p class="bad" role="alert">{t('board.block.unknown', { ids: wrong.join(', ') })}</p>
      {/if}
      <div class="actions">
        <button type="button" onclick={() => app.cancelBlock()}>{t('dialog.cancel')}</button>
        <button type="button" disabled={app.saving} onclick={() => void confirm(false)}
          >{t('board.block.without')}</button
        >
        <button type="submit" class="primary" disabled={app.saving || ids().length === 0}
          >{t('board.block.confirm')}</button
        >
      </div>
    </form>
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
  label {
    display: grid;
    gap: 0.2rem;
    margin-bottom: 0.9rem;
  }
  input {
    background: var(--surface-2);
    color: var(--text);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 0.3rem 0.5rem;
  }
  .bad {
    color: var(--bad);
    margin: 0 0 0.9rem;
  }
  .actions {
    display: flex;
    justify-content: flex-end;
    gap: 0.5rem;
    flex-wrap: wrap;
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
