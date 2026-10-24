<script lang="ts">
  // The plan as a graph: the stages of the engine as rows (the first at the top, the tasks of a cycle last), the tasks'
  // own blocked_by (a solid arrow) and after (a dashed one) between them, the critical path drawn thick. Read only: a
  // click opens a task as in the stages. The keys walk the tasks (left and right in a row, up and down to the next
  // row); the dependencies stand once more as a table under the picture, for a screen reader and for a quick read.
  import type { App } from '../lib/app.svelte';
  import { criticalEdges, depGraphOf, neighbourOf, orderRows, type DepEdge } from '../lib/depGraph';
  import { hintOf, labelOf, translate, type Key } from '../lib/i18n';
  import type { Stage } from '../lib/plan';
  import { markHidden } from '../lib/text';

  let {
    app,
    stages,
    critical,
    path,
    cycles,
    onopen,
  }: {
    app: App;
    stages: readonly Stage[];
    critical: ReadonlySet<string>;
    path: readonly string[];
    cycles: readonly string[][];
    onopen: (id: string) => void;
  } = $props();

  const t = (key: Key, params: Record<string, string | number> = {}) => translate(app.lang, key, params);

  const graph = $derived(depGraphOf(stages));
  const rows = $derived(orderRows(graph.rows, graph.edges));
  const tasks = $derived(new Map(stages.flatMap((s) => s.tasks).map((task) => [task.id, task] as const)));
  const onPath = $derived(criticalEdges(path));

  // A row draws its first tasks; the rest on a press (a stage of hundreds is not one block of work, as in the stages).
  const FIRST = 50;
  let opened = $state<ReadonlySet<string>>(new Set());
  const rowKey = (stage: number | null): string => (stage === null ? 'cycle' : String(stage));
  const drawnRows = $derived(rows.map((r) => ({ ...r, ids: opened.has(rowKey(r.stage)) ? r.ids : r.ids.slice(0, FIRST) })));
  const drawnIds = $derived(new Set(drawnRows.flatMap((r) => r.ids)));

  // The one task the Tab key lands on (the others are reached with the arrow keys): the selected one, else the first.
  let focused = $state<string | null>(null);
  const tabStop = $derived(
    focused !== null && drawnIds.has(focused)
      ? focused
      : app.selectedId !== null && drawnIds.has(app.selectedId)
        ? app.selectedId
        : (drawnRows.find((r) => r.ids.length > 0)?.ids[0] ?? null),
  );

  let canvas: HTMLDivElement | undefined = $state();
  let size = $state({ w: 0, h: 0 });
  let lines = $state<{ edge: DepEdge; d: string; critical: boolean }[]>([]);

  /** The path of one arrow between two boxes (in the canvas's frame): down from the bottom to the top, else a bow. */
  function arrow(a: DOMRect, b: DOMRect, base: { left: number; top: number }): string {
    const ax = a.left + a.width / 2 - base.left;
    const bx = b.left + b.width / 2 - base.left;
    if (b.top >= a.bottom) {
      const y1 = a.bottom - base.top;
      const y2 = b.top - base.top;
      const dy = Math.max(12, (y2 - y1) / 2);
      return `M ${ax} ${y1} C ${ax} ${y1 + dy}, ${bx} ${y2 - dy}, ${bx} ${y2}`;
    }
    if (a.top >= b.bottom) {
      // Up (an `after` can point to an earlier row): from the top of the one to the bottom of the other.
      const y1 = a.top - base.top;
      const y2 = b.bottom - base.top;
      const dy = Math.max(12, (y1 - y2) / 2);
      return `M ${ax} ${y1} C ${ax} ${y1 - dy}, ${bx} ${y2 + dy}, ${bx} ${y2}`;
    }
    // In the same row: a bow above it, from the side of the one to the side of the other.
    const right = b.left >= a.right;
    const x1 = (right ? a.right : a.left) - base.left;
    const x2 = (right ? b.left : b.right) - base.left;
    const y = a.top - base.top + a.height / 3;
    return `M ${x1} ${y} C ${x1 + (right ? 24 : -24)} ${y - 36}, ${x2 + (right ? -24 : 24)} ${y - 36}, ${x2} ${y}`;
  }

  /** Measure the boxes as they are drawn and lay the arrows between them. */
  function layArrows(): void {
    if (!canvas) return;
    const frame = canvas.getBoundingClientRect();
    const base = { left: frame.left - canvas.scrollLeft, top: frame.top - canvas.scrollTop };
    const boxes = new Map<string, DOMRect>();
    for (const el of canvas.querySelectorAll<HTMLElement>('[data-node]')) boxes.set(el.dataset['node']!, el.getBoundingClientRect());
    lines = graph.edges.flatMap((edge) => {
      const a = boxes.get(edge.from);
      const b = boxes.get(edge.to);
      return a && b ? [{ edge, d: arrow(a, b, base), critical: edge.kind === 'blocked_by' && onPath.has(`${edge.from}>${edge.to}`) }] : [];
    });
    size = { w: canvas.scrollWidth, h: canvas.scrollHeight };
  }

  // After each drawing of the rows, and when the canvas changes its size (a wider window lets a row wrap less).
  $effect(() => {
    void drawnRows;
    void graph;
    layArrows();
  });
  $effect(() => {
    if (!canvas) return;
    const watch = new ResizeObserver(() => layArrows());
    watch.observe(canvas);
    return () => watch.disconnect();
  });

  function onNodeKey(e: KeyboardEvent, id: string): void {
    const keys: Record<string, 'left' | 'right' | 'up' | 'down'> = { ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'up', ArrowDown: 'down' };
    const dir = keys[e.key];
    if (dir === undefined) return;
    e.preventDefault();
    const next = neighbourOf(drawnRows, id, dir);
    if (next === null) return;
    focused = next;
    canvas?.querySelector<HTMLElement>(`[data-node="${CSS.escape(next)}"]`)?.focus();
  }

  const titleOf = (id: string): string => tasks.get(id)?.title ?? id;
  const rowName = (stage: number | null): string => (stage === null ? t('plan.no_stage') : t('plan.stage', { n: stage }));
