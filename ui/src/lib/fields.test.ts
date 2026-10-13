import { describe, expect, it } from 'vitest';
import { badTag, parseTags, tagsChanged, tagsText } from './fields';

describe('tags', () => {
  it('splits on commas, trims, drops empties and duplicates, keeps the order', () => {
    expect(parseTags(' ui,  docs ,, ui ,perf')).toEqual(['ui', 'docs', 'perf']);
    expect(parseTags('')).toEqual([]);
    expect(parseTags(' , ')).toEqual([]);
  });

  it('does not cut a tag: the engine says its limit, and nothing is lost silently', () => {
    expect(parseTags('x'.repeat(200))[0]).toHaveLength(200);
    expect(parseTags('\u{1F600}'.repeat(40))[0]).toBe('\u{1F600}'.repeat(40));
  });

  it('finds the tag the engine would refuse', () => {
    expect(badTag(['ok', 'a#b', 'c'])).toBe('a#b');
    expect(badTag(['q"uote'])).toBe('q"uote');
    expect(badTag(["it's"])).toBe("it's");
    expect(badTag(['[x]'])).toBe('[x]');
    expect(badTag(['tab\there'])).toBe('tab\there');
    expect(badTag(['next\u0085line'])).toBe('next\u0085line');
    expect(badTag(['fine: but-ok 1.2', 'ünï'])).toBeNull();
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
