import { describe, expect, it } from 'vitest';
import type { TaskEntry } from './contract';
import {
  BULK_MAX,
  bulkMoveOps,
  bulkSetOps,
  editedTags,
  followMoves,
  isApplyKey,
  markAll,
  moveChecks,
  moveOrder,
  moveUndo,
  pruneMarks,
  toggleMark,
} from './bulk';

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

describe('isApplyKey', () => {
  it('is Enter, and not the Enter that confirms an input method', () => {
    expect(isApplyKey({ key: 'Enter' })).toBe(true);
    expect(isApplyKey({ key: 'Enter', isComposing: false })).toBe(true);
    expect(isApplyKey({ key: 'Enter', isComposing: true })).toBe(false);
    expect(isApplyKey({ key: 'a' })).toBe(false);
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

describe('moving the marked tasks', () => {
  const at = (id: string, area: string, etag?: string, status = 'open') =>
    ({ id, area, status, ...(etag ? { etag } : {}) }) as unknown as TaskEntry;
  const tasks = [at('a/one', 'a', 'e1'), at('b/two', 'b', 'e2'), at('a/three', 'a'), at('a/four', 'a', 'e4', 'done')];

  it('is one move_area for each marked task with the version that was shown, in the order of the marks', () => {
    expect(bulkMoveOps(tasks, ['a/three', 'a/one'], 'c')).toEqual([
      { op: 'move_area', id: 'a/three', to_area: 'c' },
      { op: 'move_area', id: 'a/one', to_area: 'c', if_match: 'e1' },
    ]);
  });

  it('leaves out a task in that area already, a finished one and a mark with no task', () => {
    expect(bulkMoveOps(tasks, ['b/two', 'a/four', 'gone/x', 'a/one'], 'b')).toEqual([
      { op: 'move_area', id: 'a/one', to_area: 'b', if_match: 'e1' },
    ]);
  });

  it('reads the dry run per move: the new id, the reasons, the places that follow, a refusal', () => {
    const ops = bulkMoveOps(tasks, ['a/one', 'a/three', 'b/two'], 'c');
    expect(
      moveChecks(ops, [
        { n: 1, move: { new_id: 'c/one', conflicts: [], references: [{ id: 'b/two' }, { path: 'doc.md' }] } },
        { n: 2, move: { new_id: 'c/three', conflicts: [{ message: 'c/three is an open task already' }], references: [] } },
        { n: 3, error: { message: 'unknown area: c' } },
      ]),
    ).toEqual([
      { id: 'a/one', newId: 'c/one', reasons: [], references: 2, namedBy: ['b/two'] },
      { id: 'a/three', newId: 'c/three', reasons: ['c/three is an open task already'], references: 0, namedBy: [] },
      { id: 'b/two', newId: '', reasons: ['unknown area: c'], references: 0, namedBy: [] },
    ]);
  });

  it('moves a task that names another marked one before it (its version would be gone otherwise)', () => {
    const check = (id: string, namedBy: string[]) => ({ id, newId: `c/${id}`, reasons: [], references: 0, namedBy });
    const ops = [{ id: 'two' }, { id: 'one' }, { id: 'three' }];
    // one names two (after: [two]): moving two rewrites one, so one goes first
    expect(moveOrder(ops, [check('two', ['one', 'plan/x']), check('one', []), check('three', [])]).map((o) => o.id)).toEqual([
      'one',
      'two',
      'three',
    ]);
    // a chain: three names two, two names one
    expect(
      moveOrder([{ id: 'one' }, { id: 'two' }, { id: 'three' }], [check('one', ['two']), check('two', ['three']), check('three', [])]).map(
        (o) => o.id,
      ),
    ).toEqual(['three', 'two', 'one']);
    // nothing names anything: the order stays; a circle keeps the order too and ends
    expect(moveOrder(ops, [check('two', []), check('one', []), check('three', [])])).toEqual(ops);
    expect(moveOrder(ops, [check('two', ['one']), check('one', ['two']), check('three', [])]).map((o) => o.id)).toEqual([
      'three',
      'two',
      'one',
    ]);
  });

  it('takes a batch of moves back in an order that works, without a version a later move of the batch made stale', () => {
    // one names two; one moved first, then two (which rewrote one's file)
    const back = moveUndo([
      { n: 1, ok: true, outcome: 'moved', inverse: { op: 'move_area', id: 'c/one', to_area: 'a', if_match: 'e1' }, rewritten: [] },
      {
        n: 2,
        ok: true,
        outcome: 'moved',
        inverse: { op: 'move_area', id: 'c/two', to_area: 'a', if_match: 'e2' },
        rewritten: [{ id: 'c/one' }],
      },
      { n: 3, ok: false },
    ]);
    // one goes back first (it names two), and without the version its own move left (two's move changed the file)
    expect(back).toEqual([
      { op: 'move_area', id: 'c/one', to_area: 'a' },
      { op: 'move_area', id: 'c/two', to_area: 'a', if_match: 'e2' },
    ]);
    // nothing rewritten in between: every inverse keeps its version
    expect(
      moveUndo([{ n: 1, ok: true, outcome: 'moved', inverse: { op: 'move_area', id: 'c/x', to_area: 'a', if_match: 'ex' } }]),
    ).toEqual([{ op: 'move_area', id: 'c/x', to_area: 'a', if_match: 'ex' }]);
    // a move without a way back: no undo at all rather than half of one
    expect(moveUndo([{ n: 1, ok: true, outcome: 'moved' }])).toBeUndefined();
    expect(moveUndo([{ n: 1, ok: false }])).toBeUndefined();
  });

  it('keeps a mark on a moved task under its new id, and the rest as it was', () => {
    const moved = new Map([['a/one', 'c/one']]);
    expect(followMoves(['a/three', 'a/one', 'b/two'], moved)).toEqual(['a/three', 'c/one', 'b/two']);
    // nothing points at an id that is gone
    expect(followMoves(['a/one'], moved)).not.toContain('a/one');
    // a mark that was on the new id already is not doubled
    expect(followMoves(['a/one', 'c/one'], moved)).toEqual(['c/one']);
  });
});
