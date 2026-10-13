import { describe, expect, it } from 'vitest';
import type { Op } from './api';
import type { Result, TaskEntry } from './contract';
import {
  CONFLICTS_MAX,
  alreadyDone,
  conflictsOf,
  conflictsOfRequest,
  differences,
  formatValue,
  mergeConflicts,
  retryOp,
  type Conflict,
} from './conflicts';

const NOW = 1_000;
const set = (id: string, patch: Record<string, unknown>): Op => ({ op: 'set', id, patch, if_match: 'old' });
const task = (id: string, fields: Record<string, unknown> = {}) => ({ id, etag: 'new', ...fields }) as unknown as TaskEntry;
const result = (entries: unknown[]) => ({ kind: 'tasks.result', ok: false, results: entries }) as unknown as Result;
const failed = (n: number, code: string) => ({ n, op: 'set', ok: false, outcome: 'failed', changed_ids: [], error: { code, message: 'x', retryable: false } });
const good = (n: number) => ({ n, op: 'set', ok: true, outcome: 'changed', changed_ids: [] });

describe('what is kept from an answer', () => {
  it('is the refused set and reorder, found by the position in the batch', () => {
    const ops: Op[] = [
      set('a/one', { status: 'doing' }),
      set('a/two', { prio: 1 }),
      { op: 'reorder', id: 'a/three', after: 'a/x' },
      { op: 'done', id: 'a/four', confirm: 't' },
    ];
    const answer = result([good(1), failed(2, 'conflict'), failed(3, 'not_found'), failed(4, 'conflict')]);
    const kept = conflictsOf(ops, answer, NOW);
    // A refused done is not kept: its own dialog tells it.
    expect(kept.map((c) => [c.id, c.code])).toEqual([
      ['a/two', 'conflict'],
      ['a/three', 'not_found'],
    ]);
  });

  it('leaves out a refusal that says the change itself is wrong', () => {
    const answer = result([failed(1, 'invalid_argument'), failed(2, 'forbidden')]);
    expect(conflictsOf([set('a/x', { prio: 9 }), set('a/y', {})], answer, NOW)).toEqual([]);
  });

  it('keeps a locked file for a later try', () => {
    const answer = result([failed(1, 'locked')]);
    expect(conflictsOf([set('a/x', { prio: 1 })], answer, NOW)[0]?.code).toBe('locked');
  });

  it('takes every change of a request that was refused as a whole', () => {
    const kept = conflictsOfRequest([set('a/x', { prio: 1 }), { op: 'new', area: 'a', title: 't' }], NOW);
    expect(kept.map((c) => c.id)).toEqual(['a/x']);
  });
});

describe('the list', () => {
  const entry = (id: string, key: string, at: number): Conflict => ({ key, id, op: set(id, { prio: 1 }) as Conflict['op'], code: 'conflict', at });

  it('puts the newest first and lets a newer refusal of the same change replace the older', () => {
    const merged = mergeConflicts([entry('a/x', 'k1', 1), entry('a/y', 'k2', 2)], [entry('a/x', 'k1', 9)]);
    expect(merged.map((c) => [c.key, c.at])).toEqual([
      ['k1', 9],
      ['k2', 2],
    ]);
  });

  it('has a limit and drops the oldest', () => {
    const many = Array.from({ length: CONFLICTS_MAX + 10 }, (_, i) => entry(`a/t${i}`, `k${i}`, i));
    const merged = mergeConflicts([], many);
    expect(merged).toHaveLength(CONFLICTS_MAX);
    expect(merged[0]?.key).toBe('k0');
  });

  it('is one entry for the same keys of the same task, whatever the values', () => {
    const a = conflictsOf([set('a/x', { prio: 1, status: 'doing' })], result([failed(1, 'conflict')]), 1)[0];
    const b = conflictsOf([set('a/x', { status: 'parked', prio: 3 })], result([failed(1, 'conflict')]), 2)[0];
    expect(a?.key).toBe(b?.key);
  });
});

