<script lang="ts">
  // The plan as a dependency graph: tasks in rows (the engine's stage), arrows for blocked_by (solid) and after
  // (dashed) between them. The rows and edges are a pure function of the tasks already loaded for the stage view
  // (lib/depGraph.ts); this only draws them and lets the keyboard walk them. The arrows are an SVG overlay placed
  // from the tiles' own positions, read after every render and again when the graph's box changes size - nothing
  // here lays the tiles out itself, the flow of the rows does that.
  import { tick } from 'svelte';
  import type { App } from '../lib/app.svelte';
  import type { TaskEntry } from '../lib/contract';
  import { layoutGraph, type Graph } from '../lib/depGraph';
  import { hintOf, labelOf, translate, type Key } from '../lib/i18n';
  import { markHidden } from '../lib/text';
  import { planGraphLegend } from '../lib/legend';
  import Info from 'appkit-ui/Info.svelte';

  let { app, planId, tasks }: { app: App; planId: string; tasks: readonly TaskEntry[] } = $props();
  const t = (key: Key, params: Record<string, string | number> = {}) => translate(app.lang, key, params);

  const members = $derived.by(() => {
    const out = new Map<string, TaskEntry>();
    for (const task of tasks) if (planId === '' || task.plan === planId) out.set(task.id, task);
    return out;
  });
  const graph = $derived<Graph>(layoutGraph(tasks, planId === '' ? null : planId));
  const critical = $derived(new Set(app.snapshot?.plan.critical_path.path ?? []));

  // Positions of the tiles, read from the DOM (not kept in any state the layout computes): the flow lays them out,
  // this only measures where they ended up, relative to the box the arrows are drawn in.
  let box: HTMLElement | undefined = $state();
  let rects = $state(new Map<string, { x: number; y: number; w: number; h: number }>());

  function measure(): void {
    if (!box) return;
    const outer = box.getBoundingClientRect();
    const next = new Map<string, { x: number; y: number; w: number; h: number }>();
    for (const el of box.querySelectorAll<HTMLElement>('button.tile')) {
      const id = el.dataset.id;
      if (!id) continue;
      const r = el.getBoundingClientRect();
      next.set(id, { x: r.left - outer.left, y: r.top - outer.top, w: r.width, h: r.height });
    }
    rects = next;
  }

  $effect(() => {
    // Re-measure whenever the rows themselves change (a different plan, the vault changed under it): after the
    // tiles have painted, not before (`tick`, then a frame for layout to settle).
    void graph;
    let frame = 0;
    void tick().then(() => {
      frame = requestAnimationFrame(measure);
    });
    return () => cancelAnimationFrame(frame);
  });

  $effect(() => {
    if (!box) return;
    const ro = new ResizeObserver(() => measure());
    ro.observe(box);
    return () => ro.disconnect();
  });

  // A curve from one tile to another: forward (the usual case, the row of `to` at or after the row of `from`) runs
  // bottom-to-top; backward or within the same row (an `after` edge does not have to go down a stage) arcs to the
  // side instead, so it is not drawn through the tiles between them.
  function pathFor(from: string, to: string): string | null {
    const a = rects.get(from);
    const b = rects.get(to);
    if (!a || !b) return null;
    if (Math.abs(a.y - b.y) < 1) {
      const y = a.y;
      const x1 = a.x + a.w / 2;
      const x2 = b.x + b.w / 2;
      const arc = y - 14;
      return `M ${x1} ${y} C ${x1} ${arc}, ${x2} ${arc}, ${x2} ${y}`;
    }
    const forward = b.y > a.y;
    const x1 = a.x + a.w / 2;
    const x2 = b.x + b.w / 2;
    const y1 = forward ? a.y + a.h : a.y;
    const y2 = forward ? b.y : b.y + b.h;
    const mid = (y1 + y2) / 2;
    return `M ${x1} ${y1} C ${x1} ${mid}, ${x2} ${mid}, ${x2} ${y2}`;
  }

  // One focusable tile at a time (roving tabindex): the grid is one tab stop, the arrow keys walk inside it.
  let current = $state<string | null>(null);
  $effect(() => {
    const first = graph.rows[0]?.ids[0] ?? null;
    if (current === null || !members.has(current)) current = first;
  });

  function focusTile(id: string): void {
    current = id;
    box?.querySelector<HTMLButtonElement>(`button.tile[data-id="${id}"]`)?.focus();
  }

  function onKey(event: KeyboardEvent, rowIndex: number, colIndex: number): void {
    const row = graph.rows[rowIndex];
    if (!row) return;
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      const next = row.ids[colIndex + (event.key === 'ArrowRight' ? 1 : -1)];
      if (next) {
        event.preventDefault();
        focusTile(next);
      }
    } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      const targetRow = graph.rows[rowIndex + (event.key === 'ArrowDown' ? 1 : -1)];
      if (!targetRow) return;
      event.preventDefault();
      const x = (rects.get(row.ids[colIndex] ?? '')?.x ?? 0) + (rects.get(row.ids[colIndex] ?? '')?.w ?? 0) / 2;
      let best = targetRow.ids[0];
      let bestDist = Infinity;
      for (const id of targetRow.ids) {
        const r = rects.get(id);
        const dist = r ? Math.abs(r.x + r.w / 2 - x) : Infinity;
        if (dist < bestDist) {
          bestDist = dist;
          best = id;
        }
      }
      if (best) focusTile(best);
    }
  }

  const rowName = (row: number | null): string => (row === null ? t('plan.no_stage') : t('plan.stage', { n: row }));
