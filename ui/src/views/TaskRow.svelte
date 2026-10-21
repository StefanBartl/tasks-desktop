<script lang="ts">
  import type { TaskEntry } from '../lib/contract';
  import { hintOf, labelOf, translate, type Lang } from '../lib/i18n';
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
    crossAreas = [],
    crossTitle = '',
    onmenu,
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
    /** The areas the task touches when that is more than its own (from the links). */
    crossAreas?: readonly string[];
    crossTitle?: string;
    /** The context menu of the row (a right click, the menu key, Shift+F10). */
    onmenu?: (event: MouseEvent) => void;
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
  oncontextmenu={onmenu}
>
  <span class="id">{task.id}</span>
  <span class="title">{markHidden(task.title)}</span>
  <span class="meta">
    <!-- A sign carries its meaning only for the eye: a screen reader gets the word (the hint is the long form). -->
    {#if !task.valid}<span class="tag bad" data-hint={hintOf(lang, 'hint', 'invalid')}><span aria-hidden="true">!</span><span class="sr-only">{translate(lang, 'mark.invalid')}</span></span>{/if}
    {#if flagged > 0}<span class="tag bad" data-hint={flagTitle}><span aria-hidden="true">⚑ {flagged}</span><span class="sr-only">{translate(lang, 'mark.flagged', { n: flagged })}</span></span>{/if}
    {#if crossAreas.length >= 2}<span class="tag soft" data-hint={crossTitle}><span aria-hidden="true">↔ {crossAreas.length}</span><span class="sr-only">{translate(lang, 'mark.cross', { n: crossAreas.length })}</span></span>{/if}
    {#if due}<span class="tag due" data-hint={translate(lang, 'remind.due', { date: task.remind ?? '' })}><span aria-hidden="true">⏰ {task.remind}</span><span class="sr-only">{translate(lang, 'mark.due', { date: task.remind ?? '' })}</span></span>{/if}
    <span class="tag" data-hint={hintOf(lang, 'hint.status', task.status)}>{status}</span>
    {#if state && task.readiness?.state !== 'unknown'}<span class="tag soft" data-hint={hintOf(lang, 'hint.state', task.readiness?.state)}>{state}</span>{/if}
    <span class="tag soft" data-hint={hintOf(lang, 'hint', 'prio')}>{#if task.prio !== undefined}P{task.prio}{:else}<span aria-hidden="true">?</span><span class="sr-only">{translate(lang, 'mark.no_prio')}</span>{/if}</span>
    {#if task.effort}<span class="tag soft" data-hint={hintOf(lang, 'hint', 'effort')}>{task.effort}</span>{/if}
    {#if task.steps && task.steps.total > 0}
      <span class="tag soft" data-hint={hintOf(lang, 'hint', 'steps')}>{task.steps.ticked}/{task.steps.total}</span>
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
    /* The title keeps a width of its own: the tags wrap before they push it to nothing. */
    grid-template-columns: minmax(8rem, 14rem) minmax(6rem, 1fr) auto;
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
    flex-wrap: wrap;
    justify-content: flex-end;
    gap: 0.3rem;
    /* Wider than this the tags take from the title; a row with many of them grows in height instead. */
    max-width: 18rem;
  }
  .tag {
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
