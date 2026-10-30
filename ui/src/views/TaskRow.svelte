<script lang="ts">
  import { contextTarget, type ContextTarget } from 'appkit-ui/contextmenu';
  import type { TaskEntry } from '../lib/contract';
  import { hintOf, translate, type Lang } from '../lib/i18n';
  import { markHidden } from '../lib/text';
  import { statusTags } from '../lib/statusTags';
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
    drafted = 0,
    target,
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
    /** How many fields of the task are changed and not saved yet (the option to save fields with a button). */
    drafted?: number;
    /** What the row is for the context menu (a right click, the menu key, Shift+F10). */
    target?: ContextTarget;
  } = $props();

  // A word this version does not know is shown as it is.
  // When the status and the state say the same word there is one mark (statusTags).
  const tags = $derived(
    statusTags(lang, task.status, task.readiness?.state === 'unknown' ? undefined : task.readiness?.state),
  );
  const due = $derived(isDue(task.remind, today));

  /**
   * A cell whose text is cut shows all of it in the hint popup. The kit reads `data-hint` when the pointer comes over
   * the element (on the document); this runs first, on the element, so the hint is there only while the text is cut.
   */
  function hintWhenCut(event: MouseEvent): void {
    const el = event.target instanceof HTMLElement ? event.target.closest<HTMLElement>('.id, .title') : null;
    if (el === null) return;
    if (el.scrollWidth > el.clientWidth) el.setAttribute('data-hint', el.textContent ?? '');
    else el.removeAttribute('data-hint');
  }
</script>

<div class="line" class:marked>
<input
  type="checkbox"
  class="mark"
  checked={marked}
  aria-label={markLabel}
  onchange={(e) => (e.currentTarget.checked = onmark(task.id))}
/>
<!-- The mouseover only puts the whole text of a cut cell into its hint; the keyboard reaches the row as before. -->
<!-- svelte-ignore a11y_mouse_events_have_key_events -->
<button
  type="button"
  class="row"
  class:selected
  aria-current={selected ? 'true' : undefined}
  onclick={() => onselect(task.id)}
  use:contextTarget={target}
  onmouseover={hintWhenCut}
>
  <span class="id">{task.id}</span>
  <span class="title">{markHidden(task.title)}</span>
  <span class="meta">
    <!-- A sign carries its meaning only for the eye: a screen reader gets the word (the hint is the long form). -->
    {#if !task.valid}<span class="tag bad" data-hint={hintOf(lang, 'hint', 'invalid')}><span aria-hidden="true">!</span><span class="sr-only">{translate(lang, 'mark.invalid')}</span></span>{/if}
    {#if flagged > 0}<span class="tag bad" data-hint={flagTitle}><span aria-hidden="true">⚑ {flagged}</span><span class="sr-only">{translate(lang, 'mark.flagged', { n: flagged })}</span></span>{/if}
    {#if crossAreas.length >= 2}<span class="tag soft" data-hint={crossTitle}><span aria-hidden="true">↔ {crossAreas.length}</span><span class="sr-only">{translate(lang, 'mark.cross', { n: crossAreas.length })}</span></span>{/if}
    {#if drafted > 0}<span class="tag draft" data-hint={translate(lang, 'mark.draft', { n: drafted })}><span aria-hidden="true">✎ {drafted}</span><span class="sr-only">{translate(lang, 'mark.draft', { n: drafted })}</span></span>{/if}
    {#if due}<span class="tag due" data-hint={translate(lang, 'remind.due', { date: task.remind ?? '' })}><span aria-hidden="true">⏰ {task.remind}</span><span class="sr-only">{translate(lang, 'mark.due', { date: task.remind ?? '' })}</span></span>{/if}
    <span class="tag" data-hint={tags.status.hint}>{tags.status.label}</span>
    {#if tags.state}<span class="tag soft" data-hint={tags.state.hint}>{tags.state.label}</span>{/if}
    <span class="tag soft" data-hint={hintOf(lang, 'hint', 'prio')}>{#if task.prio !== undefined}P{task.prio}{:else}<span aria-hidden="true">?</span><span class="sr-only">{translate(lang, 'mark.no_prio')}</span>{/if}</span>
    {#if task.effort}<span class="tag soft" data-hint={hintOf(lang, 'hint', 'effort')}>{task.effort}</span>{/if}
    {#if task.steps && task.steps.total > 0}
      <span class="tag soft" data-hint={hintOf(lang, 'hint', 'steps')}>{task.steps.ticked}/{task.steps.total}</span>
    {/if}
    {#if task.open_questions}
      <span class="tag" data-hint={hintOf(lang, 'hint', 'questions')}><span aria-hidden="true">?{task.open_questions}</span><span class="sr-only">{translate(lang, 'mark.questions', { n: task.open_questions })}</span></span>
    {/if}
  </span>
</button>
</div>

<style>
  .tag.draft {
    color: var(--accent);
    border-color: var(--accent);
  }
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
    /* The title keeps a width of its own: the tags wrap before they push it to nothing. The id and the marks take
       the widths the head of the list was dragged to (--col-id, --col-meta), else these defaults. */
    grid-template-columns: var(--col-id, minmax(8rem, 14rem)) minmax(6rem, 1fr) var(--col-meta, auto);
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
    max-width: var(--col-meta, 18rem);
    min-width: 0;
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
