import { describe, expect, it } from 'vitest';
import { MAX_SIZE, MIN_SIZE, clampSize, parseSizes, serializeSizes, sizeChanged, withSize } from './sizes';

describe('the sizes of the blocks', () => {
  it('stay between the smallest and the largest', () => {
    expect(clampSize({ w: 1, h: 1 })).toEqual(MIN_SIZE);
    expect(clampSize({ w: 1e9, h: 1e9 })).toEqual(MAX_SIZE);
    expect(clampSize({ w: 300.4, h: 200.6 })).toEqual({ w: 300, h: 201 });
  });

  it('are set per block and given back to the layout with null', () => {
    const s = withSize({}, 'next', { w: 400, h: 300 });
    expect(s).toEqual({ next: { w: 400, h: 300 } });
    expect(withSize(s, 'next', null)).toEqual({});
  });

  it('are remembered, and an entry that cannot be read is left out', () => {
    const s = { next: { w: 400, h: 300 }, list: { w: 900, h: 600 } };
    expect(parseSizes(serializeSizes(s))).toEqual(s);
    expect(parseSizes('nope')).toEqual({});
    expect(parseSizes(JSON.stringify({ a: { w: 'x', h: 3 }, b: { w: 10, h: 10 } }))).toEqual({ b: MIN_SIZE });
  });

  it('count as changed only past the rounding of a pixel', () => {
    expect(sizeChanged({ w: 100, h: 100 }, { w: 100.5, h: 101 })).toBe(false);
    expect(sizeChanged({ w: 100, h: 100 }, { w: 140, h: 100 })).toBe(true);
  });
});
