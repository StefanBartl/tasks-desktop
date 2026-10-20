import { describe, expect, it } from 'vitest';
import type { TaskEntry } from './contract';
import { cellsOf, countOf, dropOps, groupsOf, neighbourGroup, NONE, valuesOf, type Grouping } from './groups';

const task = (id: string, extra: Partial<TaskEntry> = {}) => ({ id, area: 'a', etag: `sha256:${id}`, ...extra }) as unknown as TaskEntry;
const field = (name: Grouping['field'], values: string[], extra: Partial<Grouping> = {}): Grouping => ({
  field: name,
  values,
  truncated: false,
  writable: true,
  value_type: 'string',
  mode: 'set',
  ...extra,
});
const STATUS = field('status', ['doing', 'open', 'parked']);
const PRIO = field('prio', ['1', '2', '3'], { value_type: 'number' });
const TAGS = field('tags', ['ui', 'bug'], { mode: 'tags', multi: true });
const AREA = field('area', ['a', 'b'], { mode: 'move_area' });
const STATE = field('state', ['ready', 'waiting'], { mode: undefined, writable: false });

describe('the value a task has for a field', () => {
  it('reads the field by the name the engine gives, a number as its word, a list as its words, and nothing as none', () => {
    expect(valuesOf(task('x', { status: 'open' }), STATUS)).toEqual(['open']);
    expect(valuesOf(task('x', { prio: 2 }), PRIO)).toEqual(['2']);
    expect(valuesOf(task('x', { tags: ['ui', 'bug'] }), TAGS)).toEqual(['ui', 'bug']);
    expect(valuesOf(task('x', {}), PRIO)).toEqual([]);
    expect(valuesOf(task('x', { tags: [] }), TAGS)).toEqual([]);
    // The derived field is the readiness.
    expect(valuesOf(task('x', { readiness: { state: 'waiting' } } as unknown as Partial<TaskEntry>), STATE)).toEqual(['waiting']);
  });
});

describe('the groups', () => {
  it('has one group for each value the engine names, in its order, and keeps the empty ones as places to drop', () => {
    const groups = groupsOf([task('a', { status: 'open' }), task('b', { status: 'doing' }), task('c', { status: 'open' })], STATUS);
    expect(groups.map((g) => [g.value, g.items.map((i) => i.id)])).toEqual([
      ['doing', ['b']],
      ['open', ['a', 'c']],
      ['parked', []],
    ]);
    expect(groups.map(countOf)).toEqual([1, 2, 0]);
  });

  it('keeps the order the tasks came in, and never sorts them', () => {
    const groups = groupsOf([task('z', { status: 'open' }), task('a', { status: 'open' })], STATUS);
    expect(groups[1]?.items.map((i) => i.id)).toEqual(['z', 'a']);
  });

  it('puts the tasks that have none in a last group of their own, and only when there are some', () => {
    expect(groupsOf([task('a', { prio: 1 })], PRIO).some((g) => g.value === NONE)).toBe(false);
    const groups = groupsOf([task('a', { prio: 1 }), task('b', {})], PRIO);
    expect(groups.at(-1)).toMatchObject({ value: NONE });
    expect(groups.at(-1)?.items.map((i) => i.id)).toEqual(['b']);
  });

  it('puts a value the engine did not name after the named ones, in the order it is met', () => {
    const groups = groupsOf([task('a', { status: 'frozen' as never }), task('b', { status: 'open' }), task('c', { status: 'melted' as never })], STATUS);
    expect(groups.map((g) => g.value)).toEqual(['doing', 'open', 'parked', 'frozen', 'melted']);
  });

  it('puts a task with several tags in each of their groups', () => {
    const groups = groupsOf([task('a', { tags: ['ui', 'bug'] }), task('b', { tags: ['bug'] })], TAGS);
    expect(groups.map((g) => [g.value, g.items.map((i) => i.id)])).toEqual([
      ['ui', ['a']],
      ['bug', ['a', 'b']],
    ]);
  });
});

describe('a key to the next group', () => {
  it('goes one group over, and nowhere at the end or from a group that is not there', () => {
    const groups = groupsOf([], STATUS);
    expect(neighbourGroup(groups, 'doing', 1)).toBe('open');
    expect(neighbourGroup(groups, 'open', -1)).toBe('doing');
    expect(neighbourGroup(groups, 'doing', -1)).toBeNull();
    expect(neighbourGroup(groups, 'parked', 1)).toBeNull();
    expect(neighbourGroup(groups, 'nowhere', 1)).toBeNull();
  });
});

