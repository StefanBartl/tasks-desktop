import { describe, expect, it } from 'vitest';
import type { TaskEntry } from './contract';
import { columnsOf, groupLabel, neighbourColumn, placeNear, placeOf, priorityOf, runKey, stageOf, stepInGroup } from './board';

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

  it('shows the priority the engine gives, never a part of the group key', () => {
    const task = (group: string | undefined, eff_prio?: number) =>
      ({ id: 'x', group, readiness: eff_prio === undefined ? { state: 'ready' } : { state: 'ready', eff_prio } }) as unknown as TaskEntry;
    expect(groupLabel(task('open|2', 2))).toBe('2');
    expect(groupLabel(task('open|-'))).toBe('-');
    // a key in a form the page does not know says nothing: the number does
    expect(groupLabel(task('3 | open', 4))).toBe('4');
    expect(priorityOf(task('open|9', 4))).toBe(4);
    expect(groupLabel(task(undefined, 2))).toBeNull();
    expect(priorityOf({ id: 'x' } as unknown as TaskEntry)).toBeNull();
    // An engine that does not promise the number is not read as "no priority": no label at all.
    expect(groupLabel(task('open|2'), false)).toBeNull();
  });
});

describe('stages', () => {
  const staged = (id: string, group: string, stage: number) =>
    ({
      id,
      status: 'open',
      group,
      etag: `e-${id}`,
      readiness: { state: 'ready', stage, ...(/\|(\d+)$/.test(group) ? { eff_prio: Number(group.split('|')[1]) } : {}) },
    }) as unknown as TaskEntry;
  // As the engine lists them: stage 0 first, so A (P1), C (P2) and then B (P1, stage 1) share a priority across a border.
  const column = [staged('a', 'open|1', 0), staged('c', 'open|2', 0), staged('b', 'open|1', 1), staged('d', 'open|1', 1)];

  it('is another run for the same priority in another stage', () => {
    expect(runKey(column[0] as TaskEntry)).not.toBe(runKey(column[2] as TaskEntry));
    expect(runKey(column[2] as TaskEntry)).toBe(runKey(column[3] as TaskEntry));
    expect(stageOf(column[2] as TaskEntry)).toBe(1);
    expect(stageOf({ id: 'x' } as unknown as TaskEntry)).toBeNull();
  });

  it('does not place a card beside one of the same priority in another stage (the engine refuses it)', () => {
    expect(placeNear(column, 'a', { id: 'b', place: 'after' })).toEqual({ kind: 'refused', reason: 'group' });
    expect(placeNear(column, 'b', { id: 'd', place: 'after' })).toMatchObject({ kind: 'ok' });
  });

  it('offers to carry the priority along when only the priority differs', () => {
    const list = [staged('a', 'open|1', 0), staged('c', 'open|2', 0), staged('e', 'open|-', 0)];
    expect(placeNear(list, 'a', { id: 'c', place: 'after' })).toEqual({
      kind: 'prio',
      id: 'a',
      from: '1',
      prio: 2,
      ops: [
        { op: 'set', id: 'a', patch: { prio: 2 }, if_match: 'e-a' },
        { op: 'reorder', id: 'a', after: 'c', group: 'open|2' },
      ],
    });
    // Beside a card without a priority there is none to set; another stage is another run.
    expect(placeNear(list, 'a', { id: 'e', place: 'after' })).toEqual({ kind: 'refused', reason: 'group' });
    // An engine that does not promise the number is not read as "no priority": nothing is carried along.
    expect(placeNear(list, 'a', { id: 'c', place: 'after' }, false)).toEqual({ kind: 'refused', reason: 'group' });
  });

  it('steps inside the run of its stage only', () => {
    expect(stepInGroup(column, 'a', 1)).toEqual({ kind: 'refused', reason: 'edge' });
    expect(stepInGroup(column, 'b', 1)).toMatchObject({ kind: 'ok', op: { id: 'b', after: 'd' } });
    expect(stepInGroup(column, 'd', -1)).toMatchObject({ kind: 'ok', op: { id: 'd', before: 'b' } });
  });
});
