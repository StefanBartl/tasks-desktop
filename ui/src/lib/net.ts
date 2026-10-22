// The net of the areas: every area that has a link is a point on a circle, every pair of areas with links is a line
// between them, as thick as it has links (and the number stands on it, so no colour and no thickness alone says it). The
// numbers are the engine's (the pairs of `tasks.links`); this only lays them out.

import type { Pair } from './cross';

export interface NetNode {
  area: string;
  x: number;
  y: number;
}

export interface NetEdge {
  a: string;
  b: string;
  count: number;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  /** Where the number stands: the middle of the line. */
  mx: number;
  my: number;
  /** The width of the line: from `MIN_WIDTH` for the fewest links to `MAX_WIDTH` for the most. */
  width: number;
}

export const MIN_WIDTH = 1.5;
export const MAX_WIDTH = 8;

/**
 * The net in a square of `size`: the areas (sorted) on a circle that leaves `margin` for their names, the first at the
 * top, then clockwise; one line per pair. One area is the middle; two face each other left and right.
 */
export function netLayout(areas: readonly string[], pairs: readonly Pair[], size: number, margin: number): { nodes: NetNode[]; edges: NetEdge[] } {
  const sorted = [...areas].sort((x, y) => x.localeCompare(y));
  const c = size / 2;
  const r = Math.max(0, c - margin);
  const nodes: NetNode[] = sorted.map((area, i) => {
    if (sorted.length === 1) return { area, x: c, y: c };
    // Two areas side by side read better than one above the other.
    const start = sorted.length === 2 ? -Math.PI : -Math.PI / 2;
    const angle = start + (2 * Math.PI * i) / sorted.length;
    return { area, x: round(c + r * Math.cos(angle)), y: round(c + r * Math.sin(angle)) };
  });
  const at = new Map(nodes.map((n) => [n.area, n]));
  const max = Math.max(1, ...pairs.map((p) => p.count));
  const min = Math.min(max, ...pairs.map((p) => p.count));
  const edges: NetEdge[] = [];
  for (const p of pairs) {
    const from = at.get(p.a);
    const to = at.get(p.b);
    if (!from || !to || p.count <= 0) continue;
    const share = max === min ? 1 : (p.count - min) / (max - min);
    edges.push({
      a: p.a,
      b: p.b,
      count: p.count,
      x1: from.x,
      y1: from.y,
      x2: to.x,
      y2: to.y,
      mx: round((from.x + to.x) / 2),
      my: round((from.y + to.y) / 2),
      width: round(MIN_WIDTH + share * (MAX_WIDTH - MIN_WIDTH)),
    });
  }
  return { nodes, edges };
}

function round(n: number): number {
  return Math.round(n * 10) / 10;
}
