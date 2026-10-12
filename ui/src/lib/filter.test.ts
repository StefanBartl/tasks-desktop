import { describe, expect, it } from 'vitest';
import { applyFilter, emptyFilter, moveSelection, waitingForMe } from './filter';
import { task } from './fixtures';

const list = [
  task('a/one', { status: 'doing', actor: 'me' }),
  task('a/two', { status: 'open', actor: 'cdx' }),
  task('b/three', { status: 'decision' }),
];

describe('filter', () => {
  it('keeps the engine order and only removes', () => {
    expect(applyFilter(list, { ...emptyFilter, area: 'a' }).map((t) => t.id)).toEqual([
      'a/one',
      'a/two',
    ]);
    expect(applyFilter(list, emptyFilter).map((t) => t.id)).toEqual(['a/one', 'a/two', 'b/three']);
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
