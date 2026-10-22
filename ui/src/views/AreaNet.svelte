<script lang="ts">
  // The net of the areas beside the matrix: the same pairs and the same numbers, as points and lines. A line is a button
  // (the keys reach it, Enter or Space opens the pair as a cell of the matrix does); its number stands on it, so neither
  // colour nor thickness alone says how many links there are. The matrix next to it is the table of these numbers.
  import type { Pair } from '../lib/cross';
  import { netLayout } from '../lib/net';
  import { markHidden } from '../lib/text';

  let {
    pairs,
    areas,
    nameOf,
    label,
    edgeLabel,
    onopen,
  }: {
    pairs: readonly Pair[];
    areas: readonly string[];
    nameOf: (area: string) => string;
    /** The name of the net for assistive software. */
    label: string;
    /** The words of a line: its two areas and its number, and that it opens them. */
    edgeLabel: (a: string, b: string, n: number) => string;
    onopen: (a: string, b: string) => void;
  } = $props();

  const SIZE = 320;
  const MARGIN = 70;
  const net = $derived(netLayout(areas, pairs, SIZE, MARGIN));

  function onKey(event: KeyboardEvent, a: string, b: string): void {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    onopen(a, b);
  }

  /** Where the name of an area stands: outside the circle, on the side the area is. */
  const anchorOf = (x: number): 'start' | 'middle' | 'end' => (x < SIZE / 2 - 1 ? 'end' : x > SIZE / 2 + 1 ? 'start' : 'middle');
  const dx = (x: number): number => (x < SIZE / 2 - 1 ? -10 : x > SIZE / 2 + 1 ? 10 : 0);
  const dy = (y: number, x: number): number => (Math.abs(x - SIZE / 2) <= 1 ? (y < SIZE / 2 ? -12 : 20) : 4);
</script>

<svg class="net" viewBox="0 0 {SIZE} {SIZE}" role="group" aria-label={label}>
  {#each net.edges as edge (`${edge.a}|${edge.b}`)}
    <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
    <g
      class="edge"
      role="button"
      tabindex="0"
      aria-label={edgeLabel(edge.a, edge.b, edge.count)}
      onclick={() => onopen(edge.a, edge.b)}
      onkeydown={(e) => onKey(e, edge.a, edge.b)}
    >
      <!-- A wide line that cannot be seen makes the thin ones easy to hit. -->
      <line class="hit" x1={edge.x1} y1={edge.y1} x2={edge.x2} y2={edge.y2} />
      <line class="line" x1={edge.x1} y1={edge.y1} x2={edge.x2} y2={edge.y2} stroke-width={edge.width} />
      <circle class="badge" cx={edge.mx} cy={edge.my} r="11" />
      <text class="count" x={edge.mx} y={edge.my} dy="4" text-anchor="middle" aria-hidden="true">{edge.count}</text>
    </g>
  {/each}
  {#each net.nodes as node (node.area)}
    <g class="node" aria-hidden="true">
      <circle cx={node.x} cy={node.y} r="6" />
      <text x={node.x + dx(node.x)} y={node.y + dy(node.y, node.x)} text-anchor={anchorOf(node.x)}>{markHidden(nameOf(node.area))}</text>
    </g>
  {/each}
</svg>

<style>
  .net {
    width: 100%;
    max-width: 24rem;
    height: auto;
    overflow: visible;
  }
  .line {
    stroke: var(--muted);
    stroke-linecap: round;
  }
  .hit {
    stroke: transparent;
    stroke-width: 16;
  }
  .edge {
    cursor: pointer;
  }
  .edge:hover .line,
  .edge:focus-visible .line {
    stroke: var(--accent);
  }
  .edge:focus {
    outline: none;
  }
  .edge:focus-visible .badge {
    stroke: var(--accent);
    stroke-width: 2.5;
  }
  .badge {
    fill: var(--surface);
    stroke: var(--line);
  }
  .count {
    fill: var(--text);
    font-size: 11px;
    font-variant-numeric: tabular-nums;
  }
  .node circle {
    fill: var(--text);
  }
  .node text {
    fill: var(--text);
    font-size: 12px;
  }
</style>
