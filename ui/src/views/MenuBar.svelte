<script lang="ts" module>
  export type MenuItem =
    | { kind: 'action'; label: string; onselect: () => void; disabled?: boolean }
    | { kind: 'radio'; label: string; checked: boolean; onselect: () => void }
    | { kind: 'check'; label: string; checked: boolean; onselect: () => void }
    | { kind: 'info'; label: string }
    | { kind: 'separator' };

  export interface Menu {
    id: string;
    label: string;
    items: MenuItem[];
  }
</script>

<script lang="ts">
  // The menu bar of an application: a row of menus, each a button that opens
  // a list. Keys: Enter, Space or Down open a menu; Up and Down walk the
  // items; Left and Right go to the next menu; Escape closes.

  import { tick } from 'svelte';

  let { menus, label }: { menus: readonly Menu[]; label: string } = $props();

  let openId = $state<string | null>(null);
  let root: HTMLElement | undefined = $state();

  const roleOf = (item: MenuItem): string =>
    item.kind === 'radio' ? 'menuitemradio' : item.kind === 'check' ? 'menuitemcheckbox' : 'menuitem';

  function triggers(): HTMLButtonElement[] {
    return root ? [...root.querySelectorAll<HTMLButtonElement>('button.trigger')] : [];
  }

  function itemButtons(id: string): HTMLButtonElement[] {
    return root
      ? [...root.querySelectorAll<HTMLButtonElement>(`[data-menu="${id}"] button.item:not(:disabled)`)]
      : [];
  }

  async function open(id: string, focusItem: 'first' | 'last' | null): Promise<void> {
    openId = id;
    if (focusItem === null) return;
    await tick();
    const items = itemButtons(id);
    (focusItem === 'first' ? items[0] : items[items.length - 1])?.focus();
  }

  function close(focusTrigger: boolean): void {
    const was = openId;
    openId = null;
    if (focusTrigger && was) triggers().find((t) => t.dataset.for === was)?.focus();
  }

  function pick(item: MenuItem): void {
    if (item.kind === 'separator' || item.kind === 'info') return;
    if (item.kind === 'action' && item.disabled) return;
    close(true);
    item.onselect();
  }

  function onTriggerKey(event: KeyboardEvent, id: string): void {
    const list = triggers();
    const at = list.findIndex((t) => t.dataset.for === id);
    switch (event.key) {
      case 'ArrowDown':
      case 'Enter':
      case ' ':
        event.preventDefault();
        void open(id, 'first');
        break;
      case 'ArrowUp':
        event.preventDefault();
        void open(id, 'last');
        break;
      case 'ArrowRight':
      case 'ArrowLeft': {
        event.preventDefault();
        const step = event.key === 'ArrowRight' ? 1 : -1;
        const next = list[(at + step + list.length) % list.length];
        next?.focus();
        if (openId !== null && next?.dataset.for) void open(next.dataset.for, null);
        break;
      }
      case 'Escape':
        if (openId !== null) {
          event.preventDefault();
          event.stopPropagation();
          close(true);
        }
        break;
    }
  }

  function onItemKey(event: KeyboardEvent, id: string): void {
    const items = itemButtons(id);
    const at = items.indexOf(event.currentTarget as HTMLButtonElement);
    const focus = (i: number) => items[(i + items.length) % items.length]?.focus();
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault();
        focus(at + 1);
        break;
      case 'ArrowUp':
        event.preventDefault();
        focus(at - 1);
        break;
      case 'Home':
        event.preventDefault();
        focus(0);
        break;
      case 'End':
        event.preventDefault();
        focus(items.length - 1);
        break;
      case 'Escape':
        event.preventDefault();
        event.stopPropagation();
        close(true);
        break;
      case 'ArrowRight':
      case 'ArrowLeft': {
        event.preventDefault();
        const list = triggers();
        const here = list.findIndex((t) => t.dataset.for === id);
        const step = event.key === 'ArrowRight' ? 1 : -1;
        const next = list[(here + step + list.length) % list.length];
        if (next?.dataset.for) void open(next.dataset.for, 'first');
        break;
      }
      case 'Tab':
        close(false);
        break;
    }
  }

  function onWindowClick(event: MouseEvent): void {
    if (openId !== null && root && event.target instanceof Node && !root.contains(event.target)) {
      close(false);
    }
  }
</script>

<svelte:window onclick={onWindowClick} />

<div class="menubar" role="menubar" aria-label={label} bind:this={root}>
  {#each menus as menu (menu.id)}
    <div class="menu">
      <button
        type="button"
        class="trigger"
        role="menuitem"
        data-for={menu.id}
        aria-haspopup="menu"
        aria-expanded={openId === menu.id}
        onclick={() => (openId === menu.id ? close(false) : void open(menu.id, null))}
        onkeydown={(e) => onTriggerKey(e, menu.id)}
        onmouseenter={() => {
          if (openId !== null && openId !== menu.id) void open(menu.id, null);
        }}>{menu.label}</button
      >
      {#if openId === menu.id}
        <div class="popup" role="menu" aria-label={menu.label} data-menu={menu.id}>
          {#each menu.items as item, i (i)}
            {#if item.kind === 'separator'}
              <hr />
            {:else if item.kind === 'info'}
              <p class="info" role="none">{item.label}</p>
            {:else}
              <button
                type="button"
                class="item"
                role={roleOf(item)}
                aria-checked={item.kind === 'radio' || item.kind === 'check'
                  ? item.checked
                  : undefined}
                disabled={item.kind === 'action' && item.disabled}
                tabindex="-1"
                onclick={() => pick(item)}
                onkeydown={(e) => onItemKey(e, menu.id)}
              >
                <span class="mark" aria-hidden="true"
                  >{item.kind === 'radio' ? (item.checked ? '●' : '') : item.kind === 'check' ? (item.checked ? '✓' : '') : ''}</span
                >
                <span>{item.label}</span>
              </button>
            {/if}
          {/each}
        </div>
      {/if}
    </div>
  {/each}
</div>

<style>
  .menubar {
    display: flex;
    gap: 0.1rem;
  }
  .menu {
    position: relative;
  }
  .trigger {
    background: none;
    border: 1px solid transparent;
    border-radius: var(--radius);
    padding: 0.25rem 0.6rem;
    cursor: pointer;
    color: var(--text);
  }
  .trigger:hover,
  .trigger[aria-expanded='true'] {
    background: var(--surface-2);
    border-color: var(--border);
  }
  .popup {
    position: absolute;
    z-index: 20;
    top: calc(100% + 0.2rem);
    left: 0;
    min-width: 13rem;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    box-shadow: 0 6px 20px rgb(0 0 0 / 0.25);
    padding: 0.3rem;
  }
  .item {
    display: flex;
    align-items: center;
    gap: 0.5rem;
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
  .item:hover:not(:disabled),
  .item:focus-visible {
    background: var(--surface-2);
  }
  .item:disabled {
    color: var(--muted);
    cursor: default;
  }
  .mark {
    width: 1rem;
    text-align: center;
    color: var(--accent);
  }
  .info {
    margin: 0;
    padding: 0.3rem 0.5rem;
    color: var(--muted);
    font-size: 0.85rem;
  }
  hr {
    border: 0;
    border-top: 1px solid var(--border);
    margin: 0.3rem 0;
  }
</style>
