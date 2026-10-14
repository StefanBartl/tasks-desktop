import { describe, expect, it } from 'vitest';
import { moved, parseOrder } from './tiles';

const ALL = ['a', 'b', 'c', 'd'] as const;

describe('the order of the blocks', () => {
  it('falls back to the standard order for nothing, for damage and for the wrong shape', () => {
    for (const text of [null, '', '{', '"x"', '{"a":1}', '[]']) expect(parseOrder(text, ALL)).toEqual(['a', 'b', 'c', 'd']);
  });

  it('drops unknown and repeated entries and puts a missing block at the end', () => {
    expect(parseOrder('["c","x","c","a"]', ALL)).toEqual(['c', 'a', 'b', 'd']);
  });

  it('moves a block before or after another', () => {
    expect(moved(ALL, 'd', 'b', false)).toEqual(['a', 'd', 'b', 'c']);
    expect(moved(ALL, 'a', 'c', true)).toEqual(['b', 'c', 'a', 'd']);
    expect(moved(ALL, 'a', 'b', false)).toEqual(['a', 'b', 'c', 'd']);
  });

  it('changes nothing for an unknown block or the block itself', () => {
    expect(moved(ALL, 'a', 'a', true)).toEqual(['a', 'b', 'c', 'd']);
    expect(moved(ALL, 'a', 'z' as 'a', true)).toEqual(['a', 'b', 'c', 'd']);
  });
});
