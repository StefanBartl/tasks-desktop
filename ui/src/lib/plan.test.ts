import { describe, expect, it } from 'vitest';
import { criticalIds, phaseCounts, stagesOf } from './plan';
import { task } from './fixtures';
import type { Snapshot } from './contract';

const at = (stage: number | undefined, extra = {}) => ({
  readiness: { state: 'ready' as const, rank: 1, leverage: 0, open_blockers: [], stage },
  ...extra,
});

describe('plan', () => {
  const list = [
    task('a/first', at(1)),
    task('a/second', at(2, { plan: 'a/p' })),
    task('a/also-first', at(1, { plan: 'a/p', phase: 'build' })),
    task('a/loop', { readiness: { state: 'stuck', rank: 4, leverage: 0, open_blockers: [], in_cycle: true } }),
    task('a/bare'),
  ];

  it('groups by stage in the order of the engine, and puts a cycle last', () => {
    const stages = stagesOf(list);
    expect(stages.map((s) => s.stage)).toEqual([1, 2, null]);
    expect(stages[0]?.tasks.map((t) => t.id)).toEqual(['a/first', 'a/also-first']);
    expect(stages[2]?.tasks.map((t) => t.id)).toEqual(['a/loop', 'a/bare']);
  });

  it('keeps the first stage, which the engine numbers 0, apart from no stage', () => {
    const stages = stagesOf([task('a/zero', at(0)), task('a/none')]);
    expect(stages.map((s) => s.stage)).toEqual([0, null]);
  });

  it('narrows to one plan', () => {
    expect(stagesOf(list, 'a/p').flatMap((s) => s.tasks.map((t) => t.id))).toEqual([
      'a/also-first',
      'a/second',
    ]);
    expect(stagesOf(list, 'a/none')).toEqual([]);
  });

  it('names the critical path', () => {
    const plan = { critical_path: { path: ['a/first', 'a/second'] } } as unknown as Snapshot['plan'];
    expect([...criticalIds(plan)]).toEqual(['a/first', 'a/second']);
    expect(criticalIds(undefined).size).toBe(0);
  });

  it('counts the phases in the plans own order, and keeps one it does not name', () => {
    const plan = { id: 'a/p', phase_order: ['design', 'build'] } as unknown as Snapshot['plans'][number];
    const tasks = [
      task('a/x', { plan: 'a/p', phase: 'build' }),
      task('a/y', { plan: 'a/p', phase: 'build' }),
      task('a/z', { plan: 'a/p', phase: 'extra' }),
      task('a/other', { plan: 'a/q', phase: 'design' }),
    ];
    expect(phaseCounts(tasks, plan)).toEqual([
      { phase: 'design', n: 0 },
      { phase: 'build', n: 2 },
      { phase: 'extra', n: 1 },
    ]);
    expect(phaseCounts(tasks, undefined)).toEqual([]);
  });
});
