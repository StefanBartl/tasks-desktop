import { describe, expect, it } from 'vitest';
import { pieces } from './marks';

describe('pieces', () => {
  it('cuts the text at the marks', () => {
    expect(pieces('a needle b', [[2, 8]])).toEqual([
      { text: 'a ', mark: false },
      { text: 'needle', mark: true },
      { text: ' b', mark: false },
    ]);
  });
  it('counts in UTF-16 units, as the hub does', () => {
    // The emoji is two units.
    const text = '😀 needle';
    expect(pieces(text, [[3, 9]]).find((p) => p.mark)?.text).toBe('needle');
  });
  it('leaves out a mark that cannot be right', () => {
    const text = 'abc';
    for (const bad of [[2, 1], [1, 9], [-1, 2], [1.5, 2], [1, 1]] as [number, number][]) {
      expect(pieces(text, [bad]), JSON.stringify(bad)).toEqual([{ text: 'abc', mark: false }]);
    }
    // Overlapping marks: the second one is dropped.
    expect(pieces('abcdef', [[0, 3], [2, 5]]).filter((p) => p.mark).length).toBe(1);
  });
  it('is the whole text without marks', () => {
    expect(pieces('plain', [])).toEqual([{ text: 'plain', mark: false }]);
    expect(pieces('', [])).toEqual([]);
  });
});
