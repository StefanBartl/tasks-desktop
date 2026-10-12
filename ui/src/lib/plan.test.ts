import { describe, expect, it } from 'vitest';
import { chosenPlan, criticalIds, phaseCounts, stagesOf, warningsOf } from './plan';
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

  it('keeps a chosen plan while the vault has it and drops it when it is gone', () => {
    const plans = [{ id: 'a/p' }, { id: 'a/q' }] as unknown as Snapshot['plans'];
    expect(chosenPlan(plans, 'a/q')).toBe('a/q');
    // A plan that vanished (a change of the vault) is no longer chosen.
    expect(chosenPlan(plans, 'a/gone')).toBe('');
    expect(chosenPlan([], 'a/p')).toBe('');
    // Nothing chosen stays nothing.
    expect(chosenPlan(plans, '')).toBe('');
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

  it('narrows the warnings to one plan and keeps those of the vault', () => {
    const plan = {
      cycles: [['a/p-1', 'a/p-2'], ['a/other']],
      conflict_groups: [
        { stage: 0, file: 'x.lua', ids: ['a/p-1', 'a/other'] },
        { stage: 1, file: 'y.lua', ids: ['a/other'] },
      ],
      warnings: [
        { code: 'c1', id: 'a/p-1', msg: 'm' },
        { code: 'c2', id: 'a/other', msg: 'm' },
        { code: 'c3', msg: 'm' },
      ],
    } as unknown as Snapshot['plan'];
    const tasks = [task('a/p-1', { plan: 'a/p' }), task('a/p-2', { plan: 'a/p' }), task('a/other')];
    const all = warningsOf(plan, tasks, null);
    expect(all.warnings.length).toBe(3);
    const mine = warningsOf(plan, tasks, 'a/p');
    expect(mine.cycles).toEqual([['a/p-1', 'a/p-2']]);
    expect(mine.conflict_groups.map((g) => g.file)).toEqual(['x.lua']);
    expect(mine.warnings.map((w) => w.code)).toEqual(['c1', 'c3']);
    expect(warningsOf(undefined, tasks, 'a/p').warnings).toEqual([]);
  });
});
