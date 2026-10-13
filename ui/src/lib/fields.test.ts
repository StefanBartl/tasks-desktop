import { describe, expect, it } from 'vitest';
import { parseTags, tagsChanged, tagsText } from './fields';

describe('tags', () => {
  it('splits on commas, trims, drops empties and duplicates, keeps the order', () => {
    expect(parseTags(' ui,  docs ,, ui ,perf')).toEqual(['ui', 'docs', 'perf']);
    expect(parseTags('')).toEqual([]);
    expect(parseTags(' , ')).toEqual([]);
  });

  it('cuts a very long tag', () => {
    expect(parseTags('x'.repeat(200))[0]).toHaveLength(64);
  });

  it('shows the tags and notices a change only when there is one', () => {
    expect(tagsText(['a', 'b'])).toBe('a, b');
    expect(tagsText(undefined)).toBe('');
    expect(tagsChanged(['a', 'b'], 'a,b')).toBe(false);
    expect(tagsChanged(['a', 'b'], 'b, a')).toBe(true);
    expect(tagsChanged(undefined, '')).toBe(false);
    expect(tagsChanged(undefined, 'x')).toBe(true);
    expect(tagsChanged(['a'], '')).toBe(true);
  });
});
