import { describe, expect, it } from 'vitest';
import { countCrossings, layoutGraph } from './depGraph';
import { task } from './fixtures';

const at = (stage: number | undefined) => ({
  readiness: { state: 'ready' as const, rank: 1, leverage: 0, open_blockers: [], stage },
});

describe('layoutGraph', () => {
  it('groups tasks into rows by stage, a cycle (no stage) last', () => {
    const { rows } = layoutGraph(
      [task('a/first', at(0)), task('a/second', at(1)), task('a/loop', { readiness: { state: 'stuck', rank: 3, leverage: 0, open_blockers: [] } })],
      null,
    );
    expect(rows.map((r) => r.row)).toEqual([0, 1, null]);
    expect(rows[2]?.ids).toEqual(['a/loop']);
  });

  it('narrows to the tasks of one plan', () => {
    const { rows } = layoutGraph(
      [task('a/in', { ...at(0), plan: 'a/p' }), task('a/out', at(0))],
      'a/p',
    );
    expect(rows[0]?.ids).toEqual(['a/in']);
  });

  it('turns blocked_by into hard edges and after into soft edges, dropping ones that leave the members', () => {
    const { edges } = layoutGraph(
      [
        task('a/first', at(0)),
        task('a/second', { ...at(1), blocked_by: ['a/first'] }),
        task('a/third', { ...at(1), after: ['a/first'] }),
        task('a/fourth', { ...at(1), blocked_by: ['outside/x'] }),
      ],
      null,
    );
    expect(edges).toEqual(
      expect.arrayContaining([
        { from: 'a/first', to: 'a/second', kind: 'blocked_by' },
        { from: 'a/first', to: 'a/third', kind: 'after' },
      ]),
    );
    expect(edges).toHaveLength(2);
  });

  it('orders a row by the average position of what points into it, so parallel edges do not cross', () => {
    // a/p1 -> a/c1, a/p2 -> a/c2: with p1, p2 fixed, c2 starting before c1 would cross both arrows.
    const { rows, edges } = layoutGraph(
      [
        task('a/p1', at(0)),
        task('a/p2', at(0)),
        task('a/c2', { ...at(1), blocked_by: ['a/p2'] }),
        task('a/c1', { ...at(1), blocked_by: ['a/p1'] }),
      ],
      null,
    );
    expect(rows[1]?.ids).toEqual(['a/c1', 'a/c2']);
    expect(countCrossings(rows, edges)).toBe(0);
  });

  it('is stable (keeps the engine order) for a row nothing points into', () => {
    const { rows } = layoutGraph([task('a/z', at(0)), task('a/a', at(0))], null);
    expect(rows[0]?.ids).toEqual(['a/z', 'a/a']);
  });
});

describe('countCrossings', () => {
  it('counts an inversion between two rows and none for the same arrow twice', () => {
    const rows = [
      { row: 0, ids: ['a/p1', 'a/p2'] },
      { row: 1, ids: ['a/c2', 'a/c1'] },
    ];
    const edges = [
      { from: 'a/p1', to: 'a/c1', kind: 'blocked_by' as const },
      { from: 'a/p2', to: 'a/c2', kind: 'blocked_by' as const },
    ];
    expect(countCrossings(rows, edges)).toBe(1);
  });

  it('does not count an edge that skips a row', () => {
    const rows = [
      { row: 0, ids: ['a/p'] },
      { row: 1, ids: ['a/mid'] },
      { row: 2, ids: ['a/c'] },
    ];
    const edges = [{ from: 'a/p', to: 'a/c', kind: 'blocked_by' as const }];
    expect(countCrossings(rows, edges)).toBe(0);
  });
});
