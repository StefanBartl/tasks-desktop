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
  /** Where the number stands: the middle of the line, or nearer an end where another number stands in the middle. */
  mx: number;
  my: number;
  /** The width of the line: from `MIN_WIDTH` for the fewest links to `MAX_WIDTH` for the most. */
  width: number;
}

export const MIN_WIDTH = 1.5;
export const MAX_WIDTH = 8;
/** The radius of the disc the number of a line stands on. */
export const BADGE_RADIUS = 11;

/** Where on a line its number may stand, tried in this order: the middle first, then nearer one end or the other. */
const SPOTS = [0.5, 0.35, 0.65, 0.25, 0.75, 0.2, 0.8];

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
  // The lines between areas facing each other all cross the centre: their numbers would lie on one another.
  const placed: { x: number; y: number }[] = [];
  const free = (x: number, y: number): boolean => placed.every((b) => Math.hypot(b.x - x, b.y - y) >= 2 * BADGE_RADIUS + 2);
  for (const p of pairs) {
    const from = at.get(p.a);
    const to = at.get(p.b);
    if (!from || !to || p.count <= 0) continue;
    const share = max === min ? 1 : (p.count - min) / (max - min);
    const point = (t: number) => ({ x: round(from.x + t * (to.x - from.x)), y: round(from.y + t * (to.y - from.y)) });
    const spot = SPOTS.map(point).find((b) => free(b.x, b.y)) ?? point(0.5);
    placed.push(spot);
    edges.push({
      a: p.a,
      b: p.b,
      count: p.count,
      x1: from.x,
      y1: from.y,
      x2: to.x,
      y2: to.y,
      mx: spot.x,
      my: spot.y,
      width: round(MIN_WIDTH + share * (MAX_WIDTH - MIN_WIDTH)),
    });
  }
  return { nodes, edges };
}

function round(n: number): number {
  return Math.round(n * 10) / 10;
}
