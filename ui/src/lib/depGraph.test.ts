import { describe, expect, it } from 'vitest';
import { task } from './fixtures';
import { criticalEdges, crossings, depGraphOf, neighbourOf, orderRows, type DepRow } from './depGraph';

describe('the plan as a graph', () => {
  it('takes the stages as rows and the tasks own blocked_by and after as arrows, between drawn tasks only', () => {
    const g = depGraphOf([
      { stage: 0, tasks: [task('a/1'), task('a/2')] },
      { stage: 1, tasks: [task('a/3', { blocked_by: ['a/1', 'a/gone'], after: ['a/2', 'a/elsewhere'] })] },
      { stage: null, tasks: [task('a/4', { blocked_by: ['a/5'] }), task('a/5', { blocked_by: ['a/4'] })] },
    ]);
    expect(g.rows).toEqual([
      { stage: 0, ids: ['a/1', 'a/2'] },
      { stage: 1, ids: ['a/3'] },
      { stage: null, ids: ['a/4', 'a/5'] },
    ]);
    expect(g.edges).toEqual([
      { from: 'a/1', to: 'a/3', kind: 'blocked_by' },
      { from: 'a/2', to: 'a/3', kind: 'after' },
      { from: 'a/5', to: 'a/4', kind: 'blocked_by' },
      { from: 'a/4', to: 'a/5', kind: 'blocked_by' },
    ]);
    // A hard blocker that is not drawn is counted; a soft one is not (it holds nothing up).
    expect(g.hidden.get('a/3')).toBe(1);
    expect(g.hidden.has('a/4')).toBe(false);
  });

  it('orders a row so that fewer arrows cross, and keeps the plan order where it changes nothing', () => {
    // a/1 -> a/4, a/2 -> a/3: in the plan order the two arrows cross.
    const rows: DepRow[] = [
      { stage: 0, ids: ['a/1', 'a/2'] },
      { stage: 1, ids: ['a/3', 'a/4'] },
    ];
    const edges = [
      { from: 'a/1', to: 'a/4', kind: 'blocked_by' as const },
      { from: 'a/2', to: 'a/3', kind: 'blocked_by' as const },
    ];
    expect(crossings(rows, edges)).toBe(1);
    const ordered = orderRows(rows, edges);
    expect(crossings(ordered, edges)).toBe(0);
    expect(ordered.map((r) => r.stage)).toEqual([0, 1]);
    // Nothing to gain: the order stays as the engine gave it.
    const calm = [
      { stage: 0, ids: ['a/1', 'a/2', 'a/9'] },
      { stage: 1, ids: ['a/3'] },
    ];
    expect(orderRows(calm, [{ from: 'a/1', to: 'a/3', kind: 'blocked_by' }])).toEqual(calm);
  });

  it('is the same picture for the same data, and never crosses more than the plan order', () => {
    const rows: DepRow[] = [
      { stage: 0, ids: ['a', 'b', 'c', 'd'] },
      { stage: 1, ids: ['e', 'f', 'g', 'h'] },
      { stage: 2, ids: ['i', 'j'] },
    ];
    const edges = (
      [
        ['a', 'h'],
        ['b', 'g'],
        ['c', 'f'],
        ['d', 'e'],
        ['e', 'j'],
        ['h', 'i'],
        ['a', 'e'],
      ] as const
    ).map(([from, to]) => ({ from, to, kind: 'blocked_by' as const }));
    const once = orderRows(rows, edges);
    expect(orderRows(rows, edges)).toEqual(once);
    expect(crossings(once, edges)).toBeLessThan(crossings(rows, edges));
    // Every task is still in its own row.
    expect(once.map((r) => [...r.ids].sort())).toEqual(rows.map((r) => [...r.ids].sort()));
  });

  it('counts only arrows between neighbouring rows as crossings', () => {
    const rows: DepRow[] = [
      { stage: 0, ids: ['a', 'b'] },
      { stage: 1, ids: ['c'] },
      { stage: 2, ids: ['d', 'e'] },
    ];
    expect(
      crossings(rows, [
        { from: 'a', to: 'e', kind: 'blocked_by' },
        { from: 'b', to: 'd', kind: 'blocked_by' },
      ]),
    ).toBe(0);
  });

  it('marks the arrows of the critical path, from one task of the path to the next', () => {
    expect([...criticalEdges(['a', 'b', 'c'])]).toEqual(['a>b', 'b>c']);
    expect(criticalEdges([]).size).toBe(0);
  });

  it('moves the keys in a row and to the nearest place in the next row that has tasks', () => {
    const rows: DepRow[] = [
      { stage: 0, ids: ['a', 'b', 'c'] },
      { stage: 1, ids: [] },
      { stage: 2, ids: ['d', 'e'] },
    ];
    expect(neighbourOf(rows, 'b', 'left')).toBe('a');
    expect(neighbourOf(rows, 'b', 'right')).toBe('c');
    expect(neighbourOf(rows, 'c', 'right')).toBeNull();
    expect(neighbourOf(rows, 'c', 'down')).toBe('e');
    expect(neighbourOf(rows, 'a', 'down')).toBe('d');
    expect(neighbourOf(rows, 'e', 'up')).toBe('c');
    expect(neighbourOf(rows, 'a', 'up')).toBeNull();
    expect(neighbourOf(rows, 'zz', 'up')).toBeNull();
  });
});
