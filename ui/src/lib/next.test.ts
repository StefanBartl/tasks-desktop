import { describe, expect, it } from 'vitest';
import { effortWords } from './next';

describe('the next task of the overview', () => {
  it('says the effort as words, and "no effort" instead of a sign', () => {
    expect(effortWords('en', 'M')).toBe('effort M');
    expect(effortWords('de', 'M')).toBe('Aufwand M');
    expect(effortWords('en', undefined)).toBe('no effort');
    expect(effortWords('de', undefined)).toBe('kein Aufwand');
    expect(effortWords('en', '')).not.toContain('?');
  });
});
