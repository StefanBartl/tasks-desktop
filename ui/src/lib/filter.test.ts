import { describe, expect, it } from 'vitest';
import {
  applyFilter,
  areaLabel,
  areaOptions,
  emptyFilter,
  moveSelection,
  toggled,
  waitingForMe,
} from './filter';
import { task } from './fixtures';

const list = [
  task('a/one', { status: 'doing', actor: 'me' }),
  task('a/two', { status: 'open', actor: 'cdx' }),
  task('b/three', { status: 'decision' }),
];

describe('filter', () => {
  it('keeps the engine order and only removes', () => {
    expect(applyFilter(list, { ...emptyFilter, areas: ['a'] }).map((t) => t.id)).toEqual([
      'a/one',
      'a/two',
    ]);
    expect(applyFilter(list, emptyFilter).map((t) => t.id)).toEqual(['a/one', 'a/two', 'b/three']);
  });
  it('applies the chosen values together: any of a kind, all kinds', () => {
    const ids = (f: Partial<typeof emptyFilter>) =>
      applyFilter(list, { ...emptyFilter, ...f }).map((t) => t.id);
    expect(ids({ areas: ['a', 'b'] })).toEqual(['a/one', 'a/two', 'b/three']);
    expect(ids({ statuses: ['doing', 'decision'] })).toEqual(['a/one', 'b/three']);
    expect(ids({ areas: ['b'], statuses: ['doing', 'decision'] })).toEqual(['b/three']);
    // A task without an actor is chosen by `none`.
    expect(ids({ actors: ['none'] })).toEqual(['b/three']);
    expect(ids({ actors: ['me', 'none'] })).toEqual(['a/one', 'b/three']);
  });
  it('switches a value on and off', () => {
    expect(toggled([], 'a')).toEqual(['a']);
    expect(toggled(['a', 'b'], 'a')).toEqual(['b']);
  });
  it('leaves the wkdbook prefix out of an area name unless it would clash', () => {
    const all = ['lib.nvim', 'wkdbook-tasks.nvim', 'WKDBook-Acme', 'wkdbook-lib.nvim'];
    expect(areaLabel('wkdbook-tasks.nvim', all)).toBe('tasks.nvim');
    expect(areaLabel('WKDBook-Acme', all)).toBe('Acme');
    expect(areaLabel('wkdbook-lib.nvim', all)).toBe('wkdbook-lib.nvim');
    expect(areaLabel('lib.nvim', all)).toBe('lib.nvim');
  });
  it('needs every word of the query, in any order', () => {
    expect(applyFilter(list, { ...emptyFilter, query: 'three b/' }).length).toBe(1);
    expect(applyFilter(list, { ...emptyFilter, query: 'one zzz' }).length).toBe(0);
  });
  it('moves the selection and stays inside the list', () => {
    expect(moveSelection(list, null, 1)).toBe('a/one');
    expect(moveSelection(list, null, -1)).toBe('b/three');
    expect(moveSelection(list, 'a/one', 1)).toBe('a/two');
    expect(moveSelection(list, 'b/three', 1)).toBe('b/three');
    expect(moveSelection(list, 'gone', 1)).toBe('a/one');
    expect(moveSelection([], 'a/one', 1)).toBeNull();
  });
  it('finds what waits for a decision of the user', () => {
    expect(waitingForMe(list).map((t) => t.id)).toEqual(['b/three']);
  });
});

describe('areaOptions', () => {
  const all = ['wkdbook-tasks.nvim', 'lib.nvim'];

  it('names tasks-desktop beside the area its tasks are kept in', () => {
    const options = areaOptions(all, all, true, 'note');
    const app = options.find((o) => o.value === 'wkdbook-tasks.nvim');
    expect(app?.label).toBe('tasks.nvim');
    expect(app?.suffix).toBe('tasks-desktop');
    expect(app?.title).toContain('note');
  });

  it('leaves every other area without a suffix', () => {
    const options = areaOptions(all, all, true, 'note');
    expect(options.find((o) => o.value === 'lib.nvim')?.suffix).toBeUndefined();
  });

  it('sorts by the label shown', () => {
    expect(areaOptions(all, all, true, 'note').map((o) => o.label)).toEqual(['lib.nvim', 'tasks.nvim']);
  });
});
