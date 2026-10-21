import { matches } from 'appkit-ui/keymap';
import { describe, expect, it } from 'vitest';
import { keymap, pressOf } from './keymap';

// The tests run without a DOM: an event is the few fields the page reads.
const key = (init: Partial<KeyboardEvent> & { key: string }) =>
  ({ ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...init }) as KeyboardEvent;

describe('the keys of the page', () => {
  it('goes to the views with g and a letter, as the page always did', () => {
    expect(keymap.chord.prefix).toBe('g');
    expect(keymap.chord.targets).toEqual({ h: 'today', l: 'list', p: 'plan', b: 'board', i: 'inbox', v: 'views' });
    expect(keymap.chord.timeoutMs).toBe(1500);
  });

  it('opens the palette with Ctrl or Cmd and K, and with nothing else', () => {
    expect(matches(keymap.palette, pressOf(key({ key: 'k', ctrlKey: true })))).toBe(true);
    expect(matches(keymap.palette, pressOf(key({ key: 'K', metaKey: true })))).toBe(true);
    expect(matches(keymap.palette, pressOf(key({ key: 'k' })))).toBe(false);
    expect(matches(keymap.palette, pressOf(key({ key: 'k', ctrlKey: true, altKey: true })))).toBe(false);
  });
});
