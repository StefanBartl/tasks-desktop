<script lang="ts">
  // The tasks of a view in groups: as columns (one per value, side by side) or as a list of sections that fold. What a
  // card or a row looks like is the caller's (`item`); which groups there are and what a drop onto one does is not this
  // component's either: it hands a drop on (`ondrop`) and the page turns it into an operation (`lib/groups.ts`). Nothing
  // here names a field or a value.
  import type { Snippet } from 'svelte';
  import type { TaskEntry } from '../lib/contract';
  import { countOf, type Group } from '../lib/groups';

  let {
    groups,
    mode,
    label,
    item,
    collapsed = [],
    ontoggle,
    ondrop,
    canDrop = () => true,
    busy = false,
    columnsLabel,
    hint,
  }: {
    groups: readonly Group<TaskEntry>[];
    mode: 'columns' | 'list';
    /** The words for a group: its value as the person reads it. */
    label: (value: string) => string;
    /** One task: a card (columns) or a row (list). */
    item: Snippet<[TaskEntry, Group<TaskEntry>]>;
    /** The groups that are folded (list mode). */
    collapsed?: readonly string[];
    ontoggle?: (value: string) => void;
    /** A task was dropped from the group `from` onto the group `to`; `copy` is the Ctrl key. */
    ondrop?: (id: string, from: string, to: string, copy: boolean) => void;
    /** Whether a drop from `from` onto `to` can be made (the target shows it). */
    canDrop?: (id: string, from: string, to: string) => boolean;
    /** A write is under way: nothing is dragged. */
    busy?: boolean;
    /** The name of the set of columns for assistive software. */
    columnsLabel: string;
    /** The explanation of a group (the hover popup). */
    hint?: (value: string) => string;
  } = $props();

  const MIME = 'application/x-tasks-group-item';

  let dragging = $state<{ id: string; from: string } | null>(null);
  let over = $state<string | null>(null);

  function start(event: DragEvent, id: string, from: string): void {
    if (busy || !ondrop) {
      event.preventDefault();
      return;
    }
    dragging = { id, from };
    event.dataTransfer?.setData(MIME, id);
    event.dataTransfer?.setData('text/plain', id);
    if (event.dataTransfer) event.dataTransfer.effectAllowed = 'copyMove';
  }

  function end(): void {
    dragging = null;
    over = null;
  }

  function enter(event: DragEvent, value: string): void {
    if (dragging === null) return;
    const ok = canDrop(dragging.id, dragging.from, value);
    over = ok ? value : null;
    // Only a place that takes the drop allows it (the cursor shows the difference).
    if (ok) {
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = event.ctrlKey ? 'copy' : 'move';
    }
  }

  function drop(event: DragEvent, value: string): void {
    event.preventDefault();
    const from = dragging;
    end();
    if (from !== null && ondrop && canDrop(from.id, from.from, value)) ondrop(from.id, from.from, value, event.ctrlKey);
  }
</script>

{#if mode === 'columns'}
  <div class="columns" role="group" aria-label={columnsLabel}>
    {#each groups as group (group.value)}
      <section
        class="column"
        class:target={over === group.value && dragging !== null}
        data-group={group.value}
        aria-label={`${label(group.value)} (${countOf(group)})`}
        ondragenter={(e) => enter(e, group.value)}
        ondragover={(e) => enter(e, group.value)}
        ondrop={(e) => drop(e, group.value)}
      >
        <h3 data-hint={hint?.(group.value)}>
          <span class="name">{label(group.value)}</span>
          <span class="count" data-count>{countOf(group)}</span>
        </h3>
        <ul>
          {#each group.items as task (`${group.value}/${task.id}`)}
            <li
              data-item={task.id}
              class:dragging={dragging?.id === task.id}
              draggable={ondrop !== undefined && !busy}
              ondragstart={(e) => start(e, task.id, group.value)}
              ondragend={end}
            >
              {@render item(task, group)}
            </li>
          {/each}
        </ul>
      </section>
    {/each}
  </div>
{:else}
  <div class="sections">
    {#each groups as group (group.value)}
      {@const folded = collapsed.includes(group.value)}
      <section
        class="section"
        class:target={over === group.value && dragging !== null}
        data-group={group.value}
        role="group"
        aria-label={`${label(group.value)} (${countOf(group)})`}
        ondragenter={(e) => enter(e, group.value)}
        ondragover={(e) => enter(e, group.value)}
        ondrop={(e) => drop(e, group.value)}
      >
        <h3 data-hint={hint?.(group.value)}>
          <button type="button" aria-expanded={!folded} onclick={() => ontoggle?.(group.value)}>
            <span class="caret" aria-hidden="true">{folded ? '▸' : '▾'}</span>
            <span class="name">{label(group.value)}</span>
            <span class="count" data-count>{countOf(group)}</span>
          </button>
        </h3>
        {#if !folded}
          <ul>
            {#each group.items as task (`${group.value}/${task.id}`)}
              <li
                data-item={task.id}
                class:dragging={dragging?.id === task.id}
                draggable={ondrop !== undefined && !busy}
                ondragstart={(e) => start(e, task.id, group.value)}
                ondragend={end}
              >
                {@render item(task, group)}
              </li>
            {/each}
          </ul>
        {/if}
      </section>
    {/each}
  </div>
{/if}

<style>
  .columns {
    display: grid;
    grid-auto-flow: column;
    grid-auto-columns: minmax(14rem, 1fr);
    gap: 0.6rem;
    overflow-x: auto;
    align-items: start;
  }
  .column,
  .section {
    background: var(--surface);
    border: 1px solid var(--line);
    border-radius: var(--radius);
    padding: 0.4rem 0.5rem;
    min-width: 0;
  }
  .sections {
    display: grid;
    gap: 0.5rem;
  }
  .target {
    outline: 2px solid var(--accent);
    outline-offset: -2px;
    background: var(--accent-soft);
  }
  h3 {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 0.5rem;
    margin: 0 0 0.4rem;
    font-size: 0.85rem;
  }
  h3 button {
    display: flex;
    align-items: baseline;
    gap: 0.4rem;
    width: 100%;
    background: none;
    border: 0;
    color: inherit;
    font: inherit;
    cursor: pointer;
    text-align: left;
    padding: 0;
  }
  .count {
    color: var(--muted);
    font-weight: normal;
  }
  ul {
    list-style: none;
    margin: 0;
    padding: 0;
    display: grid;
    gap: 0.35rem;
  }
  li[draggable='true'] {
    cursor: grab;
  }
  li.dragging {
    opacity: 0.5;
  }
</style>
