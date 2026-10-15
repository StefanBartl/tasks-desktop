<script lang="ts">
  // The links between areas: which open task waits for or comes after an open task of another area, grouped by
  // the two areas. The areas chosen in the filter narrow it to the links between those.
  import type { App } from '../lib/app.svelte';
  import { areaLabel } from '../lib/filter';
  import { translate, type Key } from '../lib/i18n';
  import { areasOfPairs, crossEdges, pairsOf, pairsOfLinks, type CrossEdge } from '../lib/cross';
  import { markHidden } from '../lib/text';
  import Info from './Info.svelte';
  import MultiSelect from './MultiSelect.svelte';

  let { app }: { app: App } = $props();
  const t = (key: Key, params: Record<string, string | number> = {}) => translate(app.lang, key, params);

  // From the engine when it says (it finds refs and plans too); an engine without it leaves the two kinds of the list.
  const allPairs = $derived(app.links ? pairsOfLinks(app.links) : pairsOf(crossEdges(app.tasks)));
  const pairs = $derived(
    app.links ? pairsOfLinks(app.links, app.filter.areas) : pairsOf(crossEdges(app.tasks), app.filter.areas),
  );
  const areasWithLinks = $derived(new Set(pairs.flatMap((p) => [p.a, p.b])));
  const linkCount = $derived(pairs.reduce((sum, p) => sum + p.count, 0));
  // The matrix: a row and a column for every area that has a link; a cell is the number of links of the pair.
  const matrixAreas = $derived(areasOfPairs(pairs));
  const countOf = (x: string, y: string): number =>
    pairs.find((p) => (p.a === x && p.b === y) || (p.a === y && p.b === x))?.count ?? 0;
  /** The pair that is open (a click on a cell of the matrix opens it). */
  let openKey = $state<string | null>(null);
  const keyOf = (a: string, b: string): string => (a < b ? `${a}\u0000${b}` : `${b}\u0000${a}`);
  const titles = $derived(new Map(app.tasks.map((task) => [task.id, task.title])));
  const areaOptions = $derived(
    areasOfPairs(allPairs)
      .map((name) => ({
        value: name,
        label: app.shortAreas ? areaLabel(name, app.areaNames) : name,
        title: name,
      }))
      .sort((x, y) => x.label.localeCompare(y.label)),
  );
  const nameOf = (area: string): string => (app.shortAreas ? areaLabel(area, app.areaNames) : area);

  function verb(edge: CrossEdge): string {
    return t(`cross.kind.${edge.kind}` as Key);
  }
  /** Open the pair a cell of the matrix is about and bring it into view. */
  function openPair(x: string, y: string): void {
    openKey = keyOf(x, y);
    document.getElementById(`pair-${keyOf(x, y).replace(/\W/g, '_')}`)?.scrollIntoView({ block: 'nearest' });
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
    {#if matrixAreas.length >= 2}
      <section class="card" aria-labelledby="cross-matrix-title">
        <h3 id="cross-matrix-title" class="eyebrow">{t('cross.matrix')}</h3>
        <table>
          <thead>
            <tr>
              <td></td>
              {#each matrixAreas as col (col)}
                <th scope="col">{markHidden(nameOf(col))}</th>
              {/each}
            </tr>
          </thead>
          <tbody>
            {#each matrixAreas as row (row)}
              <tr>
                <th scope="row">{markHidden(nameOf(row))}</th>
                {#each matrixAreas as col (col)}
                  <td class="num">
                    {#if row === col}
                      <span class="muted" aria-hidden="true">·</span>
                    {:else if countOf(row, col) > 0}
                      <button
                        type="button"
                        class="link"
                        aria-label={t('cross.cell', { a: nameOf(row), b: nameOf(col), n: countOf(row, col) })}
                        onclick={() => openPair(row, col)}>{countOf(row, col)}</button
                      >
                    {:else}
                      <span class="muted">0</span>
                    {/if}
                  </td>
                {/each}
              </tr>
            {/each}
          </tbody>
        </table>
      </section>
    {/if}

    <section class="card" aria-label={t('cross.pairs')}>
      <ul class="plain pairs">
        {#each pairs as pair (pair.a + '|' + pair.b)}
          <li id={`pair-${keyOf(pair.a, pair.b).replace(/\W/g, '_')}`}>
            <details
              open={openKey === keyOf(pair.a, pair.b)}
              ontoggle={(e) => {
                const k = keyOf(pair.a, pair.b);
                if (e.currentTarget.open) openKey = k;
                else if (openKey === k) openKey = null;
              }}
            >
              <summary>
                <span>{markHidden(nameOf(pair.a))} ↔ {markHidden(nameOf(pair.b))}</span>
                <span class="n">({pair.count})</span>
              </summary>
              <ul class="plain edges">
                {#each pair.edges as edge (edge.from + '>' + edge.kind + '>' + (edge.to ?? edge.ref ?? '') + '>' + edge.toArea)}
                  <li>
                    <button type="button" class="link" onclick={() => open(edge.from)}
                      >{markHidden(titles.get(edge.from) ?? edge.from)}</button
                    >
                    <span class="muted"> {verb(edge)} </span>
                    {#if edge.kind === 'refs'}
                      <span>{markHidden(edge.ref ?? '')}</span>
                    {:else if edge.kind === 'plan'}
                      <span>{markHidden(edge.to ?? '')}</span>
                      <span class="muted">({markHidden(nameOf(edge.toArea))})</span>
                    {:else if edge.to}
                      {@const target = edge.to}
                      <button type="button" class="link" onclick={() => open(target)}
                        >{markHidden(titles.get(target) ?? target)}</button
                      >
                    {/if}
                  </li>
                {/each}
                {#if pair.edges.length < pair.count}
                  <li class="muted">{t('cross.cut', { shown: pair.edges.length, total: pair.count })}</li>
                {/if}
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
  table {
    border-collapse: collapse;
  }
  th,
  td {
    padding: 0.2rem 0.6rem 0.2rem 0;
    text-align: left;
    font-weight: normal;
  }
  thead th {
    color: var(--muted);
    font-size: 0.8rem;
  }
  .num {
    text-align: right;
    font-variant-numeric: tabular-nums;
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
