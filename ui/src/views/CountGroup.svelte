<script lang="ts">
  // One group of the tasks behind a number: a heading with how many, and the tasks, a page at a time.
  import type { App } from '../lib/app.svelte';
  import { PAGE } from '../lib/counts';
  import type { TaskEntry } from '../lib/contract';
  import { translate, type Key } from '../lib/i18n';
  import { markHidden } from '../lib/text';

  let {
    app,
    heading,
    tasks,
    open = true,
  }: { app: App; heading: string | null; tasks: TaskEntry[]; open?: boolean } = $props();

  const t = (key: Key, params: Record<string, string | number> = {}) =>
    translate(app.lang, key, params);

  let limit = $state(PAGE);
  const rows = $derived(tasks.slice(0, limit));
  const more = $derived(Math.min(PAGE, tasks.length - rows.length));
</script>

{#snippet list()}
  <ul class="plain">
    {#each rows as task (task.id)}
      <li>
        <button type="button" class="link" onclick={() => app.reveal(task.id)}>{markHidden(task.title)}</button>
        <span class="muted"
          ><code>{task.id}</code>{task.prio !== undefined ? ` · P${task.prio}` : ''}</span
        >
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
    <summary>{markHidden(heading)} <span class="muted">({tasks.length})</span></summary>
    {@render list()}
  </details>
{/if}

<style>
  .plain {
    list-style: none;
    padding: 0;
    margin: 0.25rem 0;
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
