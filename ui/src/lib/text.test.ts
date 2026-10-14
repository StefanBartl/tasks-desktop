import { describe, expect, it } from 'vitest';
import { editableBody, hasHidden, markHidden, MAX_BODY_EDIT } from './text';

describe('hidden characters', () => {
  it('marks bidi and zero-width characters', () => {
    const text = 'a\u202Eb\u200Bc';
    expect(hasHidden(text)).toBe(true);
    expect(markHidden(text)).toBe('a⟦U+202E⟧b⟦U+200B⟧c');
  });
  it('leaves plain text, umlauts and emoji alone', () => {
    const text = 'Käse 😀 中文';
    expect(hasHidden(text)).toBe(false);
    expect(markHidden(text)).toBe(text);
  });
});

describe('the text of a task that may be edited', () => {
  it('is whole and not longer than the engine takes', () => {
    expect(editableBody('\nshort\n', false)).toBe(true);
    expect(editableBody('x'.repeat(MAX_BODY_EDIT), false)).toBe(true);
    expect(editableBody('x'.repeat(MAX_BODY_EDIT + 1), false)).toBe(false);
    expect(editableBody('short', true)).toBe(false);
  });
});
