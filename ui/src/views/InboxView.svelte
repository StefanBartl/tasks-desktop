<script lang="ts">
  // The inbox: the open tasks that are not sorted yet, one single key for each field (see `lib/inbox.ts`). The keys
  // are read in `App.svelte`, with the others; this view shows the list, what each task still lacks, and the keys.
  import { onMount, untrack } from 'svelte';
  import type { App } from '../lib/app.svelte';
  import { INBOX_PAGE, inboxOf, missingOf, shownCount } from '../lib/inbox';
  import { narrows } from '../lib/filter';
  import { hintOf, translate, type Key } from '../lib/i18n';
  import Info from 'appkit-ui/Info.svelte';
  import { markHidden } from '../lib/text';
  import Detail from './Detail.svelte';
  import FilterNote from './FilterNote.svelte';

  let { app }: { app: App } = $props();
  // What the keys write (see `triageKey`): shown as they are read, never worked out here.
  const EFFORT_KEYS = [['a', 'XS'], ['s', 'S'], ['d', 'M'], ['f', 'L'], ['⇧F', 'XL']] as const;
  const WHO_KEYS = [['m', 'me'], ['p', 'pair'], ['i', 'cdx']] as const;
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
  // The selected row stays in view while the keys move it. Only a change of the selection scrolls (as in the list):
  // rows that come or go (a filter emptied, a task sorted away) must not pull the page to the selected row.
  let scrollTo = $state<string | null>(null);
  $effect(() => {
    scrollTo = app.selectedId;
  });
  $effect(() => {
    if (scrollTo === null) return;
    void rows.length;
    const id = scrollTo;
    const frame = requestAnimationFrame(() => {
      const row = document.querySelector('.inbox [aria-current="true"]');
      if (row) {
        row.scrollIntoView({ block: 'nearest' });
        scrollTo = null;
      } else if (!rows.some((t) => t.id === id) && app.tasks.some((t) => t.id === id)) scrollTo = null;
    });
    return () => cancelAnimationFrame(frame);
  });
</script>

<div class="split">
  <section class="inbox" aria-label={t('nav.inbox')}>
    <FilterNote {app} />
    <header class="intro">
      <div class="head">
        <h2>{t('inbox.title')}</h2>
        <Info hint={t('hint.inbox')} label={t('hint.about', { what: t('nav.inbox') })} />
        <p class="count" role="status">{t(rows.length === 1 ? 'inbox.count_one' : 'inbox.count', { n: rows.length })}</p>
      </div>
      <p class="about">{t('inbox.intro')}</p>
      <ul class="keys" aria-label={t('inbox.keys.label')}>
        <li><span class="kgroup">{t('inbox.keys.move')}</span><kbd>j</kbd><kbd>k</kbd></li>
        <li><span class="kgroup">{t('inbox.keys.prio')}</span><kbd>1</kbd><kbd>2</kbd><kbd>3</kbd></li>
        <li>
          <span class="kgroup">{t('inbox.keys.effort')}</span>
          {#each EFFORT_KEYS as [key, size] (size)}<span class="pair"><kbd>{key}</kbd>{size}</span>{/each}
        </li>
        <li>
          <span class="kgroup">{t('inbox.keys.who')}</span>
          {#each WHO_KEYS as [key, who] (who)}<span class="pair"><kbd>{key}</kbd>{t(`inbox.who.${who}` as Key)}</span>{/each}
        </li>
        <li><span class="kgroup">{t('inbox.keys.undo')}</span><kbd>u</kbd></li>
      </ul>
    </header>
    <div class="rows">
      {#each drawn as task, i (task.id)}
        {#if i === 0 || drawn[i - 1]?.area !== task.area}
          <h3 class="area">{task.area}<span class="n">{rows.filter((r) => r.area === task.area).length}</span></h3>
        {/if}
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
        <p class="empty">{t(narrows(app.filter) && inboxOf(app.tasks).length > 0 ? 'inbox.empty_filtered' : 'inbox.empty')}</p>
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
  .intro {
    padding: 0.6rem 0.8rem 0.5rem;
    border-bottom: 1px solid var(--border);
  }
  .head h2 {
    margin: 0;
    font-size: 1.05rem;
  }
  .count {
    margin: 0 0 0 auto;
    color: var(--muted);
    font-size: 0.85rem;
  }
  .about {
    margin: 0.3rem 0 0.5rem;
    color: var(--muted);
    font-size: 0.85rem;
  }
  .keys {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-wrap: wrap;
    gap: 0.4rem 1.1rem;
    font-size: 0.8rem;
  }
  .keys li {
    display: flex;
    align-items: center;
    gap: 0.3rem;
  }
  .kgroup {
    color: var(--muted);
    margin-right: 0.1rem;
  }
  .pair {
    display: inline-flex;
    align-items: center;
    gap: 0.2rem;
    margin-right: 0.2rem;
  }
  kbd {
    font-family: var(--mono);
    font-size: 0.75rem;
    min-width: 1.4em;
    text-align: center;
    padding: 0.05rem 0.3rem;
    background: var(--surface-2);
    border: 1px solid var(--border);
    border-bottom-width: 2px;
    border-radius: var(--radius);
  }
  .area {
    display: flex;
    align-items: baseline;
    gap: 0.5rem;
    margin: 0;
    padding: 0.35rem 0.6rem;
    position: sticky;
    top: 0;
    z-index: 1;
    background: var(--surface);
    border-bottom: 1px solid var(--border);
    font-size: 0.8rem;
    letter-spacing: 0.03em;
    color: var(--muted);
  }
  .area .n {
    font-weight: normal;
  }
  .rows {
    overflow: auto;
    flex: 1;
    min-height: 0;
  }
  .row {
    display: grid;
    /* The title keeps a width of its own: the marks wrap before they push it to nothing. */
    grid-template-columns: minmax(8rem, 14rem) minmax(6rem, 1fr) auto;
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
    flex-wrap: wrap;
    justify-content: flex-end;
    gap: 0.3rem;
    max-width: 18rem;
  }
  .tag {
    white-space: nowrap;
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
