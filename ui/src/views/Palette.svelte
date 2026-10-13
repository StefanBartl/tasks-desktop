<script lang="ts">
  // The command palette (Ctrl+K): one box, the actions of the page and the tasks in one list. The arrow keys
  // choose, Enter runs, Escape closes. A choice is remembered and comes first next time.
  import type { App } from '../lib/app.svelte';
  import { translate, type Key } from '../lib/i18n';
  import { paletteItems, stepIndex, type PaletteItem } from '../lib/palette';
  import { paletteActions } from '../lib/paletteActions';
  import { markHidden } from '../lib/text';

  let { app }: { app: App } = $props();
  const t = (key: Key, params: Record<string, string | number> = {}) =>
    translate(app.lang, key, params);

  let dialog: HTMLDialogElement | undefined = $state();
  let input: HTMLInputElement | undefined = $state();
  let query = $state('');
  let at = $state(0);

  const open = $derived(app.palette);
  // The actions are worked out when the palette opens and while it is open (the selection may change under it).
  const actions = $derived(open ? paletteActions(app) : []);
  const items = $derived(
    open ? paletteItems(query, actions, app.tasks, app.frecency, Date.now()) : [],
  );
  // The choice stays inside the list when the words narrow it.
  $effect(() => {
    if (at >= items.length) at = Math.max(0, items.length - 1);
  });

  $effect(() => {
    if (!dialog) return;
    if (open && !dialog.open) {
      query = '';
      at = 0;
      dialog.showModal();
      input?.focus();
    }
    if (!open && dialog.open) dialog.close();
  });

  async function run(item: PaletteItem | undefined): Promise<void> {
    if (!item) return;
    app.chose(item.key, item.kind === 'task' ? item.id : undefined);
    // Closed first: what an action opens (a dialog) must not stand under this one.
    app.closePalette();
    if (item.kind === 'action') await item.action.run();
    else app.reveal(item.id);
  }

  function onKey(event: KeyboardEvent): void {
    if (event.isComposing) return;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      at = stepIndex(at, event.key === 'ArrowDown' ? 1 : -1, items.length);
      document.getElementById(`palette-option-${at}`)?.scrollIntoView({ block: 'nearest' });
    } else if (event.key === 'Enter') {
      event.preventDefault();
      void run(items[at]);
    }
  }
</script>

<!--
  `close` comes a moment after the dialog is shut: a palette opened again at once (Ctrl+K right after Escape) must
  not be closed by the event of the one before, so only a dialog that is shut now counts.
-->
<dialog
  bind:this={dialog}
  aria-label={t('palette.title')}
  oncancel={() => app.closePalette()}
  onclose={() => {
    if (!dialog?.open) app.closePalette();
  }}
>
  <input
    bind:this={input}
    type="text"
    role="combobox"
    aria-label={t('palette.label')}
    aria-expanded="true"
    aria-controls="palette-list"
    aria-activedescendant={items.length > 0 ? `palette-option-${at}` : undefined}
    aria-autocomplete="list"
    autocomplete="off"
    spellcheck="false"
    placeholder={t('palette.placeholder')}
    bind:value={query}
    oninput={() => (at = 0)}
    onkeydown={onKey}
  />
  <ul id="palette-list" role="listbox" aria-label={t('palette.title')}>
    {#each items as item, i (item.key)}
      <li
        id={`palette-option-${i}`}
        role="option"
        aria-selected={i === at}
        class:chosen={i === at}
        onmousemove={() => (at = i)}
        onclick={() => void run(item)}
        onkeydown={null}
      >
        <span class="kind">{item.kind === 'task' ? t('palette.task') : t('palette.action')}</span>
        <span class="label">{markHidden(item.label)}</span>
        {#if item.hint}<span class="hint">{markHidden(item.hint)}</span>{/if}
      </li>
    {:else}
      <li class="none" role="presentation">{t('palette.none')}</li>
    {/each}
  </ul>
</dialog>

<style>
  dialog {
    background: var(--surface);
    color: var(--text);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 0.5rem;
    width: min(38rem, calc(100vw - 2rem));
    margin-top: 12vh;
  }
  dialog::backdrop {
    background: rgb(0 0 0 / 0.45);
  }
  input {
    width: 100%;
    box-sizing: border-box;
    background: var(--surface-2);
    color: var(--text);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 0.5rem 0.6rem;
    font: inherit;
  }
  ul {
    list-style: none;
    margin: 0.4rem 0 0;
    padding: 0;
    max-height: 50vh;
    overflow: auto;
  }
  li {
    display: grid;
    grid-template-columns: 4.5rem minmax(0, 1fr) auto;
    gap: 0.5rem;
    align-items: baseline;
    padding: 0.35rem 0.5rem;
    border-radius: var(--radius);
    cursor: pointer;
  }
  li.chosen {
    background: var(--surface-2);
    outline: 1px solid var(--accent);
  }
  .kind {
    color: var(--muted);
    font-size: 0.7rem;
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }
  .label {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .hint {
    color: var(--muted);
    font-size: 0.8rem;
  }
  .none {
    color: var(--muted);
    cursor: default;
    display: block;
  }
</style>
