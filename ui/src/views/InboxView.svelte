<script lang="ts">
  // The inbox: the open tasks that are not sorted yet, one single key for each field (see `lib/inbox.ts`). The keys
  // are read in `App.svelte`, with the others; this view shows the list, what each task still lacks, and the keys.
  import { onMount, untrack } from 'svelte';
  import type { App } from '../lib/app.svelte';
  import { INBOX_PAGE, missingOf, shownCount } from '../lib/inbox';
  import { hintOf, translate, type Key } from '../lib/i18n';
  import Info from './Info.svelte';
  import { markHidden } from '../lib/text';
  import Detail from './Detail.svelte';

  let { app }: { app: App } = $props();
  const t = (key: Key, params: Record<string, string | number> = {}) => translate(app.lang, key, params);

  const rows = $derived(app.inbox);
  // Only a page of rows is drawn; the selection is always drawn, so the keys can walk down the whole list.
  let limit = $state(INBOX_PAGE);
  const shown = $derived(shownCount(rows, app.selectedId, limit));
  const drawn = $derived(rows.slice(0, shown));
  // When the rows change (the selected task was sorted, here or elsewhere) the selection is on a row again - and only
  // then: a task chosen by the person, or none (Escape), is left alone.
  $effect(() => {
    void rows.map((t) => t.id).join('|');
    untrack(() => app.ensureInboxSelection());
  });
  // The view was restored on page load (no click, no key): the selection starts on a row.
  onMount(() => app.ensureInboxSelection(true));
  // The selected row stays in view while the keys move it.
  $effect(() => {
    if (app.selectedId === null) return;
    void rows.length;
    const frame = requestAnimationFrame(() => {
      document.querySelector('.inbox [aria-current="true"]')?.scrollIntoView({ block: 'nearest' });
    });
    return () => cancelAnimationFrame(frame);
  });
</script>

<div class="split">
  <section class="inbox" aria-label={t('nav.inbox')}>
    <div class="head">
      <p class="count" role="status">{t('inbox.count', { n: rows.length })}</p>
      <Info hint={t('hint.inbox')} label={t('hint.about', { what: t('nav.inbox') })} />
    </div>
    <p class="keys">{t('inbox.keys')}</p>
    <div class="rows">
      {#each drawn as task (task.id)}
        <button
          type="button"
          class="row"
          class:selected={task.id === app.selectedId}
          aria-current={task.id === app.selectedId ? 'true' : undefined}
          onclick={() => app.select(task.id)}
        >
          <span class="id">{task.id}</span>
          <span class="title">{markHidden(task.title)}</span>
          <span class="meta">
            {#each missingOf(task) as field (field)}
              <span class="tag" data-hint={hintOf(app.lang, 'hint.inbox.missing', field)}>{t(`inbox.missing.${field}` as Key)}</span>
            {/each}
          </span>
        </button>
      {:else}
        <p class="empty">{t('inbox.empty')}</p>
      {/each}
      {#if shown < rows.length}
        <button type="button" class="more" onclick={() => (limit = shown + INBOX_PAGE)}>
          {t('inbox.more', { n: rows.length - shown })}
        </button>
      {/if}
    </div>
  </section>
  <Detail {app} />
</div>

<style>
  .split {
    display: grid;
    grid-template-columns: minmax(0, 3fr) minmax(0, 2fr);
    gap: 1rem;
    height: 100%;
    min-height: 0;
  }
  @media (max-width: 52rem) {
    .split {
      grid-template-columns: 1fr;
    }
  }
  .inbox {
    display: flex;
    flex-direction: column;
    min-height: 0;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius);
  }
  .head {
    display: flex;
    align-items: center;
    gap: 0.4rem;
  }
  .count,
  .keys {
    margin: 0;
    padding: 0.3rem 0.6rem;
    color: var(--muted);
    font-size: 0.8rem;
  }
  .keys {
    border-bottom: 1px solid var(--border);
  }
  .rows {
    overflow: auto;
    flex: 1;
    min-height: 0;
  }
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
  .tag {
    font-size: 0.75rem;
    padding: 0 0.4rem;
    border-radius: 999px;
    border: 1px solid var(--border);
    color: var(--muted);
  }
  .more {
    width: 100%;
    padding: 0.5rem 0.6rem;
    background: none;
    border: 0;
    color: var(--accent);
    cursor: pointer;
    text-align: left;
  }
  .empty {
    padding: 1rem;
    color: var(--muted);
  }
</style>