</script>

<section class="graph" aria-label={t('graph.view')}>
  <p class="legend">{t('graph.legend')}</p>
  <div class="canvas" bind:this={canvas}>
    <svg class="arrows" aria-hidden="true" width={size.w} height={size.h} viewBox={`0 0 ${size.w} ${size.h}`}>
      <defs>
        <marker id="dep-head" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
          <path class="head" d="M 0 0 L 10 5 L 0 10 z" />
        </marker>
        <marker id="dep-head-critical" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
          <path class="head critical" d="M 0 0 L 10 5 L 0 10 z" />
        </marker>
      </defs>
      {#each lines as line (`${line.edge.kind}:${line.edge.from}>${line.edge.to}`)}
        <path
          class="line"
          class:soft={line.edge.kind === 'after'}
          class:critical={line.critical}
          data-edge={`${line.edge.from}>${line.edge.to}`}
          data-kind={line.edge.kind}
          d={line.d}
          marker-end={line.critical ? 'url(#dep-head-critical)' : 'url(#dep-head)'}
        />
      {/each}
    </svg>
    {#each drawnRows as row, r (rowKey(row.stage))}
      {@const all = rows[r]!.ids.length}
      <div class="row" class:cycle={row.stage === null} data-row={rowKey(row.stage)}>
        <h3 class="row-head">{rowName(row.stage)} ({all})</h3>
        {#if row.stage === null}
          {#each cycles as cycle, i (i)}<p class="cycle-note">{t('plan.cycle')}: <code>{markHidden(cycle.join(' → '))}</code></p>{/each}
        {/if}
        <div class="nodes">
          {#each row.ids as id (id)}
            {@const task = tasks.get(id)}
            {@const hidden = graph.hidden.get(id) ?? 0}
            <button
              type="button"
              class="node"
              class:critical={critical.has(id)}
              class:waiting={task?.readiness?.state === 'waiting' || task?.readiness?.state === 'stuck'}
              data-node={id}
              tabindex={id === tabStop ? 0 : -1}
              aria-current={id === app.selectedId ? 'true' : undefined}
              onfocus={() => (focused = id)}
              onkeydown={(e) => onNodeKey(e, id)}
              onclick={() => onopen(id)}
            >
              <span class="title">{markHidden(task?.title ?? id)}</span>
              <span class="meta">
                <span class="tag" data-hint={hintOf(app.lang, 'hint.status', task?.status ?? '')}>{labelOf(app.lang, 'status', task?.status)}</span>
                {#if task?.prio !== undefined}<span class="tag soft">P{task.prio}</span>{/if}
                {#if task?.effort}<span class="tag soft">{markHidden(task.effort)}</span>{/if}
                {#if hidden > 0}<span class="tag soft" data-hint={t('graph.hidden_hint')}>{t('graph.hidden', { n: hidden })}</span>{/if}
              </span>
              <span class="id">{id}</span>
            </button>
          {/each}
          {#if all > row.ids.length}
            <button type="button" class="more" onclick={() => (opened = new Set([...opened, rowKey(row.stage)]))}>
              {t('graph.more', { n: all - row.ids.length })}
            </button>
          {/if}
        </div>
      </div>
    {/each}
  </div>
  <details class="edges">
    <summary>{t('graph.edges', { n: graph.edges.length })}</summary>
    {#if graph.edges.length > 0}
      <table>
        <thead>
          <tr><th scope="col">{t('graph.col.waits')}</th><th scope="col">{t('graph.col.on')}</th><th scope="col">{t('graph.col.kind')}</th></tr>
        </thead>
        <tbody>
          {#each graph.edges as edge (`${edge.kind}:${edge.from}>${edge.to}`)}
            <tr>
              <td><button type="button" class="link" onclick={() => onopen(edge.to)}>{markHidden(titleOf(edge.to))}</button></td>
              <td><button type="button" class="link" onclick={() => onopen(edge.from)}>{markHidden(titleOf(edge.from))}</button></td>
              <td>{t(edge.kind === 'blocked_by' ? 'graph.kind.blocked_by' : 'graph.kind.after')}</td>
            </tr>
          {/each}
        </tbody>
      </table>
    {/if}
  </details>
</section>

<style>
  .graph {
    display: grid;
    gap: 0.5rem;
  }
  .legend {
    margin: 0;
    color: var(--muted);
    font-size: 0.85rem;
  }
  .canvas {
    position: relative;
    overflow: auto;
    max-height: 75vh;
    padding: 0.25rem 0.25rem 1rem;
    border: 1px solid var(--border);
    border-radius: var(--radius);
    background: var(--surface);
  }
  /* The arrows lie under the boxes: a box stays clickable where an arrow passes it. */
  .arrows {
    position: absolute;
    left: 0;
    top: 0;
    pointer-events: none;
    overflow: visible;
  }
  .line {
    fill: none;
    stroke: var(--muted);
    stroke-width: 1.5;
  }
  .line.soft {
    stroke-dasharray: 5 4;
  }
  .line.critical {
    stroke: var(--accent);
    stroke-width: 3;
  }
  .head {
    fill: var(--muted);
  }
  .head.critical {
    fill: var(--accent);
  }
  .row {
    position: relative;
    padding: 0.4rem 0.25rem 1.6rem;
  }
  .row.cycle {
    border: 1px dashed var(--bad);
    border-radius: var(--radius);
  }
  .row-head {
    margin: 0 0 0.35rem;
    font-size: 0.8rem;
    color: var(--muted);
    font-weight: 600;
  }
  .cycle-note {
    margin: 0 0 0.35rem;
    font-size: 0.8rem;
  }
  .nodes {
    display: flex;
    flex-wrap: wrap;
    gap: 1.2rem 1.5rem;
    align-items: flex-start;
  }
  .node {
    position: relative;
    display: grid;
    gap: 0.2rem;
    width: 13rem;
    text-align: left;
    padding: 0.4rem 0.5rem;
    border: 1px solid var(--border);
    border-radius: var(--radius);
    background: var(--surface-2);
    color: var(--text);
    cursor: pointer;
  }
  .node:hover,
  .node:focus-visible {
    border-color: var(--accent);
  }
  .node[aria-current='true'] {
    outline: 2px solid var(--accent);
    outline-offset: 1px;
  }
  .node.critical {
    border-color: var(--accent);
    border-width: 2px;
  }
  .node.waiting {
    opacity: 0.75;
  }
  .title {
    font-size: 0.85rem;
    overflow: hidden;
    text-overflow: ellipsis;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    -webkit-box-orient: vertical;
  }
  .meta {
    display: flex;
    flex-wrap: wrap;
    gap: 0.25rem;
  }
  .tag {
    font-size: 0.7rem;
    padding: 0 0.3rem;
    border: 1px solid var(--border);
    border-radius: 999px;
  }
  .tag.soft {
    color: var(--muted);
  }
  .id {
    font-size: 0.7rem;
    color: var(--muted);
    overflow-wrap: anywhere;
  }
  .more {
    align-self: center;
    background: none;
    border: 1px dashed var(--border);
    border-radius: var(--radius);
    color: var(--text);
    padding: 0.4rem 0.6rem;
    cursor: pointer;
  }
  .edges summary {
    cursor: pointer;
    color: var(--muted);
    font-size: 0.85rem;
  }
  .edges table {
    border-collapse: collapse;
    margin-top: 0.4rem;
  }
  .edges th,
  .edges td {
    border-bottom: 1px solid var(--border);
    padding: 0.2rem 0.6rem 0.2rem 0;
    text-align: left;
    font-size: 0.85rem;
  }
  .link {
    background: none;
    border: none;
    padding: 0;
    color: var(--accent);
    cursor: pointer;
    text-align: left;
  }
</style>
