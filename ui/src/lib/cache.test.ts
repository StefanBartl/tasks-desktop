import { describe, expect, it } from 'vitest';
import type { HubArea } from './api';
import { cacheableList } from './cache';
import type { Snapshot, TaskEntry } from './contract';
import { task } from './fixtures';

const doc = (tasks: TaskEntry[]) =>
  ({ vault: { id: 'v' }, rev: 'rev:1', tasks }) as unknown as Snapshot;

const areas: HubArea[] = [
  { name: 'pub', data_class: 'public' },
  { name: 'int', data_class: 'internal' },
  { name: 'priv', data_class: 'private' },
  { name: 'new', data_class: 'unclassified' },
];

describe('cacheableList', () => {
  it('never keeps a private or an unclassified area', () => {
    const list = cacheableList(
      doc([task('pub/a'), task('int/b'), task('priv/c'), task('new/d'), task('ghost/e')]),
      'sha256:1',
      areas,
      5,
    );
    expect(list?.tasks.map((t) => t.id)).toEqual(['pub/a', 'int/b']);
    expect(JSON.stringify(list)).not.toContain('priv/');
    expect(JSON.stringify(list)).not.toContain('new/');
    expect(JSON.stringify(list)).not.toContain('ghost/');
  });
  it('keeps the area groups with only the members that may be cached', () => {
    const snap = {
      ...doc([task('pub/a'), task('priv/c')]),
      area_groups: [{ name: 'mixed', members: ['pub', 'priv', 'int'], open: 2, by_status: {} }],
    } as unknown as Snapshot;
    const list = cacheableList(snap, null, areas, 5);
    expect(list?.areaGroups).toEqual([{ name: 'mixed', members: ['pub', 'int'], open: 0 }]);
    expect(JSON.stringify(list)).not.toContain('priv');
    expect(cacheableList(doc([task('pub/a')]), null, areas, 5)?.areaGroups).toBeUndefined();
  });
  it('cuts an edge to a task that was left out', () => {
    const list = cacheableList(
      doc([
        task('pub/a', {
          blocked_by: ['priv/x', 'int/b'],
          after: ['priv/y'],
          readiness: {
            state: 'waiting',
            rank: 1,
            leverage: 0,
            open_blockers: ['priv/x', 'int/b'],
            inversion: { to: 1, because: 'priv/x is waiting' },
          },
        }),
        task('int/b'),
        task('priv/x'),
        task('priv/y'),
      ]),
      null,
      areas,
      5,
    );
    const a = list?.tasks[0];
    expect(a?.blocked_by).toEqual(['int/b']);
    expect(a?.after).toEqual([]);
    expect(a?.readiness?.open_blockers).toEqual(['int/b']);
    expect(JSON.stringify(list)).not.toContain('priv/');
  });
  it('keeps nothing without a class list (fail closed)', () => {
    expect(cacheableList(doc([task('pub/a')]), null, [], 5)).toBeNull();
  });
});

describe('cacheableList refs', () => {
  it('drops a ref into an area that is left out', () => {
    const list = cacheableList(
      doc([
        task('pub/a', {
          refs: ['priv/ROADMAP/tasks/x.md', 'https://example.org/p', 'int/b', 'notes/new/readme.md'],
        }),
        task('int/b'),
        task('priv/x'),
        task('new/y'),
      ]),
      null,
      areas,
      5,
    );
    expect(list?.tasks[0]?.refs).toEqual(['https://example.org/p', 'int/b']);
  });
});