describe('wanted and now', () => {
  const conflict = conflictsOf([set('a/x', { status: 'doing', tags: ['a', 'b'], effort: null })], result([failed(1, 'conflict')]), NOW)[0] as Conflict;

  it('shows each key with what was wanted and what the task has', () => {
    expect(differences(conflict, task('a/x', { status: 'parked', tags: ['a'] }))).toEqual([
      { key: 'status', wanted: 'doing', now: 'parked' },
      { key: 'tags', wanted: 'a, b', now: 'a' },
      { key: 'effort', wanted: '-', now: '-' },
    ]);
    expect(differences(conflict, undefined).every((d) => d.now === '-')).toBe(true);
  });

  it('knows when the task has the wish already', () => {
    expect(alreadyDone(conflict, task('a/x', { status: 'doing', tags: ['a', 'b'] }))).toBe(true);
    expect(alreadyDone(conflict, task('a/x', { status: 'parked', tags: ['a', 'b'] }))).toBe(false);
  });

  it('formats an empty value as a dash', () => {
    expect([formatValue(null), formatValue(undefined), formatValue(''), formatValue([]), formatValue(3)]).toEqual(['-', '-', '-', '-', '3']);
  });
});

describe('try again for a bulk change of tags', () => {
  const patchOf = (op: Op | null) => (op && op.op === 'set' ? op.patch : undefined);
  const bulk = (tags: string[]) => ({ op: 'set', id: 'a/x', patch: { tags }, if_match: 'old' }) as Op;
  const wish = { add: ['n'], remove: ['y'] };

  it('works the tags out anew from the tags the task has, so that a tag added meanwhile stays', () => {
    // At the time: tags were [x, y], the wish gave [x, n]. Meanwhile somebody added m.
    const conflict = conflictsOf([bulk(['x', 'n'])], result([failed(1, 'conflict')]), NOW, wish)[0] as Conflict;
    const now = task('a/x', { tags: ['x', 'y', 'm'] });
    expect(retryOp(conflict, now)).toEqual({ op: 'set', id: 'a/x', patch: { tags: ['x', 'm', 'n'] }, if_match: 'new' });
    expect(differences(conflict, now)).toEqual([{ key: 'tags', wanted: 'x, m, n', now: 'x, y, m' }]);
  });

  it('is done when the tags are right already, and takes the key away when none is left', () => {
    const conflict = conflictsOf([bulk(['x', 'n'])], result([failed(1, 'conflict')]), NOW, wish)[0] as Conflict;
    expect(alreadyDone(conflict, task('a/x', { tags: ['x', 'n'] }))).toBe(true);
    expect(retryOp(conflict, task('a/x', { tags: ['x', 'n'] }))).toBeNull();
    const last = conflictsOf([bulk(['n'])], result([failed(1, 'conflict')]), NOW, { add: [], remove: ['n'] })[0] as Conflict;
    expect(patchOf(retryOp(last, task('a/x', { tags: ['n'] })))).toEqual({ tags: null });
  });

  it('keeps the other keys of the change when the tags are right already', () => {
    const op = { op: 'set', id: 'a/x', patch: { effort: 'S', tags: ['n'] }, if_match: 'old' } as Op;
    const conflict = conflictsOf([op], result([failed(1, 'conflict')]), NOW, { add: ['n'], remove: [] })[0] as Conflict;
    expect(patchOf(retryOp(conflict, task('a/x', { tags: ['n'] })))).toEqual({ effort: 'S' });
  });

  it('does not carry the wish into a change without tags', () => {
    const conflict = conflictsOf([set('a/x', { effort: 'S' })], result([failed(1, 'conflict')]), NOW, wish)[0] as Conflict;
    expect(conflict.tags).toBeUndefined();
  });
});

describe('try again', () => {
  it('sends the same change with the version the task has now', () => {
    const conflict = conflictsOf([set('a/x', { status: 'doing' })], result([failed(1, 'conflict')]), NOW)[0] as Conflict;
    expect(retryOp(conflict, task('a/x'))).toEqual({ op: 'set', id: 'a/x', patch: { status: 'doing' }, if_match: 'new' });
  });

  it('does not repeat a move or a change of a task that is gone', () => {
    const move = conflictsOf([{ op: 'reorder', id: 'a/x', after: 'a/y' }], result([failed(1, 'conflict')]), NOW)[0] as Conflict;
    expect(retryOp(move, task('a/x'))).toBeNull();
    const gone = conflictsOf([set('a/x', { prio: 1 })], result([failed(1, 'not_found')]), NOW)[0] as Conflict;
    expect(retryOp(gone, undefined)).toBeNull();
  });
});
