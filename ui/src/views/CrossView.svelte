<script lang="ts">
  // The links between areas: which open task waits for or comes after an open task of another area, grouped by
  // the two areas. The areas chosen in the filter narrow it to the links between those.
  import type { App } from '../lib/app.svelte';
  import { areaLabel } from '../lib/filter';
  import { translate, type Key } from '../lib/i18n';
  import { areasOfPairs, crossEdges, pairsOf, pairsOfLinks, type CrossEdge } from '../lib/cross';
  import { markHidden } from '../lib/text';
  import Info from 'appkit-ui/Info.svelte';
  import MultiSelect from 'appkit-ui/MultiSelect.svelte';
  import AreaNet from './AreaNet.svelte';
  import SizeToggle from './SizeToggle.svelte';
  import { sizeable } from '../lib/sizeable';

  let { app }: { app: App } = $props();
  const t = (key: Key, params: Record<string, string | number> = {}) => translate(app.lang, key, params);

  // From the engine when it says (it finds refs and plans too); an engine without it leaves the two kinds of the list.
  // Only the links of this very state count; while the engine's answer is on its way nothing is read from the list.
  const doc = $derived(app.linksNow);
  const pending = $derived(app.linksPending);
  const allPairs = $derived(doc ? pairsOfLinks(doc) : pending ? [] : pairsOf(crossEdges(app.tasks)));
  const pairs = $derived(
    doc
      ? pairsOfLinks(doc, app.filter.areas)
      : pending
        ? []
        : pairsOf(crossEdges(app.tasks), app.filter.areas),
  );
  const areasWithLinks = $derived(new Set(pairs.flatMap((p) => [p.a, p.b])));
  const linkCount = $derived(pairs.reduce((sum, p) => sum + p.count, 0));
  // The matrix: a row and a column for every area that has a link; a cell is the number of links of the pair.
  const matrixAreas = $derived(areasOfPairs(pairs));
  const countOf = (x: string, y: string): number =>
    pairs.find((p) => (p.a === x && p.b === y) || (p.a === y && p.b === x))?.count ?? 0;
  // The guide lines of the matrix: the row and the column under the pointer (or the focus) are drawn to the number
  // and the numbers of the two grow, so that a long matrix can be read across. The way is kept in this browser.
  const GUIDE_KEY = 'tasks-desktop.cross.guide';
  const GUIDES = ['lines', 'dashed', 'cross', 'off'] as const;
  type Guide = (typeof GUIDES)[number];
  function storedGuide(): Guide {
    try {
      const v = localStorage.getItem(GUIDE_KEY);
      return GUIDES.find((g) => g === v) ?? 'lines';
    } catch {
      return 'lines';
    }
  }
  let guide = $state<Guide>(storedGuide());
  function setGuide(next: Guide): void {
    guide = next;
    try {
      localStorage.setItem(GUIDE_KEY, next);
    } catch {
      // A blocked store: the choice holds until the page is left.
    }
  }
  /** The row and the column the pointer or the focus is on, as positions in the matrix. */
  let hot = $state<{ r: number | null; c: number | null } | null>(null);
  function track(event: Event): void {
    const el = (event.target as Element | null)?.closest<HTMLElement>('[data-r],[data-c]');
    if (!el) return;
    const r = el.dataset['r'];
    const c = el.dataset['c'];
    // A header names only its row or its column: the other is none, so the guide runs along the one that is named.
    const next = { r: r !== undefined ? Number(r) : null, c: c !== undefined ? Number(c) : null };
    // The pointer moves inside a cell all the time: only a change of cell is drawn again (the matrix is n x n).
    if (hot && hot.r === next.r && hot.c === next.c) return;
    hot = next;
  }
  /** What a cell is to the guide lines: on the row up to the hot cell, on the column up to it, or the hot cell itself. */
  function guideOf(r: number, c: number): string {
    if (!hot || guide === 'off') return '';
    const full = guide === 'cross';
    const onRow = hot.r !== null && r === hot.r;
    const onCol = hot.c !== null && c === hot.c;
    // Up to the hot cell; along the whole line when only the row or the column is named (a header).
    const inRow = onRow && (full || hot.c === null || c <= hot.c);
    const inCol = onCol && (full || hot.r === null || r <= hot.r);
    return [inRow ? 'g-row' : '', inCol ? 'g-col' : '', onRow && onCol ? 'g-hot' : '', onRow || onCol ? 'g-near' : ''].join(' ');
  }

  /** The pairs that are open (a click on a cell of the matrix opens one). */
  let openKeys = $state<string[]>([]);
  const keyOf = (a: string, b: string): string => (a < b ? `${a}\u0000${b}` : `${b}\u0000${a}`);
  /** An element id for every pair (names of areas that differ in one character an id would replace stay apart). */
  const idOf = $derived(new Map(pairs.map((p, i) => [keyOf(p.a, p.b), `pair-${i}`])));
  const titles = $derived(new Map(app.tasks.map((task) => [task.id, task.title])));
  const areaOptions = $derived(
    areasOfPairs(allPairs)
      .map((name) => ({
        value: name,
        label: app.shortAreas ? areaLabel(name, app.allAreaNames) : name,
        title: name,
      }))
      .sort((x, y) => x.label.localeCompare(y.label)),
  );
  /** The key under which the size of the net tile is kept (with the other tiles, so it survives a reload). */
  const NET_TILE = 'cross-net';
  const netSize = $derived(app.tileSizes[NET_TILE] ?? null);
  const nameOf = (area: string): string => (app.shortAreas ? areaLabel(area, app.allAreaNames) : area);

  const KNOWN_KINDS = new Set<string>(['blocked_by', 'after', 'refs', 'plan']);
  function verb(edge: CrossEdge): string {
    // A kind a later engine adds is said in general words, not as a key.
    return t(KNOWN_KINDS.has(edge.kind) ? (`cross.kind.${edge.kind}` as Key) : 'cross.kind.other');
  }
  /** Open the pair a cell of the matrix is about and bring it into view. */
  function openPair(x: string, y: string): void {
    const key = keyOf(x, y);
    if (!openKeys.includes(key)) openKeys = [...openKeys, key];
    const id = idOf.get(key);
    const item = id ? document.getElementById(id) : null;
    item?.scrollIntoView({ block: 'nearest' });
    // The click moves on to the pair it opened (a keyboard user would otherwise stay in the matrix without a sign).
    item?.querySelector('summary')?.focus();
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

  {#if pending}
    <p class="muted" role="status">{t('state.loading')}</p>
  {:else if pairs.length === 0}
    <p class="muted">{app.filter.areas.length > 0 ? t('cross.none_chosen') : t('cross.none')}</p>
  {:else}
    {#if matrixAreas.length >= 2}
      <section class="card" aria-labelledby="cross-matrix-title">
        <div class="matrix-head">
          <h3 id="cross-matrix-title" class="eyebrow">{t('cross.matrix')}</h3>
          <label class="guide-pick" data-hint={t('hint.cross.guide')}>
            <span class="sr-only">{t('cross.guide')}</span>
            <select value={guide} aria-label={t('cross.guide')} onchange={(e) => setGuide(e.currentTarget.value as Guide)}>
              {#each GUIDES as g (g)}
                <option value={g}>{t(`cross.guide.${g}` as Key)}</option>
              {/each}
            </select>
          </label>
        </div>
        <div>
        <!-- A wide matrix scrolls in its own box, which the keyboard can reach. -->
        <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
        <div class="scroll" tabindex="0">
        <!-- The pointer and the focus only tell the guide lines where they are; the cells keep their own buttons. -->
        <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
        <table
          aria-labelledby="cross-matrix-title"
          class="guided guide-{guide}"
          onmouseover={track}
          onfocusin={track}
          onmouseleave={() => (hot = null)}
          onfocusout={() => (hot = null)}
        >
          <thead>
            <tr>
              <th scope="col"><span class="sr-only">{t('cross.matrix')}</span></th>
              {#each matrixAreas as col, ci (col)}
                <th scope="col" data-c={ci} class:g-near={hot?.c === ci && guide !== 'off'}>{markHidden(nameOf(col))}</th>
              {/each}
            </tr>
          </thead>
          <tbody>
            {#each matrixAreas as row, ri (row)}
              <tr>
                <th scope="row" data-r={ri} class:g-near={hot?.r === ri && guide !== 'off'}>{markHidden(nameOf(row))}</th>
                {#each matrixAreas as col, ci (col)}
                  <td class="num {guideOf(ri, ci)}" data-r={ri} data-c={ci}>
                    <span class="chip">
                    {#if row === col}
                      <span class="muted" aria-hidden="true">·</span>
                    {:else if row > col}
                      <!-- The matrix is symmetric: the pair is a button once, above the diagonal. -->
                      <span class="muted" aria-hidden="true"></span>
                    {:else if countOf(row, col) > 0}
                      <button
                        type="button"
                        class="link"
                        aria-label={t(countOf(row, col) === 1 ? 'cross.cell_one' : 'cross.cell', {
                          a: nameOf(row),
                          b: nameOf(col),
                          n: countOf(row, col),
                        })}
                        onclick={() => openPair(row, col)}>{countOf(row, col)}</button
                      >
                    {:else}
                      <span class="muted">0</span>
                    {/if}
                    </span>
                  </td>
                {/each}
              </tr>
            {/each}
          </tbody>
        </table>
        </div>
        </div>
      </section>

      <!-- The same pairs as a net, in a tile of its own: the matrix is the table of its numbers. -->
      <section
        class="card net-tile"
        aria-label={t('cross.net_tile')}
        data-tile="cross-net"
        use:sizeable={{
          size: netSize,
          active: app.sizing === NET_TILE,
          onsize: (size) => app.setTileSize(NET_TILE, size),
        }}
      >
        <header class="net-head">
          <h3 class="eyebrow">{t('cross.net_tile')}</h3>
          <SizeToggle
            lang={app.lang}
            what={t('size.net')}
            active={app.sizing === NET_TILE}
            sized={netSize !== null}
            ontoggle={() => app.toggleSizing(NET_TILE)}
            onreset={() => app.setTileSize(NET_TILE, null)}
          />
        </header>
        <div class="net-box">
          <AreaNet
            {pairs}
            areas={matrixAreas}
            {nameOf}
            label={t('cross.net')}
            edgeLabel={(a, b, n) => t(n === 1 ? 'cross.net_edge_one' : 'cross.net_edge', { a: nameOf(a), b: nameOf(b), n })}
            onopen={openPair}
            fill={netSize !== null}
          />
        </div>
      </section>
    {/if}

    <section class="card" aria-label={t('cross.pairs')}>
      <ul class="plain pairs">
        {#each pairs as pair (pair.a + '|' + pair.b)}
          <li id={idOf.get(keyOf(pair.a, pair.b))}>
            <details
              open={openKeys.includes(keyOf(pair.a, pair.b))}
              ontoggle={(e) => {
                const k = keyOf(pair.a, pair.b);
                const isOpen = openKeys.includes(k);
                if (e.currentTarget.open && !isOpen) openKeys = [...openKeys, k];
                else if (!e.currentTarget.open && isOpen) openKeys = openKeys.filter((x) => x !== k);
              }}
            >
              <summary>
                <span>{markHidden(nameOf(pair.a))} ↔ {markHidden(nameOf(pair.b))}</span>
                <span class="n">({pair.count})</span>
              </summary>
              <ul class="plain edges">
                {#each pair.edges as edge, i (i + '>' + edge.from + '>' + edge.kind + '>' + (edge.to ?? edge.ref ?? '') + '>' + edge.toArea)}
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
  .scroll {
    overflow-x: auto;
  }
  .net-tile {
    display: flex;
    flex-direction: column;
    /* A tile that was never sized takes the room of the layout; a sized one is the size the person gave it. */
    min-width: 0;
  }
  .net-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.5rem;
    margin-bottom: 0.5em;
  }
  .net-box {
    flex: 1;
    min-height: 0;
    min-width: 0;
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
  .matrix-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.5rem;
  }
  .guide-pick select {
    font: inherit;
    font-size: 0.8rem;
  }
  /* The numbers sit in the middle of their cells, so that the line of a column meets them from above. */
  .guided td.num {
    position: relative;
    text-align: center;
  }
  .guided thead th:not(:first-child) {
    text-align: center;
  }
  /* The number is a chip on the colour of the card: the lines run behind it, so they never strike it out. */
  .chip {
    position: relative;
    z-index: 1;
    display: inline-block;
    min-width: 1.4em;
    padding: 0 0.3em;
    background: var(--surface);
    transform-origin: center;
  }
  .guided th.g-near {
    color: var(--accent);
    font-weight: 600;
  }
  .guided td.g-row::before,
  .guided td.g-col::after {
    content: '';
    position: absolute;
    pointer-events: none;
  }
  .guided td.g-row::before {
    left: 0;
    right: 0;
    top: 50%;
    border-top: 1px solid var(--accent);
  }
  .guided td.g-col::after {
    top: 0;
    bottom: 0;
    left: 50%;
    border-left: 1px solid var(--accent);
  }
  /* The lines stop in the middle of the number's own cell: the row line comes from the left, the column line from above. */
  .guided:not(.guide-cross) td.g-hot::before {
    right: 50%;
  }
  .guided:not(.guide-cross) td.g-hot::after {
    bottom: 50%;
  }
  .guide-dashed td.g-row::before {
    border-top-style: dashed;
  }
  .guide-dashed td.g-col::after {
    border-left-style: dashed;
  }
  .guided td.g-near .chip {
    color: var(--accent);
    transform: scale(1.25);
  }
  .guided td.g-hot .chip {
    transform: scale(1.6);
    font-weight: 700;
  }
  @media (prefers-reduced-motion: no-preference) {
    .guided .chip {
      transition: transform 0.12s ease;
    }
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
