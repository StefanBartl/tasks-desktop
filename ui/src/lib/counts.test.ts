import { describe, expect, it } from 'vitest';
import type { TaskEntry } from './contract';
import { task } from './fixtures';
import {
  COUNT_KEYS,
  defaultView,
  groupTasks,
  nextView,
  parseViews,
  tasksOf,
  viewAllowed,
  viewsOf,
} from './counts';

const ready = (open: string[] = []) =>
  ({ state: 'ready', rank: 1, leverage: 0, open_blockers: open }) as unknown as TaskEntry['readiness'];

const tasks: TaskEntry[] = [
  task('a/one', { status: 'doing', prio: 2, plan: 'p1', readiness: ready() }),
  task('b/two', { status: 'blocked', prio: 1, blocked_by: ['a/one', 'c/x'], readiness: ready(['a/one']) }),
  task('a/three', { status: 'blocked', blocked_by: ['c/done'], readiness: ready([]) }),
  task('a/four', { status: 'open', prio: 2, value: 4, plan: 'p1', readiness: ready() }),
  task('c/five', { status: 'open', prio: 1, value: 2 }),
  task('b/six', { status: 'blocked', prio: 2, blocked_by: ['a/one'], readiness: ready(['a/one']) }),
];

describe('what a number counts', () => {
  it('is the tasks with that state, status or value, in the engine order', () => {
    expect(tasksOf('ready', tasks).map((t) => t.id)).toEqual(['a/one', 'b/two', 'a/three', 'a/four', 'b/six']);
    expect(tasksOf('doing', tasks).map((t) => t.id)).toEqual(['a/one']);
    expect(tasksOf('blocked', tasks).map((t) => t.id)).toEqual(['b/two', 'a/three', 'b/six']);
    expect(tasksOf('estimated', tasks).map((t) => t.id)).toEqual(['a/four', 'c/five']);
  });
});

describe('the views of a number', () => {
  it('start with the list, and only blocked can be cut up by what it waits on', () => {
    for (const key of COUNT_KEYS) expect(defaultView(key)).toBe('list');
    expect(viewsOf('blocked')).toContain('blocker');
    for (const key of ['ready', 'doing', 'estimated'] as const) expect(viewsOf(key)).not.toContain('blocker');
  });

  it('walks round with the next view, and knows which choices exist', () => {
    let view = defaultView('blocked');
    const seen = [view];
    for (let i = 0; i < viewsOf('blocked').length; i++) {
      view = nextView('blocked', view);
      seen.push(view);
    }
    expect(seen[0]).toBe(seen[seen.length - 1]);
    expect(new Set(seen).size).toBe(viewsOf('blocked').length);
    expect(viewAllowed('ready', 'blocker')).toBe(false);
    expect(viewAllowed('blocked', 'blocker')).toBe(true);
    expect(viewAllowed('ready', 7)).toBe(false);
  });
});

describe('cutting a number up', () => {
  const blocked = tasksOf('blocked', tasks);

  it('gives the list as one group with no name', () => {
    expect(groupTasks('list', blocked)).toEqual([{ key: '', tasks: blocked }]);
  });

  it('puts every task in exactly one group, so the groups add up to the number', () => {
    for (const key of COUNT_KEYS) {
      const list = tasksOf(key, tasks);
      for (const view of viewsOf(key)) {
        const groups = groupTasks(view, list);
        expect(groups.flatMap((g) => g.tasks.map((t) => t.id)).sort(), `${key} ${view}`).toEqual(
          list.map((t) => t.id).sort(),
        );
      }
    }
  });

  it('groups by area and by plan in the order of the first task, and the ones with none have an empty key', () => {
    expect(groupTasks('area', blocked).map((g) => [g.key, g.tasks.length])).toEqual([
      ['b', 2],
      ['a', 1],
    ]);
    expect(groupTasks('plan', tasksOf('ready', tasks)).map((g) => g.key)).toEqual(['p1', '']);
  });

  it('orders priorities as numbers, none last', () => {
    expect(groupTasks('prio', tasks).map((g) => g.key)).toEqual(['1', '2', '']);
  });

  it('groups by the first blocker that is still open, and a task that waits on a finished one only has none', () => {
    const groups = groupTasks('blocker', blocked);
    expect(groups.map((g) => [g.key, g.tasks.map((t) => t.id)])).toEqual([
      ['a/one', ['b/two', 'b/six']],
      ['', ['a/three']],
    ]);
  });
});

describe('the stored choices', () => {
  it('are read back only when they name a number and a view that exist', () => {
    expect(parseViews(null)).toEqual({});
    expect(parseViews('not json')).toEqual({});
    expect(parseViews('[1]')).toEqual({});
    expect(parseViews('{"ready":"area","doing":"blocker","blocked":"blocker","gone":"list","estimated":3}')).toEqual({
      ready: 'area',
      blocked: 'blocker',
    });
  });
});
