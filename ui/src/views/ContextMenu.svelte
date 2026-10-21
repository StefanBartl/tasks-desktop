<script lang="ts">
  // The context menu of the page (a right click, the menu key or Shift+F10 on an element that has one): a menu of its
  // own at the pointer or under the element, with the keys of a menu - the arrows, Home and End, a letter to jump,
  // Enter to choose, Escape to close with the focus back where it was. Tab and a click elsewhere close it too. The
  // entries are the kit's model (`appkit-ui/menu`): sections and actions; what an entry does is the caller's.
  import { tick } from 'svelte';
  import { toBlocks, typeAheadIndex, TYPE_AHEAD_MS, type MenuItem } from 'appkit-ui/menu';
  import type { App } from '../lib/app.svelte';

  let { app }: { app: App } = $props();

  const menu = $derived(app.contextMenu);
  const uid = `cm-${Math.random().toString(36).slice(2, 8)}`;
  let box = $state<HTMLDivElement | null>(null);
  let left = $state(0);
  let top = $state(0);
  let typed = '';
  let typedAt = 0;

  const items = (): HTMLButtonElement[] => (box ? [...box.querySelectorAll<HTMLButtonElement>('button[role="menuitem"]:not(:disabled)')] : []);

  // Opened: placed inside the window and the first entry takes the focus.
  $effect(() => {
    const open = menu;
    if (!open) return;
    left = open.x;
    top = open.y;
    void tick().then(() => {
      if (!box || app.contextMenu !== open) return;
      const rect = box.getBoundingClientRect();
      left = Math.max(4, Math.min(open.x, window.innerWidth - rect.width - 4));
      top = Math.max(4, Math.min(open.y, window.innerHeight - rect.height - 4));
      items()[0]?.focus();
    });
  });

  function close(restore: boolean): void {
    const origin = menu?.origin ?? null;
    app.closeContextMenu();
    if (restore && origin?.isConnected) origin.focus();
  }

  function choose(item: MenuItem): void {
    if (item.kind !== 'action' || item.disabled) return;
    close(false);
    item.onselect();
  }

  function onKey(event: KeyboardEvent): void {
    const list = items();
    const at = list.indexOf(document.activeElement as HTMLButtonElement);
    const go = (i: number) => list[(i + list.length) % list.length]?.focus();
    if (event.key === 'ArrowDown') go(at + 1);
    else if (event.key === 'ArrowUp') go(at < 0 ? list.length - 1 : at - 1);
    else if (event.key === 'Home') go(0);
    else if (event.key === 'End') go(list.length - 1);
    else if (event.key === 'Escape') close(true);
    else if (event.key === 'Tab') close(true);
    else if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey && event.key !== ' ') {
      const now = Date.now();
      typed = now - typedAt < TYPE_AHEAD_MS ? typed + event.key : event.key;
      typedAt = now;
      const i = typeAheadIndex(list.map((b) => b.textContent?.trim() ?? ''), at, typed);
      if (i >= 0) go(i);
    } else return;
    event.preventDefault();
    event.stopPropagation();
  }

  function onWindowPointer(event: PointerEvent): void {
    if (menu && box && !box.contains(event.target as Node)) close(false);
  }
</script>

<svelte:window onpointerdown={onWindowPointer} onresize={() => menu && close(false)} />

{#if menu}
  <!-- The keys of the menu are handled on the menu (the entries are its buttons). -->
  <!-- svelte-ignore a11y_interactive_supports_focus -->
  <div
    bind:this={box}
    class="cm"
    role="menu"
    aria-label={menu.label}
    style:left="{left}px"
    style:top="{top}px"
    onkeydown={onKey}
  >
    {#each toBlocks(menu.items) as block, b (b)}
      {#if block.kind === 'divider'}
        <hr />
      {:else if block.heading !== null}
        <div role="group" aria-labelledby="{uid}-{b}">
          <p class="section" id="{uid}-{b}" role="presentation">{block.heading}</p>
          {#each block.items as item, i (i)}
            {#if item.kind === 'action'}
              <button type="button" role="menuitem" tabindex="-1" class="item" disabled={item.disabled} onclick={() => choose(item)}>{item.label}</button>
            {/if}
          {/each}
        </div>
      {:else}
        {#each block.items as item, i (i)}
          {#if item.kind === 'action'}
            <button type="button" role="menuitem" tabindex="-1" class="item" disabled={item.disabled} onclick={() => choose(item)}>{item.label}</button>
          {/if}
        {/each}
      {/if}
    {/each}
  </div>
{/if}

<style>
  .cm {
    position: fixed;
    z-index: 40;
    min-width: 13rem;
    max-width: calc(100vw - 1rem);
    max-height: calc(100vh - 1rem);
    overflow-y: auto;
    background: var(--surface);
    border: 1px solid var(--line);
    border-radius: var(--radius);
    box-shadow: var(--shadow);
    padding: 0.3rem;
  }
  .item {
    display: block;
    width: 100%;
    text-align: left;
    background: none;
    border: 0;
    border-radius: var(--radius);
    padding: 0.3rem 0.5rem;
    color: var(--text);
    cursor: pointer;
    white-space: nowrap;
  }
  /* As in the menu bar: the entry under the pointer or the key is filled with the accent. */
  .item:hover:not(:disabled),
  .item:focus-visible,
  .item:focus {
    background: var(--accent);
    color: var(--accent-text);
    outline: 2px solid transparent;
    outline-offset: -2px;
  }
  .item:disabled {
    color: var(--muted);
    cursor: default;
  }
  .section {
    margin: 0;
    padding: 0.35rem 0.5rem 0.15rem;
    color: var(--muted);
    font-size: 0.75rem;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }
  hr {
    border: 0;
    border-top: 1px solid var(--line);
    margin: 0.3rem 0;
  }
</style>
