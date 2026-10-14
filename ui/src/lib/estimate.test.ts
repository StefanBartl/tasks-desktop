import { describe, expect, it } from 'vitest';
import type { TaskEntry } from './contract';
import { assumeOf, changesOf, failedIdsOf, matrixIds, MATRIX_MAX, withCell } from './estimate';

const t = (id: string, extra: Partial<TaskEntry> = {}) => ({ id, etag: `e-${id}`, ...extra }) as unknown as TaskEntry;

describe('the draft', () => {
  it('holds the cells that were chosen and drops a cell that is put back', () => {
    let draft = withCell({}, 'a/x', 'effort', 'M');
    draft = withCell(draft, 'a/x', 'value', 4);
    expect(draft).toEqual({ 'a/x': { effort: 'M', value: 4 } });
    draft = withCell(draft, 'a/x', 'effort', undefined);
    expect(draft).toEqual({ 'a/x': { value: 4 } });
    draft = withCell(draft, 'a/x', 'value', undefined);
    expect(draft).toEqual({});
  });

  it('is not changed in place', () => {
    const before = { 'a/x': { effort: 'S' } };
    const after = withCell(before, 'a/y', 'value', 2);
    expect(before).toEqual({ 'a/x': { effort: 'S' } });
    expect(after).toEqual({ 'a/x': { effort: 'S' }, 'a/y': { value: 2 } });
  });

  it('is what the engine is asked to assume', () => {
    expect(assumeOf({ 'a/x': { effort: 'M' }, 'a/y': { value: 3 } })).toEqual([
      { id: 'a/x', effort: 'M' },
      { id: 'a/y', value: 3 },
    ]);
    expect(assumeOf({})).toEqual([]);
  });
});

describe('what is written', () => {
  const tasks = [t('a/x', { effort: 'S', value: 2 }), t('a/y'), t('a/z', { effort: 'L' })];

  it('is a set for each task whose cell differs from its file, only with the keys that differ and with its version', () => {
    const ops = changesOf(tasks, { 'a/x': { effort: 'S', value: 5 }, 'a/y': { effort: 'M', value: 1 }, 'a/z': { effort: 'L' } });
    expect(ops).toEqual([
      { op: 'set', id: 'a/x', patch: { value: 5 }, if_match: 'e-a/x' },
      { op: 'set', id: 'a/y', patch: { effort: 'M', value: 1 }, if_match: 'e-a/y' },
    ]);
  });

  it('is nothing when the draft is empty or equals the files', () => {
    expect(changesOf(tasks, {})).toEqual([]);
    expect(changesOf(tasks, { 'a/x': { effort: 'S', value: 2 } })).toEqual([]);
  });

  it('leaves out a draft of a task that is not there any more', () => {
    expect(changesOf(tasks, { 'a/gone': { value: 3 } })).toEqual([]);
  });
});

describe('the tasks of the matrix', () => {
  it('are the marked ones, else the shown ones, up to a limit', () => {
    const shown = [t('a/1'), t('a/2'), t('a/3')];
    expect(matrixIds(['a/2'], shown)).toEqual(['a/2']);
    expect(matrixIds([], shown)).toEqual(['a/1', 'a/2', 'a/3']);
    const many = Array.from({ length: MATRIX_MAX + 20 }, (_, i) => t(`a/t${i}`));
    expect(matrixIds([], many)).toHaveLength(MATRIX_MAX);
  });
});

describe('a failure', () => {
  const ops = changesOf([t('a/x'), t('a/y')], { 'a/x': { value: 1 }, 'a/y': { value: 2 } });

  it('is traced to its task by position or by the id in the error', () => {
    expect(failedIdsOf(ops, [{ n: 1, ok: true }, { n: 2, ok: false }])).toEqual(new Set(['a/y']));
    expect(failedIdsOf(ops, [{ n: 9, ok: false, error: { details: { id: 'a/x' } } }])).toEqual(new Set(['a/x']));
    expect(failedIdsOf(ops, [{ n: 1, ok: true }])).toEqual(new Set());
  });

  it('is unknown when no task can be named', () => {
    expect(failedIdsOf(ops, [{ n: 9, ok: false }])).toBeNull();
  });
});
