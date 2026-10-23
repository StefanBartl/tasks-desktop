<script lang="ts">
  // The filter of the list is on for every view (list, board, plan, inbox, overview): this strip says so, names what is
  // on, and switches a single filter off or all of them. The filter itself is changed in the list.
  import type { App } from '../lib/app.svelte';
  import { activeFilters, narrows, without, type ActiveFilter } from '../lib/filter';
  import { chipJoins, chipLabel } from '../lib/filter-chips';
  import { translate, type Key } from '../lib/i18n';
  import { tick } from 'svelte';

  let { app, plan = false }: { app: App; plan?: boolean } = $props();
  const t = (key: Key, params: Record<string, string | number> = {}) => translate(app.lang, key, params);

  // Each chip names how it goes with the one before it (or within a field, and between fields), for the eye and the
  // screen reader alike; the search words come first and hold together with the chips.
  const chips = $derived.by(() => {
    const joins = chipJoins(app.filter, app.filter.query.trim() !== '');
    return activeFilters(app.filter).map((item, i) => ({
      item,
      join: joins[i] ?? null,
      label: chipLabel(app.lang, app.filter, item, { short: app.shortAreas, all: app.allAreaNames }),
    }));
  });
  let list: HTMLUListElement | undefined = $state();
  /** After a change the focus must not fall to the page: it goes to the next chip, else to the view's main area. */
  async function keepFocus(change: () => void, index: number): Promise<void> {
    change();
    await tick();
    const buttons = list?.querySelectorAll<HTMLButtonElement>('li button');
    if (buttons && buttons.length > 0) buttons[Math.min(index, buttons.length - 1)]?.focus();
    else document.querySelector<HTMLElement>('main')?.focus();
  }
  /** The strip goes with the view it is in: the focus goes to the main area of the list, not to the page. */
  async function toList(): Promise<void> {
    app.setView('list');
    await tick();
    document.querySelector<HTMLElement>('main')?.focus();
  }
</script>

{#if narrows(app.filter)}
  <div class="note" data-testid="filter-note">
    <p role="status">{t(plan ? 'filter.note.plan' : 'filter.note', { shown: app.shown.length, total: app.tasks.length })}</p>
    <ul aria-label={t('filter.active')} bind:this={list}>
      {#if app.filter.query.trim() !== ''}
        <li>
          <span>{t('filter.query', { text: app.filter.query.trim() })}</span>
          <button type="button" aria-label={t('filter.remove', { what: t('filter.query', { text: app.filter.query.trim() }) })} onclick={() => void keepFocus(() => app.setQuery(''), 0)}>×</button>
        </li>
      {/if}
      {#each chips as c, index (c.item.kind + ':' + c.item.value)}
        <li>
          {#if c.join}<span class="join">{t(`filter.join.${c.join}`)}</span>{/if}
          <span>{c.label}</span>
          <button type="button" aria-label={t('filter.remove', { what: c.label })} onclick={() => void keepFocus(() => (app.filter = without(app.filter, c.item)), index + (app.filter.query.trim() !== '' ? 1 : 0))}>×</button>
        </li>
      {/each}
      <li><button type="button" class="linkish" onclick={() => void keepFocus(() => app.resetFilter(), 0)}>{t('filter.clear')}</button></li>
      <li><button type="button" class="linkish" onclick={() => void toList()}>{t('filter.note.change')}</button></li>
    </ul>
  </div>
{/if}

<style>
  .note {
    margin: 0 0 0.75rem;
    font-size: 0.9rem;
  }
  .note p {
    margin: 0 0 0.25rem;
    color: var(--muted);
  }
  ul {
    list-style: none;
    padding: 0;
    margin: 0;
    display: flex;
    flex-wrap: wrap;
    gap: 0.4rem;
  }
  li {
    display: inline-flex;
    align-items: center;
    gap: 0.25rem;
    background: var(--surface-2);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 0.1rem 0.4rem;
  }
  button {
    background: none;
    border: 0;
    color: var(--muted);
    cursor: pointer;
    padding: 0 0.2rem;
  }
  /* The word that joins a chip to the one before it: part of the chip's text, quieter than its value. */
  .join {
    color: var(--muted);
    font-size: 0.85em;
    padding-right: 0.25rem;
    border-right: 1px solid var(--border);
  }
  button.linkish {
    color: var(--accent);
  }
  li:has(button.linkish) {
    background: none;
    border-color: transparent;
  }
</style>
