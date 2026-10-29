import { describe, expect, it } from 'vitest';
import { routedTask, taskRoute, withTaskRoute } from './route';

describe('the route of a task in a window of its own', () => {
  it('names the task in the fragment and reads it back', () => {
    expect(taskRoute('lib.nvim/alpha')).toBe('#task=lib.nvim%2Falpha');
    for (const id of ['lib.nvim/alpha', 'a b/ä&ö=#?', 'x/y']) expect(routedTask(taskRoute(id))).toBe(id);
    expect(routedTask('task=pub%2Fa')).toBe('pub/a');
    expect(routedTask('#pair=abc&task=pub%2Fa')).toBe('pub/a');
  });

  it('takes no task from another fragment, a broken one, or an id that cannot be one', () => {
    expect(routedTask('')).toBeNull();
    expect(routedTask('#pair=0123')).toBeNull();
    expect(routedTask('#task=')).toBeNull();
    expect(routedTask('#task=%E0%A4%A')).toBeNull();
    expect(routedTask(`#task=${'a'.repeat(301)}`)).toBeNull();
    expect(routedTask('#task=a%0Ab')).toBeNull();
    expect(routedTask('#tasks=pub%2Fa')).toBeNull();
  });

  it('sets the task of a fragment or takes it out, and keeps the rest of it', () => {
    expect(withTaskRoute('#task=pub%2Fa', null)).toBe('');
    expect(withTaskRoute('', null)).toBe('');
    expect(withTaskRoute('#', null)).toBe('');
    expect(withTaskRoute('#other=1&task=pub%2Fa', null)).toBe('#other=1');
    expect(withTaskRoute('#task=pub%2Fa', 'pub/b')).toBe('#task=pub%2Fb');
    expect(withTaskRoute('#other=1', 'pub/a')).toBe('#task=pub%2Fa&other=1');
    expect(withTaskRoute('', 'pub/a')).toBe(taskRoute('pub/a'));
    expect(routedTask(withTaskRoute('#task=pub%2Fa&task=pub%2Fb', 'pub/c'))).toBe('pub/c');
  });
});