describe('a drop', () => {
  it('sets the field of the file, with the version the card showed', () => {
    expect(dropOps(task('a', { status: 'open' }), STATUS, 'open', 'doing')).toEqual({
      kind: 'ops',
      ops: [{ op: 'set', id: 'a', patch: { status: 'doing' }, if_match: 'sha256:a' }],
    });
  });

  it('writes a number as a number', () => {
    expect(dropOps(task('a', { prio: 3 }), PRIO, '3', '1')).toEqual({
      kind: 'ops',
      ops: [{ op: 'set', id: 'a', patch: { prio: 1 }, if_match: 'sha256:a' }],
    });
  });

  it('takes the key out for the group of none, except for the status the file must have', () => {
    expect(dropOps(task('a', { prio: 3 }), PRIO, '3', NONE)).toEqual({
      kind: 'ops',
      ops: [{ op: 'set', id: 'a', patch: { prio: null }, if_match: 'sha256:a' }],
    });
    expect(dropOps(task('a', { status: 'open' }), STATUS, 'open', NONE)).toEqual({ kind: 'refused', reason: 'required' });
  });

  it('refuses a drop on the group it came from, a value the engine does not name and a field it does not write', () => {
    expect(dropOps(task('a', { status: 'open' }), STATUS, 'open', 'open')).toEqual({ kind: 'refused', reason: 'same' });
    expect(dropOps(task('a', { status: 'open' }), STATUS, 'open', 'frozen')).toEqual({ kind: 'refused', reason: 'unknown' });
    expect(dropOps(task('a', {}), STATE, 'ready', 'waiting')).toEqual({ kind: 'refused', reason: 'read_only' });
    expect(dropOps(task('a', {}), { ...STATUS, writable: false }, 'open', 'doing')).toEqual({ kind: 'refused', reason: 'read_only' });
  });

  it('writes no version when the card has none', () => {
    const bare = { id: 'a', area: 'a', status: 'open' } as unknown as TaskEntry;
    expect(dropOps(bare, STATUS, 'open', 'doing')).toEqual({ kind: 'ops', ops: [{ op: 'set', id: 'a', patch: { status: 'doing' } }] });
  });

  it('takes the tag of the group left and sets the tag of the group entered, as one set of the whole list', () => {
    expect(dropOps(task('a', { tags: ['ui', 'x'] }), TAGS, 'ui', 'bug')).toEqual({
      kind: 'ops',
      ops: [{ op: 'set', id: 'a', patch: { tags: ['x', 'bug'] }, if_match: 'sha256:a' }],
    });
  });

  it('with Ctrl copies: the tag of the group left stays', () => {
    expect(dropOps(task('a', { tags: ['ui'] }), TAGS, 'ui', 'bug', true)).toEqual({
      kind: 'ops',
      ops: [{ op: 'set', id: 'a', patch: { tags: ['ui', 'bug'] }, if_match: 'sha256:a' }],
    });
  });

  it('does not double a tag the task has already, and refuses a drop that changes nothing', () => {
    expect(dropOps(task('a', { tags: ['ui', 'bug'] }), TAGS, 'ui', 'bug')).toEqual({
      kind: 'ops',
      ops: [{ op: 'set', id: 'a', patch: { tags: ['bug'] }, if_match: 'sha256:a' }],
    });
    expect(dropOps(task('a', { tags: ['ui', 'bug'] }), TAGS, 'ui', 'bug', true)).toEqual({ kind: 'refused', reason: 'same' });
  });

  it('takes the last tag away as no tags, and sets a tag on a task that had none (from the group of none)', () => {
    expect(dropOps(task('a', { tags: ['ui'] }), TAGS, 'ui', NONE)).toEqual({
      kind: 'ops',
      ops: [{ op: 'set', id: 'a', patch: { tags: null }, if_match: 'sha256:a' }],
    });
    expect(dropOps(task('a', {}), TAGS, NONE, 'ui')).toEqual({
      kind: 'ops',
      ops: [{ op: 'set', id: 'a', patch: { tags: ['ui'] }, if_match: 'sha256:a' }],
    });
  });

  it('leaves the area to the move of the file, which is asked first', () => {
    expect(dropOps(task('a'), AREA, 'a', 'b')).toEqual({ kind: 'move_area', id: 'a', area: 'b' });
    expect(dropOps(task('a'), AREA, 'a', NONE)).toEqual({ kind: 'refused', reason: 'required' });
  });
});

describe('the cells of a matrix', () => {
  it('has every column in every row, an empty cell included, and counts a task in each cell it belongs to', () => {
    const items = [
      task('a', { status: 'open', prio: 1 }),
      task('b', { status: 'open', prio: 2 }),
      task('c', { status: 'doing', prio: 1 }),
    ];
    const cells = cellsOf(items, STATUS, PRIO);
    expect(cells).toHaveLength(9);
    const at = (row: string, column: string) => cells.find((c) => c.row === row && c.column === column)?.items.map((i) => i.id);
    expect(at('open', '1')).toEqual(['a']);
    expect(at('open', '2')).toEqual(['b']);
    expect(at('doing', '1')).toEqual(['c']);
    expect(at('parked', '3')).toEqual([]);
  });

  it('shows the column of none in every row as soon as some task has none, and a list field in each of its cells', () => {
    const items = [task('a', { status: 'open', prio: 1, tags: ['ui', 'bug'] }), task('b', { status: 'doing' })];
    const cells = cellsOf(items, STATUS, PRIO);
    expect(new Set(cells.map((c) => c.column))).toEqual(new Set(['1', '2', '3', NONE]));
    expect(cells.find((c) => c.row === 'doing' && c.column === NONE)?.items.map((i) => i.id)).toEqual(['b']);
    const tagged = cellsOf(items, TAGS, STATUS);
    expect(tagged.filter((c) => c.items.some((i) => i.id === 'a')).map((c) => `${c.row}/${c.column}`)).toEqual(['ui/open', 'bug/open']);
  });
});