</script>

<div class="dep-graph">
  <div class="title-row">
    <h3 class="eyebrow">{t('plan.graph.title')}</h3>
    <Info hint={planGraphLegend(app.lang)} label={t('hint.about', { what: t('plan.graph.title') })} />
  </div>
  <div class="box" bind:this={box}>
    <!-- The arrows are decoration of the tiles' own relation; the edge list below says the same thing in words. -->
    <svg class="arrows" aria-hidden="true" focusable="false">
      <defs>
        <marker id="dep-arrow-hard" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
          <path d="M0,0 L8,4 L0,8 Z" fill="var(--text)" />
        </marker>
        <marker id="dep-arrow-soft" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
          <path d="M0,0 L8,4 L0,8 Z" fill="var(--muted)" />
        </marker>
      </defs>
      {#each graph.edges as edge, i (i)}
        {@const d = pathFor(edge.from, edge.to)}
        {#if d}
          <path
            {d}
            class="edge"
            class:hard={edge.kind === 'blocked_by'}
            class:soft={edge.kind === 'after'}
            data-from={edge.from}
            data-to={edge.to}
            marker-end={edge.kind === 'blocked_by' ? 'url(#dep-arrow-hard)' : 'url(#dep-arrow-soft)'}
          />
        {/if}
      {/each}
    </svg>
    <div class="rows">
      {#each graph.rows as row, ri (row.row ?? 'cycle')}
        <div class="row" class:cycle={row.row === null} data-row={row.row ?? 'cycle'}>
          <span class="row-label">{rowName(row.row)}</span>
          <div class="tiles">
            {#each row.ids as id, ci (id)}
              {@const task = members.get(id)}
              {#if task}
                <button
                  type="button"
                  class="tile"
                  class:crit={critical.has(id)}
                  data-id={id}
                  tabindex={current === id ? 0 : -1}
                  onkeydown={(e) => onKey(e, ri, ci)}
                  onfocus={() => (current = id)}
                  onclick={() => app.peek(id)}
                >
                  <span class="title">{markHidden(task.title)}</span>
                  <span class="id">{id}</span>
                  <span class="meta">
                    {#if task.status}<span class="tag" data-hint={hintOf(app.lang, 'hint.status', task.status)}>{labelOf(app.lang, 'status', task.status)}</span>{/if}
                    {#if task.readiness?.state && task.readiness.state !== 'ready'}
                      <span class="tag soft" data-hint={hintOf(app.lang, 'hint.state', task.readiness.state)}>{labelOf(app.lang, 'state', task.readiness.state)}</span>
                    {/if}
                    {#if critical.has(id)}<span class="tag crit" data-hint={t('hint.critical')}>{t('plan.on_path')}</span>{/if}
                  </span>
                </button>
              {/if}
            {/each}
          </div>
        </div>
      {/each}
    </div>
  </div>
  {#if graph.rows.length === 0}
    <p class="muted">{t('plan.empty')}</p>
  {:else}
    <details class="edges">
      <summary>{t('plan.graph.edges')} ({graph.edges.length})</summary>
      {#if graph.edges.length === 0}
        <p class="muted">{t('plan.graph.no_edges')}</p>
      {:else}
        <ul class="plain">
          {#each graph.edges as edge, i (i)}
            {@const from = markHidden(members.get(edge.from)?.title ?? edge.from)}
            {@const to = markHidden(members.get(edge.to)?.title ?? edge.to)}
            <li>
              {t(edge.kind === 'blocked_by' ? 'plan.graph.edge.hard' : 'plan.graph.edge.soft', { from, to })}
              <span class="tag soft">{edge.kind}</span>
            </li>
          {/each}
        </ul>
      {/if}
    </details>
  {/if}
</div>

<style>
  .dep-graph {
    display: grid;
    gap: 0.5rem;
  }
  .title-row {
    display: flex;
    align-items: center;
    gap: 0.4rem;
  }
  .eyebrow {
    font-size: 0.8rem;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--muted);
    margin: 0;
  }
  .box {
    position: relative;
  }
  .arrows {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    overflow: visible;
    pointer-events: none;
  }
  .edge {
    fill: none;
    stroke-width: 1.5;
  }
  .edge.hard {
    stroke: var(--text);
  }
  .edge.soft {
    stroke: var(--muted);
    stroke-dasharray: 4 3;
  }
  .rows {
    position: relative;
    display: grid;
    gap: 1.75rem;
  }
  .row {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    flex-wrap: wrap;
  }
  .row-label {
    flex: 0 0 auto;
    min-width: 6rem;
    color: var(--muted);
    font-size: 0.8rem;
  }
  .row.cycle .row-label {
    color: var(--warn);
  }
  .tiles {
    display: flex;
    flex-wrap: wrap;
    gap: 0.6rem;
    flex: 1;
  }
  .tile {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 0.4rem 0.6rem;
    text-align: left;
    color: var(--text);
    cursor: pointer;
    display: flex;
    flex-direction: column;
    gap: 0.15rem;
    min-width: 8rem;
    max-width: 16rem;
  }
  .tile.crit {
    border-color: var(--accent);
    border-width: 2px;
  }
  .tile:focus-visible {
    outline: 2px solid var(--focus, var(--accent));
    outline-offset: 2px;
  }
  .title {
    font-weight: 600;
    font-size: 0.9rem;
  }
  .id {
    font-family: var(--mono);
    font-size: 0.7rem;
    color: var(--muted);
  }
  .meta {
    display: flex;
    flex-wrap: wrap;
    gap: 0.25rem;
    margin-top: 0.15rem;
  }
  .tag {
    font-size: 0.7rem;
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 0 0.3rem;
  }
  .tag.soft {
    color: var(--muted);
  }
  .tag.crit {
    border-color: var(--accent);
    color: var(--accent);
  }
  .edges {
    font-size: 0.85rem;
  }
  .edges summary {
    cursor: pointer;
    color: var(--muted);
  }
  .plain {
    list-style: none;
    margin: 0.3rem 0 0;
    padding: 0;
  }
  .plain li {
    padding: 0.2rem 0;
    border-bottom: 1px solid var(--border);
    display: flex;
    align-items: baseline;
    gap: 0.4rem;
  }
  .plain li:last-child {
    border-bottom: 0;
  }
  .muted {
    color: var(--muted);
  }
</style>
