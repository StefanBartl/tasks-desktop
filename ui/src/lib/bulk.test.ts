import { describe, expect, it } from 'vitest';
import type { TaskEntry } from './contract';
import { BULK_MAX, bulkSetOps, markAll, pruneMarks, toggleMark } from './bulk';

const task = (id: string, etag?: string) => ({ id, ...(etag ? { etag } : {}) }) as unknown as TaskEntry;

describe('marks', () => {
  it('toggles and keeps the order', () => {
    expect(toggleMark(['a'], 'b')).toEqual(['a', 'b']);
    expect(toggleMark(['a', 'b'], 'a')).toEqual(['b']);
  });

  it('refuses a mark past the limit of one batch', () => {
    const full = Array.from({ length: BULK_MAX }, (_, i) => `t${i}`);
    expect(toggleMark(full, 'one-more')).toEqual(full);
    expect(markAll([], [...full, 'x', 'y'])).toHaveLength(BULK_MAX);
    expect(markAll(['a'], ['a', 'b'])).toEqual(['a', 'b']);
  });

  it('forgets a task that is gone', () => {
    expect(pruneMarks(['a', 'gone', 'b'], [task('a'), task('b')])).toEqual(['a', 'b']);
  });
});

describe('bulkSetOps', () => {
  it('is one set per marked task, each with its own version', () => {
    const ops = bulkSetOps([task('a', 'e1'), task('b'), task('c', 'e3')], ['c', 'a', 'b', 'gone'], {
      status: 'doing',
    });
    expect(ops).toEqual([
      { op: 'set', id: 'c', patch: { status: 'doing' }, if_match: 'e3' },
      { op: 'set', id: 'a', patch: { status: 'doing' }, if_match: 'e1' },
      { op: 'set', id: 'b', patch: { status: 'doing' } },
    ]);
  });

  it('does not share the patch between the operations', () => {
    const ops = bulkSetOps([task('a'), task('b')], ['a', 'b'], { tags: ['x'] });
    expect(ops[0]?.patch).not.toBe(ops[1]?.patch);
  });
});
