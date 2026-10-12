import { describe, expect, it } from 'vitest';
import { hasHidden, markHidden } from './text';

describe('hidden characters', () => {
  it('marks bidi and zero-width characters', () => {
    const text = 'a‮b​c';
    expect(hasHidden(text)).toBe(true);
    expect(markHidden(text)).toBe('a⟦U+202E⟧b⟦U+200B⟧c');
  });
  it('leaves plain text, umlauts and emoji alone', () => {
    const text = 'Käse 😀 中文';
    expect(hasHidden(text)).toBe(false);
    expect(markHidden(text)).toBe(text);
  });
});
