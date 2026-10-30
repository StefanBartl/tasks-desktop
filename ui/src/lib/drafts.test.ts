import { describe, expect, it } from 'vitest';
import { sameField, shownTask } from './drafts';

describe('the draft of the fields', () => {
  it('compares a value with what the file has: a missing key is null, lists by items', () => {
    expect(sameField(null, undefined)).toBe(true);
    expect(sameField('M', 'M')).toBe(true);
    expect(sameField('M', 'L')).toBe(false);
    expect(sameField(1, '1')).toBe(false);
    expect(sameField(['a', 'b'], ['a', 'b'])).toBe(true);
    expect(sameField(['a', 'b'], ['b', 'a'])).toBe(false);
    expect(sameField(['a'], 'a')).toBe(false);
    // the list fields of a task are [] when the file has none: emptying a list typed into is no change
    expect(sameField(null, [])).toBe(true);
    expect(sameField([], undefined)).toBe(true);
    expect(sameField(null, ['a'])).toBe(false);
  });

  it('shows the draft over the file: a value replaces, null takes the key away, the rest stays', () => {
    const task = { id: 'a/b', title: 'T', prio: 2, tags: ['x'] };
    expect(shownTask(task, { prio: 1, tags: null })).toEqual({ id: 'a/b', title: 'T', prio: 1 });
    expect(shownTask(task, {})).toEqual(task);
    expect(task.prio).toBe(2);
  });
});
