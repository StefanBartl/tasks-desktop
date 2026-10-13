import { describe, expect, it } from 'vitest';
import type { TaskEntry } from './contract';
import { columnsOf, groupLabel, neighbourColumn, placeNear, placeOf, stepInGroup } from './board';

const card = (id: string, status: string, group: string, etag = `e-${id}`) =>
  ({ id, status, group, etag }) as unknown as TaskEntry;

const list = [
  card('a', 'doing', 'doing|1'),
  card('b', 'open', 'open|1'),
  card('c', 'open', 'open|1'),
  card('d', 'open', 'open|2'),
  card('e', 'open', 'open|1'),
  card('f', 'parked', 'parked|2'),
  { id: 'g', status: 'done' } as unknown as TaskEntry,
];

describe('columnsOf', () => {
  it('keeps the order of the engine in each column and leaves out what is not on the board', () => {
    const cols = columnsOf(list);
    expect(cols.open.map((t) => t.id)).toEqual(['b', 'c', 'd', 'e']);
    expect(cols.doing.map((t) => t.id)).toEqual(['a']);
    expect(cols.blocked).toEqual([]);
    expect(Object.values(cols).flat().some((t) => t.id === 'g')).toBe(false);
  });
});

describe('placeNear', () => {
  it('puts a card before or after another of its group, with the version that was shown', () => {
    expect(placeNear(list, 'e', { id: 'b', place: 'before' })).toEqual({
      kind: 'ok',
      op: { op: 'reorder', id: 'e', before: 'b', group: 'open|1', if_match: 'e-e' },
    });
    expect(placeNear(list, 'b', { id: 'e', place: 'after' })).toEqual({
      kind: 'ok',
      op: { op: 'reorder', id: 'b', after: 'e', group: 'open|1', if_match: 'e-b' },
    });
  });

  it('refuses another group, another status, itself and an unknown card', () => {
    expect(placeNear(list, 'b', { id: 'd', place: 'after' })).toEqual({ kind: 'refused', reason: 'group' });
    expect(placeNear(list, 'b', { id: 'a', place: 'after' })).toEqual({ kind: 'refused', reason: 'status' });
    expect(placeNear(list, 'b', { id: 'b', place: 'after' })).toEqual({ kind: 'refused', reason: 'self' });
    expect(placeNear(list, 'b', { id: 'zzz', place: 'after' })).toEqual({ kind: 'refused', reason: 'unknown' });
  });
});

describe('stepInGroup', () => {
  const open = columnsOf(list).open;

  it('steps over the cards of other groups: the neighbour is the next one of the same group', () => {
    // b, c, d(other group), e: from c down is e, not d
    expect(stepInGroup(open, 'c', 1)).toMatchObject({ kind: 'ok', op: { id: 'c', after: 'e' } });
    expect(stepInGroup(open, 'e', -1)).toMatchObject({ kind: 'ok', op: { id: 'e', before: 'c' } });
  });

  it('has nowhere to go at the edge of the group', () => {
    expect(stepInGroup(open, 'b', -1)).toEqual({ kind: 'refused', reason: 'edge' });
    expect(stepInGroup(open, 'e', 1)).toEqual({ kind: 'refused', reason: 'edge' });
    expect(stepInGroup(open, 'd', 1)).toEqual({ kind: 'refused', reason: 'edge' });
  });
});

describe('small helpers', () => {
  it('finds the column next to a status', () => {
    expect(neighbourColumn('open', 1)).toBe('parked');
    expect(neighbourColumn('open', -1)).toBe('blocked');
    expect(neighbourColumn('doing', -1)).toBeNull();
    expect(neighbourColumn('parked', 1)).toBeNull();
    expect(neighbourColumn('done', 1)).toBeNull();
    expect(neighbourColumn(undefined, 1)).toBeNull();
  });

  it('tells the half of a card a pointer is on', () => {
    expect(placeOf(110, 100, 40)).toBe('before');
    expect(placeOf(130, 100, 40)).toBe('after');
  });

  it('shows the priority part of the group', () => {
    expect(groupLabel('open|2')).toBe('2');
    expect(groupLabel('open|none')).toBe('none');
    expect(groupLabel('nopipe')).toBeNull();
    expect(groupLabel(undefined)).toBeNull();
  });
});
