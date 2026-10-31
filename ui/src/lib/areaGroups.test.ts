import { describe, expect, it } from 'vitest';
import { expandAreas, isAreaGroup, NO_AREA, type AreaGroupInfo } from './areaGroups';
import type { TaskEntry } from './contract';
import { applyFilter, freshFilter } from './filter';

const groups: AreaGroupInfo[] = [
  { name: 'nvim', members: ['lib.nvim', 'tasks.nvim'], open: 3 },
  { name: 'native', members: ['tasks-desktop', 'takt'], open: 2 },
];
const areas = ['lib.nvim', 'tasks.nvim', 'tasks-desktop', 'takt', 'ALL'];

describe('expandAreas', () => {
  it('puts the members in the place of a group', () => {
    expect(expandAreas(['nvim'], groups, areas)).toEqual(['lib.nvim', 'tasks.nvim']);
  });

  it('keeps areas, takes each area once, keeps the order of the choice', () => {
    expect(expandAreas(['ALL', 'nvim', 'lib.nvim', 'native'], groups, areas)).toEqual([
      'ALL',
      'lib.nvim',
      'tasks.nvim',
      'tasks-desktop',
      'takt',
    ]);
  });

  it('returns the same array when nothing is a group', () => {
    const chosen = ['ALL'];
    expect(expandAreas(chosen, groups, areas)).toBe(chosen);
    expect(expandAreas(chosen, [], areas)).toBe(chosen);
  });

  it('lets an area of the same name win over a group', () => {
    expect(expandAreas(['nvim'], groups, [...areas, 'nvim'])).toEqual(['nvim']);
    expect(isAreaGroup('nvim', groups, [...areas, 'nvim'])).toBe(false);
    expect(isAreaGroup('nvim', groups, areas)).toBe(true);
  });

  it('a group without members keeps nothing (not every area)', () => {
    const empty = expandAreas(['empty'], [{ name: 'empty', members: [], open: 0 }], areas);
    expect(empty).toEqual([NO_AREA]);
    const task = { id: 'ALL/x', area: 'ALL', title: 'x' } as unknown as TaskEntry;
    expect(applyFilter([task], { ...freshFilter(), areas: [...empty] })).toEqual([]);
  });
});
