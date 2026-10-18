import { describe, expect, it } from 'vitest';
import { applyOrder, orderOf, parseSort } from './sort';
import { task } from './fixtures';

const ids = (tasks: { id: string }[]) => tasks.map((t) => t.id);

describe('sort', () => {
  it('knows our words and falls back to the plan order for anything else', () => {
    expect(parseSort('roi')).toBe('roi');
    expect(parseSort('prio-effort')).toBe('prio-effort');
    for (const bad of ['', 'ROI', 'sideways', null, undefined, 3]) expect(parseSort(bad)).toBe('default');
  });

  it('lays the tasks along the order of the engine', () => {
    const tasks = [task('a/one'), task('a/two'), task('a/three')];
    expect(ids(applyOrder(tasks, orderOf(['a/three', 'a/one', 'a/two'])))).toEqual(['a/three', 'a/one', 'a/two']);
  });

  it('keeps the plan order without an order, and puts a task the order does not name after the named ones', () => {
    const tasks = [task('a/one'), task('a/new'), task('a/two'), task('a/newer')];
    expect(ids(applyOrder(tasks, null))).toEqual(['a/one', 'a/new', 'a/two', 'a/newer']);
    expect(ids(applyOrder(tasks, orderOf(['a/two', 'a/one'])))).toEqual(['a/two', 'a/one', 'a/new', 'a/newer']);
  });

  it('does not change the list it was given', () => {
    const tasks = [task('a/one'), task('a/two')];
    applyOrder(tasks, orderOf(['a/two', 'a/one']));
    expect(ids(tasks)).toEqual(['a/one', 'a/two']);
  });
});
