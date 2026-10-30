<script lang="ts">
  import { contextTarget, type ContextTarget } from 'appkit-ui/contextmenu';
  // One group of the tasks behind a number: a heading with how many, and the tasks, a page at a time.
  import type { App } from '../lib/app.svelte';
  import { PAGE } from '../lib/counts';
  import type { TaskEntry } from '../lib/contract';
  import { translate, type Key } from '../lib/i18n';
  import { createGrip, type PointerDragEvent } from '../lib/pointerDrag';
  import { markHidden } from '../lib/text';

  let {
    app,
    heading,
    tasks,
    open = true,
    ondragtask,
    onpointerdrag,
    target,
  }: {
    app: App;
    heading: string | null;
    tasks: TaskEntry[];
    open?: boolean;
    /** A task of this group is dragged (its id), or the drag ended (null): the panel then shows the areas as targets. */
    ondragtask?: (id: string | null) => void;
    /** The grip of a row is dragged with a finger or a pen (see `lib/pointerDrag.ts`). */
    onpointerdrag?: (event: PointerDragEvent) => void;
    /** The context menu of the heading (a right click, the menu key, Shift+F10), where the group has one. */
    target?: ContextTarget;
  } = $props();

  const grip = createGrip(
    () => onpointerdrag,
    () => app.locked,
  );

  function dragStart(event: DragEvent, id: string): void {
    if (!ondragtask || app.locked) {
      event.preventDefault();
      return;
    }
    event.dataTransfer?.setData('text/plain', id);
    if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move';
    // Not in the event: a change of the page while `dragstart` runs makes Chrome end the drag at once (the areas
    // would be drawn above the row that is dragged). One turn later the drag is going.
    pending = setTimeout(() => ondragtask(id), 0);
  }
  let pending: ReturnType<typeof setTimeout> | undefined;
  function dragEnd(): void {
    clearTimeout(pending);
    ondragtask?.(null);
  }

  const t = (key: Key, params: Record<string, string | number> = {}) =>
    translate(app.lang, key, params);

  let limit = $state(PAGE);
  const rows = $derived(tasks.slice(0, limit));
  const more = $derived(Math.min(PAGE, tasks.length - rows.length));
</script>

{#snippet list()}
  <ul class="plain">
    {#each rows as task (task.id)}
      <li
        draggable={ondragtask && !app.locked ? 'true' : undefined}
        ondragstart={(e) => dragStart(e, task.id)}
        ondragend={dragEnd}
      >
        <button
          type="button"
          class="link"
          onclick={() => app.peek(task.id)}
          onkeydown={(e) => {
            if (e.key === 'm' && !e.ctrlKey && !e.metaKey && !e.altKey && ondragtask) {
              e.preventDefault();
              app.chooseDropMove(task.id);
            }
          }}>{markHidden(task.title)}</button
        >
        <span class="muted"
          ><code>{task.id}</code>{task.prio !== undefined ? ` · P${task.prio}` : ''}</span
        >
        {#if onpointerdrag}
          <!-- A finger drags by this grip (a screen reader and the keys have the button beside it). -->
          <span
            class="grip"
            role="presentation"
            aria-hidden="true"
            onpointerdown={(e) => grip(e, task.id, 'start')}
            onpointermove={(e) => grip(e, task.id, 'move')}
            onpointerup={(e) => grip(e, task.id, 'end')}
            onpointercancel={(e) => grip(e, task.id, 'cancel')}>⠿</span
          >
        {/if}
        {#if ondragtask}
          <button
            type="button"
            class="move"
            aria-label={t('drop.row_button', { id: task.id })}
            title={t('drop.choose')}
            onclick={() => app.chooseDropMove(task.id)}>⇄</button
          >
        {/if}
      </li>
    {/each}
  </ul>
  {#if more > 0}
    <button type="button" class="more" onclick={() => (limit += PAGE)}>{t('count.more', { n: more })}</button>
  {/if}
{/snippet}

{#if heading === null}
  {@render list()}
{:else}
  <details {open}>
    <summary use:contextTarget={target}>{markHidden(heading)} <span class="muted">({tasks.length})</span></summary>
    {@render list()}
  </details>
{/if}

<style>
  .plain {
    list-style: none;
    padding: 0;
    margin: 0.25rem 0;
  }
  .grip {
    display: inline-block;
    min-width: 1.6rem;
    text-align: center;
    cursor: grab;
    color: var(--muted);
    touch-action: none;
    user-select: none;
  }
  .move {
    background: none;
    border: 1px solid var(--border);
    border-radius: var(--radius);
    color: var(--text);
    cursor: pointer;
    padding: 0 0.35rem;
    margin-left: 0.4rem;
  }
  .plain li {
    padding: 0.1rem 0;
  }
  summary {
    cursor: pointer;
    padding: 0.2rem 0;
    font-weight: 600;
  }
  .link {
    background: none;
    border: 0;
    padding: 0;
    color: var(--accent);
    cursor: pointer;
    text-align: left;
  }
  .muted {
    color: var(--muted);
  }
  .more {
    background: var(--surface-2);
    color: var(--text);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 0.25rem 0.7rem;
    cursor: pointer;
    margin: 0.25rem 0 0.5rem;
  }
</style>
