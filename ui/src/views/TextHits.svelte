<script lang="ts">
  import type { App } from '../lib/app.svelte';
  import { translate, type Key } from '../lib/i18n';
  import { matches } from '../lib/filter';
  import { pieces } from '../lib/marks';
  import { markHidden } from '../lib/text';

  let { app }: { app: App } = $props();

  const t = (key: Key, params: Record<string, string | number> = {}) =>
    translate(app.lang, key, params);

  const search = $derived(app.textSearch);
  const byId = $derived(new Map(app.tasks.map((x) => [x.id, x] as const)));
  // What the list already shows by its title or id is not said twice.
  const inList = $derived(new Set(app.shown.map((x) => x.id)));
  // The area, status and actor the person chose hold for the text as well; a
  // task the list does not have cannot be opened, so it is not offered.
  const hits = $derived(
    (search?.result.hits ?? []).filter((h) => {
      const task = byId.get(h.id);
      return !!task && !inList.has(h.id) && matches(task, { ...app.filter, query: '' }, app.today, app.crossIndex);
    }),
  );
</script>

{#if search}
  <section class="hits" aria-label={t('search.in_text', { n: hits.length })}>
    {#if search.result.partial}
      <p class="note" role="status">{t('search.partial')}</p>
    {/if}
    {#if search.result.status === 'building'}
      <p class="note" role="status">{t('search.building')}</p>
    {:else if search.result.status === 'failed'}
      <p class="note" role="status">{t('search.failed')}</p>
    {:else if hits.length > 0}
      <h2 class="eyebrow">{t('search.in_text', { n: hits.length })}</h2>
      <ul>
        {#each hits as hit (hit.id)}
          <li>
            <button
              type="button"
              class="hit"
              class:selected={hit.id === app.selectedId}
              aria-current={hit.id === app.selectedId ? 'true' : undefined}
              onclick={() => app.select(hit.id)}
            >
              <span class="title">{markHidden(byId.get(hit.id)?.title ?? hit.id)}</span>
              <span class="id">{hit.id}</span>
              <span class="snippet">
                {#if hit.snippet.more_before}…{/if}
                {#each pieces(hit.snippet.text, hit.snippet.marks) as piece, i (i)}
                  {#if piece.mark}<mark>{markHidden(piece.text)}</mark>{:else}{markHidden(piece.text)}{/if}
                {/each}
                {#if hit.snippet.more_after}…{/if}
              </span>
            </button>
          </li>
        {/each}
      </ul>
    {:else if search.result.total === 0 && app.shown.length === 0}
      <p class="note" role="status">{t('search.none')}</p>
    {/if}
  </section>
{/if}

<style>
  .hits {
    border-bottom: 1px solid var(--border);
    padding: 0.25rem 0;
    max-height: 40%;
    overflow: auto;
  }
  .eyebrow {
    font-size: 0.8rem;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--muted);
    margin: 0.3rem 0.6rem;
  }
  ul {
    list-style: none;
    margin: 0;
    padding: 0;
  }
  .hit {
    display: grid;
    grid-template-columns: 1fr auto;
    gap: 0.1rem 0.75rem;
    width: 100%;
    text-align: left;
    padding: 0.35rem 0.6rem;
    background: none;
    border: 0;
    border-bottom: 1px solid var(--border);
    cursor: pointer;
  }
  .hit:hover,
  .hit.selected {
    background: var(--surface-2);
  }
  .hit:focus-visible {
    outline-offset: -2px;
  }
  .title {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .id {
    font-family: var(--mono);
    font-size: 0.8rem;
    color: var(--muted);
  }
  .snippet {
    grid-column: 1 / -1;
    color: var(--muted);
    font-size: 0.85rem;
    overflow-wrap: anywhere;
  }
  mark {
    background: light-dark(#ffe58a, #6b5a00);
    color: var(--text);
    border-radius: 2px;
  }
  .note {
    margin: 0;
    padding: 0.4rem 0.6rem;
    color: var(--muted);
  }
</style>
