import { describe, expect, it } from 'vitest';
import { takeInjected } from './inject';

describe('takeInjected', () => {
  it('returns the value and removes the global', () => {
    const win = { __X: 'abc' };
    expect(takeInjected(win, '__X')).toBe('abc');
    expect('__X' in win).toBe(false);
  });

  it('returns undefined for a global that is not there', () => {
    expect(takeInjected({}, '__X')).toBeUndefined();
  });

  it('still returns the value, and clears it where it can, when the global cannot be deleted', () => {
    const win = {} as { __X?: string };
    Object.defineProperty(win, '__X', { value: 'abc', writable: true, configurable: false });
    expect(takeInjected(win, '__X')).toBe('abc');
    expect(win.__X).toBeUndefined();
  });

  it('does not throw when the global can neither be deleted nor overwritten', () => {
    const win = {} as { __X?: string };
    Object.defineProperty(win, '__X', { value: 'abc', writable: false, configurable: false });
    expect(takeInjected(win, '__X')).toBe('abc');
  });
});
