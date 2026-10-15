<script lang="ts">
  // A choice of any number of values. The name of the choice is the label of
  // the button, never one of the options.

  export interface Option {
    value: string;
    label: string;
    /** More words for the option (a hint, or the real name behind a label). */
    title?: string;
    /** Shown after the label, in brackets; not searched (a count would make the search find digits). */
    suffix?: string;
  }

  let {
    label,
    options,
    selected,
    onchange,
    resetLabel,
    searchLabel,
  }: {
    label: string;
    options: readonly Option[];
    selected: readonly string[];
    onchange: (next: string[]) => void;
    resetLabel: string;
    searchLabel: string;
  } = $props();

  let open = $state(false);
  let needle = $state('');
  let root: HTMLElement | undefined = $state();
  let button: HTMLButtonElement | undefined = $state();

  // A list that long is worth a way to narrow it.
  const SEARCH_FROM = 10;
  const shownOptions = $derived(
    needle.trim() === ''
      ? options
      : options.filter((o) => o.label.toLowerCase().includes(needle.trim().toLowerCase())),
  );
  const summary = $derived.by(() => {
    if (selected.length === 0) return label;
    if (selected.length === 1) {
      const one = options.find((o) => o.value === selected[0]);
      return `${label}: ${one?.label ?? selected[0]}`;
    }
    return `${label}: ${selected.length}`;
  });

  function toggle(value: string): void {
    onchange(selected.includes(value) ? selected.filter((v) => v !== value) : [...selected, value]);
  }

  function close(focusButton: boolean): void {
    open = false;
    needle = '';
    if (focusButton) button?.focus();
  }

  function onWindowClick(event: MouseEvent): void {
    if (open && root && event.target instanceof Node && !root.contains(event.target)) {
      close(false);
    }
  }

  function onKey(event: KeyboardEvent): void {
    if (event.key === 'Escape' && open) {
      // The page's own Escape (leave the selection) must not also fire, nor the dialog's own (it would close).
      event.stopPropagation();
      event.preventDefault();
      close(true);
    }
  }
</script>

<svelte:window onclick={onWindowClick} />

<div class="multi" bind:this={root} onkeydown={onKey} role="presentation">
  <button
    bind:this={button}
    type="button"
    class="trigger"
    class:active={selected.length > 0}
    aria-haspopup="true"
    aria-expanded={open}
    onclick={() => (open ? close(false) : (open = true))}
  >
    <span>{summary}</span>
    <span class="caret" aria-hidden="true">▾</span>
  </button>
  {#if open}
    <div class="popup" role="group" aria-label={label}>
      {#if options.length >= SEARCH_FROM}
        <input
          type="search"
          class="narrow"
          placeholder={searchLabel}
          aria-label={searchLabel}
          bind:value={needle}
        />
      {/if}
      <ul>
        {#each shownOptions as option (option.value)}
          <li>
            <label title={option.title}>
              <input
                type="checkbox"
                checked={selected.includes(option.value)}
                onchange={() => toggle(option.value)}
              />
              <span>{option.label}{option.suffix === undefined ? '' : ` (${option.suffix})`}</span>
            </label>
          </li>
        {/each}
      </ul>
      {#if selected.length > 0}
        <button type="button" class="reset" onclick={() => onchange([])}>{resetLabel}</button>
      {/if}
    </div>
  {/if}
</div>

<style>
  .multi {
    position: relative;
  }
  .trigger {
    display: inline-flex;
    align-items: center;
    gap: 0.4rem;
    background: var(--surface-2);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 0.3rem 0.6rem;
    cursor: pointer;
    color: var(--text);
  }
  .trigger.active {
    border-color: var(--accent);
  }
  .caret {
    color: var(--muted);
    font-size: 0.8em;
  }
  .popup {
    position: absolute;
    z-index: 10;
    top: calc(100% + 0.25rem);
    left: 0;
    min-width: 14rem;
    max-width: 24rem;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    box-shadow: 0 6px 20px rgb(0 0 0 / 0.25);
    padding: 0.4rem;
  }
  .narrow {
    width: 100%;
    box-sizing: border-box;
    margin-bottom: 0.3rem;
    background: var(--surface-2);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 0.25rem 0.4rem;
  }
  ul {
    list-style: none;
    margin: 0;
    padding: 0;
    max-height: 20rem;
    overflow: auto;
  }
  li label {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.2rem 0.3rem;
    border-radius: var(--radius);
    cursor: pointer;
    white-space: nowrap;
  }
  li label:hover {
    background: var(--surface-2);
  }
  .reset {
    margin-top: 0.3rem;
    width: 100%;
    background: none;
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 0.25rem;
    cursor: pointer;
    color: var(--text);
  }
</style>
