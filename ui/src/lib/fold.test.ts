import { describe, expect, it } from 'vitest';
import {
  allButtonFold,
  emptyFolds,
  foldOf,
  nextAll,
  nextFold,
  parseFolds,
  previousFold,
  serializeFolds,
  withAll,
  withFold,
} from './fold';

describe('the folds of the blocks of a view', () => {
  it('go open, folded, narrow and round to open', () => {
    expect(nextFold('open')).toBe('folded');
    expect(nextFold('folded')).toBe('narrow');
    expect(nextFold('narrow')).toBe('open');
  });

  it('keep only what is not open', () => {
    expect(foldOf({}, '3')).toBe('open');
    const f = withFold({}, '3', 'narrow');
    expect(f).toEqual({ '3': 'narrow' });
    expect(withFold(f, '3', 'open')).toEqual({});
  });

  it('move all blocks one step on together, and make mixed ones alike first', () => {
    const keys = ['0', '1', '2'];
    expect(nextAll({}, keys)).toBe('folded');
    expect(nextAll(withAll({}, keys, 'folded'), keys)).toBe('narrow');
    expect(nextAll(withAll({}, keys, 'narrow'), keys)).toBe('open');
    expect(nextAll({ '1': 'narrow' }, keys)).toBe('folded');
    expect(withAll({ x: 'folded' }, keys, 'narrow')).toEqual({ x: 'folded', '0': 'narrow', '1': 'narrow', '2': 'narrow' });
    expect(withAll(withAll({}, keys, 'narrow'), keys, 'open')).toEqual({});
  });

  it('show the button for all at the step before the one its press reaches', () => {
    const keys = ['0', '1'];
    // Nothing folded: the press folds them all, so the button stands at "open" (its next step is "folded").
    expect(allButtonFold({}, keys)).toBe('open');
    expect(nextFold(allButtonFold({}, keys))).toBe(nextAll({}, keys));
    const narrow = withAll({}, keys, 'narrow');
    expect(nextFold(allButtonFold(narrow, keys))).toBe('open');
    expect(previousFold('open')).toBe('narrow');
  });

  it('are remembered per view, and what cannot be read is open', () => {
    const memory = { plan: { '0': 'folded' as const }, board: { doing: 'narrow' as const } };
    expect(parseFolds(serializeFolds(memory))).toEqual(memory);
    expect(parseFolds('{')).toEqual(emptyFolds());
    expect(parseFolds(JSON.stringify({ plan: { '0': 'gone', '1': 'narrow' }, board: [] }))).toEqual({
      plan: { '1': 'narrow' },
      board: {},
    });
  });
});
