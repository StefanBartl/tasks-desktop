import { describe, expect, it } from 'vitest';
import type { Pair } from './cross';
import { BADGE_RADIUS, MAX_WIDTH, MIN_WIDTH, netLayout } from './net';

const pair = (a: string, b: string, count: number): Pair => ({ a, b, count, edges: [] });

describe('the net of the areas', () => {
  it('puts the areas on a circle, sorted, the first at the top', () => {
    const { nodes } = netLayout(['c', 'a', 'b', 'd'], [], 200, 40);
    expect(nodes.map((n) => n.area)).toEqual(['a', 'b', 'c', 'd']);
    expect(nodes[0]).toEqual({ area: 'a', x: 100, y: 40 });
    expect(nodes[1]).toEqual({ area: 'b', x: 160, y: 100 });
    expect(nodes[2]).toEqual({ area: 'c', x: 100, y: 160 });
    expect(nodes[3]).toEqual({ area: 'd', x: 40, y: 100 });
  });

  it('lays two areas side by side and one in the middle', () => {
    expect(netLayout(['a', 'b'], [], 200, 40).nodes.map((n) => [n.x, n.y])).toEqual([
      [40, 100],
      [160, 100],
    ]);
    expect(netLayout(['a'], [], 200, 40).nodes[0]).toEqual({ area: 'a', x: 100, y: 100 });
  });

  it('draws one line per pair, as thick as it has links, with its number in the middle', () => {
    const { edges } = netLayout(['a', 'b', 'c'], [pair('a', 'b', 1), pair('b', 'c', 5), pair('a', 'c', 3)], 200, 40);
    expect(edges.map((e) => [e.a, e.b, e.count])).toEqual([
      ['a', 'b', 1],
      ['b', 'c', 5],
      ['a', 'c', 3],
    ]);
    expect(edges[0]!.width).toBe(MIN_WIDTH);
    expect(edges[1]!.width).toBe(MAX_WIDTH);
    expect(edges[2]!.width).toBeGreaterThan(MIN_WIDTH);
    expect(edges[2]!.width).toBeLessThan(MAX_WIDTH);
    const e = edges[0]!;
    expect([e.mx, e.my]).toEqual([(e.x1 + e.x2) / 2, (e.y1 + e.y2) / 2]);
  });

  it('keeps the numbers of lines that cross in the middle apart (areas facing each other)', () => {
    const pairs = [pair('a', 'c', 1), pair('b', 'd', 2), pair('a', 'b', 3), pair('c', 'd', 4)];
    const { edges } = netLayout(['a', 'b', 'c', 'd'], pairs, 200, 40);
    // The first takes the middle; the other diagonal stands its number nearer one end, still on its own line.
    expect([edges[0]!.mx, edges[0]!.my]).toEqual([100, 100]);
    for (const [i, e] of edges.entries()) {
      for (const other of edges.slice(i + 1)) expect(Math.hypot(e.mx - other.mx, e.my - other.my)).toBeGreaterThanOrEqual(2 * BADGE_RADIUS);
      const cross = (e.x2 - e.x1) * (e.my - e.y1) - (e.y2 - e.y1) * (e.mx - e.x1);
      expect(Math.abs(cross)).toBeLessThan(1e-6 + Math.hypot(e.x2 - e.x1, e.y2 - e.y1) * 0.1);
    }
  });

  it('leaves out a pair whose area is not drawn, and gives the same width to pairs of the same count', () => {
    const { edges } = netLayout(['a', 'b'], [pair('a', 'b', 2), pair('a', 'x', 9)], 200, 40);
    expect(edges.map((e) => e.b)).toEqual(['b']);
    const even = netLayout(['a', 'b', 'c'], [pair('a', 'b', 2), pair('b', 'c', 2)], 200, 40).edges;
    expect(even.map((e) => e.width)).toEqual([MAX_WIDTH, MAX_WIDTH]);
  });
});
