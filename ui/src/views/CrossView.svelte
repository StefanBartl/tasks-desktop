<script lang="ts">
  // The links between areas: which open task waits for or comes after an open task of another area, grouped by
  // the two areas. The areas chosen in the filter narrow it to the links between those.
  import type { App } from '../lib/app.svelte';
  import { areaLabel } from '../lib/filter';
  import { translate, type Key } from '../lib/i18n';
  import { crossEdges, pairsOf, type CrossEdge } from '../lib/cross';
  import { markHidden } from '../lib/text';
  import Info from './Info.svelte';
  import MultiSelect from './MultiSelect.svelte';

  let { app }: { app: App } = $props();
  const t = (key: Key, params: Record<string, string | number> = {}) => translate(app.lang, key, params);

  const edges = $derived(crossEdges(app.tasks));
  const pairs = $derived(pairsOf(edges, app.filter.areas));
  const areasWithLinks = $derived(new Set(pairs.flatMap((p) => [p.a, p.b])));
  const linkCount = $derived(pairs.reduce((sum, p) => sum + p.edges.length, 0));
  const titles = $derived(new Map(app.tasks.map((task) => [task.id, task.title])));
  const areaOptions = $derived(
    [...new Set(edges.flatMap((e) => [e.fromArea, e.toArea]))]
      .map((name) => ({
        value: name,
        label: app.shortAreas ? areaLabel(name, app.areaNames) : name,
        title: name,
      }))
      .sort((x, y) => x.label.localeCompare(y.label)),
  );
  const nameOf = (area: string): string => (app.shortAreas ? areaLabel(area, app.areaNames) : area);

  function verb(edge: CrossEdge): string {
    return edge.kind === 'blocked_by' ? t('cross.waits') : t('cross.after');
  }
  function open(id: string): void {
    app.reveal(id);
  }
  /** The list, narrowed to the tasks that connect the areas (the chosen ones, or any). */
  function showInList(): void {
    app.filter = { ...app.filter, cross: true };
    app.setView('list');
  }
</script>

<div class="cross">
  <section class="card head" aria-label={t('cross.summary_label')}>
    <div class="headline">
      <h2 class="eyebrow">{t('nav.cross')}</h2>
      <Info hint={t('hint.cross')} label={t('hint.about', { what: t('nav.cross') })} />
    </div>
    <div class="bar">
      <MultiSelect
        label={t('nav.areas')}
        options={areaOptions}
        selected={app.filter.areas}
        onchange={(areas) => (app.filter = { ...app.filter, areas })}
        resetLabel={t('multi.reset')}
        searchLabel={t('multi.search')}
      />
      <button type="button" class="linkish" disabled={pairs.length === 0} onclick={showInList}
        >{t('cross.show_list')}</button
      >
    </div>
    {#if pairs.length > 0}
      <p class="muted" role="status">
        {linkCount === 1
          ? t('cross.summary_one', { areas: areasWithLinks.size })
          : t('cross.summary', { links: linkCount, areas: areasWithLinks.size })}
      </p>
    {/if}
  </section>

  {#if pairs.length === 0}
    <p class="muted">{app.filter.areas.length > 0 ? t('cross.none_chosen') : t('cross.none')}</p>
  {:else}
    <section class="card" aria-label={t('cross.pairs')}>
      <ul class="plain pairs">
        {#each pairs as pair (pair.a + '|' + pair.b)}
          <li>
            <details>
              <summary>
                <span>{markHidden(nameOf(pair.a))} ↔ {markHidden(nameOf(pair.b))}</span>
                <span class="n">({pair.edges.length})</span>
              </summary>
              <ul class="plain edges">
                {#each pair.edges as edge (edge.from + '>' + edge.to + edge.kind)}
                  <li>
                    <button type="button" class="link" onclick={() => open(edge.from)}
                      >{markHidden(titles.get(edge.from) ?? edge.from)}</button
                    >
                    <span class="muted"> {verb(edge)} </span>
                    <button type="button" class="link" onclick={() => open(edge.to)}
                      >{markHidden(titles.get(edge.to) ?? edge.to)}</button
                    >
                  </li>
                {/each}
              </ul>
            </details>
          </li>
        {/each}
      </ul>
    </section>
  {/if}
</div>

<style>
  .cross {
    display: grid;
    gap: 1rem;
    align-content: start;
  }
  .card {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 0.9rem 1rem;
  }
  .headline {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    margin-bottom: 0.5em;
  }
  .eyebrow {
    font-size: 0.8rem;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--muted);
    margin: 0;
  }
  .bar {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.5rem 1rem;
  }
  .muted {
    color: var(--muted);
  }
  .edges {
    margin: 0.4rem 0 0.2rem;
    display: grid;
    gap: 0.25rem;
  }
  .plain {
    list-style: none;
    padding: 0;
    margin: 0;
  }
  .pairs > li {
    padding: 0.35rem 0;
    border-bottom: 1px solid var(--border);
  }
  .pairs > li:last-child {
    border-bottom: 0;
  }
  summary {
    cursor: pointer;
  }
  .n {
    color: var(--muted);
  }
  .link {
    background: none;
    border: 0;
    padding: 0;
    color: var(--accent);
    cursor: pointer;
    text-align: left;
  }
  .linkish {
    background: none;
    border: none;
    color: var(--accent);
    cursor: pointer;
    padding: 0;
  }
  .linkish:disabled {
    color: var(--muted);
    cursor: default;
  }
</style>
