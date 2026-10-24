import { describe, expect, it } from 'vitest';
import { task } from './fixtures';
import { boardRows, cellRows, groupRows, mayLeave, onlyMarked, stageRows, taskCount, withoutPlansOf } from './viewExport';

const ids = (rows: { task: { id: string }; group?: string }[]) => rows.map((r) => `${r.group ?? '-'} ${r.task.id}`);

describe('the rows of a view, for the export', () => {
  it('board: the columns in their order, the order of the tasks inside kept, no column for done', () => {
    const rows = boardRows([
      task('a/1', { status: 'open' }),
      task('a/2', { status: 'doing' }),
      task('a/3', { status: 'open' }),
      task('a/4', { status: 'done' }),
      task('a/5', { status: 'parked' }),
    ]);
    expect(ids(rows)).toEqual(['doing a/2', 'open a/1', 'open a/3', 'parked a/5']);
  });

  it('plan: the stages in order, each named by the name it is given (the tasks without a stage too)', () => {
    const rows = stageRows(
      [
        { stage: 0, tasks: [task('a/1'), task('a/2')] },
        { stage: 1, tasks: [task('a/3')] },
        { stage: null, tasks: [task('a/4')] },
      ],
      (stage) => (stage === null ? 'none' : `S${stage}`),
    );
    expect(ids(rows)).toEqual(['S0 a/1', 'S0 a/2', 'S1 a/3', 'none a/4']);
  });

  it('a saved view: a row in every group a task stands in, the group named by its label', () => {
    const one = task('a/1');
    const label = (v: string) => (v === '' ? 'not set' : v);
    expect(ids(groupRows([{ value: 'x', items: [one] }, { value: 'y', items: [one, task('a/2')] }, { value: '', items: [task('a/3')] }], label))).toEqual([
      'x a/1',
      'y a/1',
      'y a/2',
      'not set a/3',
    ]);
  });

  it('a matrix: the column as the group and the row beside it, both by their labels', () => {
    const rows = cellRows(
      [
        { row: 'r1', column: 'c1', items: [task('a/1')] },
        { row: '', column: 'c2', items: [task('a/2')] },
      ],
      (v) => (v === '' ? 'not set' : v),
    );
    expect(rows.map((r) => `${r.row} | ${r.group} | ${r.task.id}`)).toEqual(['r1 | c1 | a/1', 'not set | c2 | a/2']);
  });

  it('takes the id of a plan that may not leave from its tasks, and leaves the others', () => {
    const rows = withoutPlansOf(
      [{ task: task('a/1', { plan: 'secret/p' }) }, { task: task('a/2', { plan: 'open/p' }) }, { task: task('a/3') }],
      (plan) => plan.startsWith('open/'),
    );
    expect(rows.map((r) => r.task.plan)).toEqual([undefined, 'open/p', undefined]);
    expect(Object.hasOwn(rows[0]!.task, 'plan')).toBe(false);
    expect(rows[0]!.task.id).toBe('a/1');
  });

  it('only the marked ones when some are marked, all when none are', () => {
    const rows = [{ task: task('a/1') }, { task: task('a/2') }];
    expect(onlyMarked(rows, new Set())).toHaveLength(2);
    expect(ids(onlyMarked(rows, new Set(['a/2'])))).toEqual(['- a/2']);
  });

  it('keeps the tasks that may not leave, and counts each such task once', () => {
    const secret = task('p/1');
    const { rows, kept } = mayLeave(
      [{ task: task('a/1') }, { task: secret, group: 'x' }, { task: secret, group: 'y' }, { task: task('p/2') }],
      (t) => t.area === 'a',
    );
    expect(ids(rows)).toEqual(['- a/1']);
    expect(kept).toBe(2);
  });

  it('counts a task in two groups once', () => {
    const one = task('a/1');
    expect(taskCount([{ task: one, group: 'x' }, { task: one, group: 'y' }, { task: task('a/2') }])).toBe(2);
  });
});
