<script lang="ts">
  import type { TaskEntry } from '../lib/contract';
  import { labelOf, type Lang } from '../lib/i18n';
  import { markHidden } from '../lib/text';
  import { isDue } from '../lib/remind';

  let {
    task,
    lang,
    today,
    selected = false,
    marked = false,
    onselect,
    onmark,
    markLabel,
    flagged = 0,
    flagTitle = '',
  }: {
    task: TaskEntry;
    lang: Lang;
    today: string;
    selected?: boolean;
    marked?: boolean;
    onselect: (id: string) => void;
    onmark: (id: string) => boolean;
    markLabel: string;
    /** How many findings of the check are about this task. */
    flagged?: number;
    flagTitle?: string;
  } = $props();

  // A word this version does not know is shown as it is.
  const status = $derived(labelOf(lang, 'status', task.status));
  const state = $derived(task.readiness ? labelOf(lang, 'state', task.readiness.state) : null);
  const due = $derived(isDue(task.remind, today));
</script>

<div class="line" class:marked>
<input
  type="checkbox"
  class="mark"
  checked={marked}
  aria-label={markLabel}
  onchange={(e) => (e.currentTarget.checked = onmark(task.id))}
/>
<button
  type="button"
  class="row"
  class:selected
  aria-current={selected ? 'true' : undefined}
  onclick={() => onselect(task.id)}
>
  <span class="id">{task.id}</span>
  <span class="title">{markHidden(task.title)}</span>
  <span class="meta">
    {#if !task.valid}<span class="tag bad">!</span>{/if}
    {#if flagged > 0}<span class="tag bad" title={flagTitle}>⚑ {flagged}</span>{/if}
    {#if due}<span class="tag due" title={task.remind}>⏰ {task.remind}</span>{/if}
    <span class="tag">{status}</span>
    {#if state && task.readiness?.state !== 'unknown'}<span class="tag soft">{state}</span>{/if}
    <span class="tag soft">{task.prio !== undefined ? `P${task.prio}` : '?'}</span>
    {#if task.effort}<span class="tag soft">{task.effort}</span>{/if}
    {#if task.steps && task.steps.total > 0}
      <span class="tag soft">{task.steps.ticked}/{task.steps.total}</span>
    {/if}
  </span>
</button>
</div>

<style>
  .line {
    display: flex;
    align-items: center;
    border-bottom: 1px solid var(--border);
  }
  .line.marked {
    background: var(--surface-2);
  }
  .mark {
    margin: 0 0 0 0.6rem;
    flex: none;
  }
  .row {
    flex: 1;
    min-width: 0;
    display: grid;
    grid-template-columns: minmax(8rem, 14rem) 1fr auto;
    gap: 0.75rem;
    align-items: baseline;
    width: 100%;
    text-align: left;
    padding: 0.4rem 0.6rem;
    background: none;
    border: 0;
    cursor: pointer;
  }
  /* A row far off the screen is not laid out or painted. */
  .row {
    content-visibility: auto;
    contain-intrinsic-size: auto 2.2rem;
  }
  /* Inside the box: the list clips what is outside it, and the ring would
     show on two sides only. */
  .row:focus-visible {
    outline-offset: -2px;
  }
  .row:hover {
    background: var(--surface-2);
  }
  .row.selected {
    background: var(--surface-2);
    box-shadow: inset 3px 0 0 var(--accent);
  }
  .id {
    font-family: var(--mono);
    font-size: 0.8rem;
    color: var(--muted);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .title {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .meta {
    display: flex;
    gap: 0.3rem;
    white-space: nowrap;
  }
  .tag.due {
    color: var(--warn);
    border-color: var(--warn);
  }
  .tag {
    font-size: 0.75rem;
    padding: 0 0.4rem;
    border-radius: 999px;
    border: 1px solid var(--border);
  }
  .soft {
    color: var(--muted);
  }
  .bad {
    color: var(--bad);
    border-color: var(--bad);
  }
</style>
