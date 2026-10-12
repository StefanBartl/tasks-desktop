<script lang="ts">
  import type { TaskEntry } from '../lib/contract';
  import { translate, type Key, type Lang } from '../lib/i18n';
  import { markHidden } from '../lib/text';

  let {
    task,
    lang,
    selected = false,
    onselect,
  }: { task: TaskEntry; lang: Lang; selected?: boolean; onselect: (id: string) => void } =
    $props();

  const status = $derived(task.status ? translate(lang, `status.${task.status}` as Key) : '?');
  const state = $derived(
    task.readiness ? translate(lang, `state.${task.readiness.state}` as Key) : null,
  );
</script>

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
    <span class="tag">{status}</span>
    {#if state && task.readiness?.state !== 'unknown'}<span class="tag soft">{state}</span>{/if}
    <span class="tag soft">{task.prio !== undefined ? `P${task.prio}` : '?'}</span>
    {#if task.effort}<span class="tag soft">{task.effort}</span>{/if}
    {#if task.steps && task.steps.total > 0}
      <span class="tag soft">{task.steps.ticked}/{task.steps.total}</span>
    {/if}
  </span>
</button>

<style>
  .row {
    display: grid;
    grid-template-columns: minmax(8rem, 14rem) 1fr auto;
    gap: 0.75rem;
    align-items: baseline;
    width: 100%;
    text-align: left;
    padding: 0.4rem 0.6rem;
    background: none;
    border: 0;
    border-bottom: 1px solid var(--border);
    cursor: pointer;
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
