import { describe, expect, it } from 'vitest';
import { editableBody, markHidden, MAX_BODY_EDIT } from './text';

describe('the text of a task that may be edited', () => {
  it('is whole and not longer than the engine takes', () => {
    expect(editableBody('\nshort\n', false)).toBe(true);
    expect(editableBody('x'.repeat(MAX_BODY_EDIT), false)).toBe(true);
    expect(editableBody('x'.repeat(MAX_BODY_EDIT + 1), false)).toBe(false);
    expect(editableBody('short', true)).toBe(false);
  });
  it('takes the hidden-character guard from the kit', () => {
    expect(markHidden('a' + String.fromCharCode(0x202e) + 'b')).toBe('a⟦U+202E⟧b');
  });
});
