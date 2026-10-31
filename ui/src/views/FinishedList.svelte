<script lang="ts">
  // The finished tasks under the list of the open ones: the areas and the search text of the list narrow them, a
  // period (last 30 or 90 days, this year, all time) keeps the list short. One area is asked of the engine; several
  // areas and the text are applied to the tasks that have been loaded (the engine has no text search over the
  // Backlogs), and "Show more" loads the next page.
  import { untrack } from 'svelte';
  import type { App } from '../lib/app.svelte';
  import type { Finished } from '../lib/contract';
  import { ApiError } from '../lib/api';
  import { rangeOf, type Preset } from '../lib/finished';
  import { areaLabel } from '../lib/filter';
  import { labelOf, translate, type Key } from '../lib/i18n';
  import { markHidden } from '../lib/text';

  let { app }: { app: App } = $props();
  const t = (key: Key, params: Record<string, string | number> = {}) => translate(app.lang, key, params);

  const PERIODS: readonly Preset[] = ['30', '90', 'year', 'all'];
  let period = $state<Preset>('90');
  let doc = $state<Finished | null>(null);
  let loaded = $state<Finished['items']>([]);
  let problem = $state<string | null>(null);
  let loading = $state(false);
  let seq = 0;

  // an area group stands for its member areas
  const areas = $derived(app.matchAreas);
  // One name to ask the engine for (an area or one area group); with several the page filters below.
  const oneArea = $derived(app.finishedArea);
  const words = $derived(
    app.filter.query
      .trim()
      .toLowerCase()
      .split(/\s+/)
      .filter((w) => w !== ''),
  );
  const shown = $derived(
    loaded.filter((item) => {
      if (oneArea === undefined && areas.length > 0 && !areas.includes(item.area)) return false;
      const text = `${item.id} ${item.title}`.toLowerCase();
      return words.every((w) => text.includes(w));
    }),
  );
  const nameOf = (name: string): string => (app.shortAreas ? areaLabel(name, app.allAreaNames) : name);

  async function load(query: { area?: string; since?: string; until?: string }, offset: number): Promise<void> {
    seq += 1;
    const mine = seq;
    loading = true;
    try {
      const next = await app.finished({ ...query, ...(offset > 0 ? { offset } : {}) });
      if (mine !== seq) return;
      doc = next;
      loaded = offset > 0 ? [...loaded, ...next.items] : next.items;
      problem = null;
    } catch (error) {
      if (mine !== seq) return;
      problem = error instanceof ApiError ? error.message : t('done.failed');
      if (offset === 0) {
        doc = null;
        loaded = [];
      }
    } finally {
      if (mine === seq) loading = false;
    }
  }

  const query = $derived({ ...(oneArea ? { area: oneArea } : {}), ...rangeOf(period, app.today, { from: '', to: '' }) });
  $effect(() => {
    const q = query;
    void app.snapshot?.rev;
    untrack(() => void load(q, 0));
  });
</script>

<section class="finished" aria-labelledby="finished-list-title">
  <div class="head">
    <h2 id="finished-list-title">{t('nav.done')}</h2>
    <label
      >{t('done.period')}
      <select value={period} onchange={(e) => (period = e.currentTarget.value as Preset)}>
        {#each PERIODS as p (p)}
          <option value={p}>{t(`done.preset.${p}` as Key)}</option>
        {/each}
      </select>
    </label>
  </div>
  {#if problem}
    <p class="problem" role="alert">{problem}</p>
  {:else if !doc}
    <p class="muted" role="status">{t('state.loading')}</p>
  {:else}
    <ul class="plain">
      {#each shown as item (item.file)}
        <li>
          <button type="button" class="open" onclick={() => (app.finishedPeek = item)}>
            <span class="when">{item.done ?? t('done.undated_row')}</span>
            <span class="title">{markHidden(item.title)}</span>
            <span class="muted">{markHidden(nameOf(item.area))}</span>
            {#if item.kind}<span class="muted">{labelOf(app.lang, 'kind', item.kind)}</span>{/if}
            {#if item.effort}<span class="muted">{item.effort}</span>{/if}
          </button>
        </li>
      {:else}
        <!-- The period had tasks, the areas or the words of the list keep them out: another sentence than "none".
             With one area the engine was asked for that area alone, so an empty answer says nothing of the others. -->
        <li class="muted">{t(loaded.length > 0 ? 'done.none_match' : oneArea !== undefined ? 'done.none_area' : 'done.none')}</li>
      {/each}
    </ul>
    <p class="muted" role="status">{t('list.count', { shown: shown.length, total: doc.total })}</p>
    {#if doc.next_offset !== undefined}
      <button type="button" disabled={loading} onclick={() => doc?.next_offset !== undefined && void load(query, doc.next_offset)}
        >{t('done.more')}</button
      >
    {/if}
  {/if}
</section>

<style>
  /* A block of its own under the list: a tinted ground and a bar at its side set it off from the open tasks. */
  .finished {
    margin: 1rem 0.5rem 0.5rem;
    padding: 0.75rem;
    background: var(--surface-2);
    border: 1px solid var(--border);
    border-left: 3px solid var(--accent);
    border-radius: var(--radius);
  }
  .head {
    display: flex;
    align-items: center;
    gap: 1rem;
    flex-wrap: wrap;
  }
  h2 {
    font-size: 0.8rem;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--muted);
    margin: 0;
  }
  .plain {
    list-style: none;
    padding: 0;
    margin: 0.5rem 0;
  }
  li {
    border-bottom: 1px solid var(--border);
  }
  li.muted {
    padding: 0.3rem 0;
  }
  .open {
    display: flex;
    flex-wrap: wrap;
    gap: 0.25rem 0.75rem;
    width: 100%;
    padding: 0.3rem 0;
    background: none;
    border: 0;
    color: inherit;
    font: inherit;
    text-align: left;
    cursor: pointer;
  }
  .open:hover {
    background: var(--surface);
  }
  .title {
    overflow-wrap: anywhere;
  }
  .when {
    font-variant-numeric: tabular-nums;
    color: var(--muted);
  }
  .muted {
    color: var(--muted);
  }
  .problem {
    color: var(--bad);
  }
</style>
