import { describe, expect, it } from 'vitest';
import type { TaskEntry } from './contract';
import { BULK_MAX, bulkSetOps, editedTags, markAll, pruneMarks, toggleMark } from './bulk';

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

  it('works the tags out for each task from the tags it has', () => {
    const tagged = (id: string, tags: string[], etag: string) => ({ id, tags, etag }) as unknown as TaskEntry;
    const ops = bulkSetOps(
      [tagged('a', ['x', 'y'], 'e1'), tagged('b', ['y'], 'e2'), tagged('c', [], 'e3'), tagged('d', ['z'], 'e4')],
      ['a', 'b', 'c', 'd'],
      { effort: 'S' },
      { add: ['n'], remove: ['y'] },
    );
    expect(ops.map((o) => o.patch)).toEqual([
      { effort: 'S', tags: ['x', 'n'] },
      { effort: 'S', tags: ['n'] },
      { effort: 'S', tags: ['n'] },
      { effort: 'S', tags: ['z', 'n'] },
    ]);
  });

  it('takes the key away when no tag is left, and leaves out a task that has what was asked for', () => {
    const tagged = (id: string, tags: string[]) => ({ id, tags }) as unknown as TaskEntry;
    const ops = bulkSetOps([tagged('a', ['y']), tagged('b', ['n', 'm'])], ['a', 'b'], {}, { add: ['n'], remove: ['y'] });
    // b has n already and no y: nothing to write for it.
    expect(ops).toEqual([{ op: 'set', id: 'a', patch: { tags: ['n'] } }]);
    expect(bulkSetOps([tagged('a', ['y'])], ['a'], {}, { add: [], remove: ['y'] })[0]?.patch).toEqual({ tags: null });
    expect(editedTags(undefined, { add: [], remove: ['q'] })).toBeNull();
    // Removed first, then added: a tag in both stays.
    expect(editedTags(['t'], { add: ['t'], remove: ['t'] })).toBeNull();
  });

  it('does not share the patch between the operations', () => {
    const ops = bulkSetOps([task('a'), task('b')], ['a', 'b'], { tags: ['x'] });
    expect(ops[0]?.patch).not.toBe(ops[1]?.patch);
  });
});
