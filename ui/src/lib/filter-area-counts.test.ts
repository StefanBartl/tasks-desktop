// The number beside each area in the choice of the areas: how many tasks the filter would keep with that area as its
// only one, under the other parts of the filter.
import { describe, expect, it } from 'vitest';
import { applyFilter, areaCounts, emptyFilter, type Filter } from './filter';
import { task } from './fixtures';

const list = [
  task('a/one', { status: 'open', tags: ['ui'] }),
  task('a/two', { status: 'doing' }),
  task('b/one', { status: 'open', tags: ['ui'] }),
  task('b/two', { status: 'open' }),
  task('c/one', { status: 'doing', tags: ['ui'] }),
];
// a/one links to b, b/two to c: the tasks that connect areas.
const touched = new Map<string, ReadonlySet<string>>([
  ['a/one', new Set(['a', 'b'])],
  ['b/two', new Set(['b', 'c'])],
]);
const areas = ['a', 'b', 'c', 'gone'];
const f = (part: Partial<Filter>): Filter => ({ ...emptyFilter, ...part });

/** What the list would show with only `area` ticked: the plain way, one filter per area. */
const byHand = (filter: Filter) =>
  new Map(areas.map((area) => [area, applyFilter(list, { ...filter, areas: [area] }, '2026-10-30', touched).length]));

describe('the number of tasks beside each area', () => {
  it('counts the tasks of each area, an area without tasks with 0', () => {
    expect(areaCounts(list, f({}), areas, '2026-10-30', touched)).toEqual(
      new Map([
        ['a', 2],
        ['b', 2],
        ['c', 1],
        ['gone', 0],
      ]),
    );
  });

  it('counts under the other parts of the filter, whatever areas are ticked now', () => {
    const filter = f({ statuses: ['open'], fields: { tag: ['ui'] }, areas: ['c'] });
    expect(areaCounts(list, filter, areas, '2026-10-30', touched)).toEqual(
      new Map([
        ['a', 1],
        ['b', 1],
        ['c', 0],
        ['gone', 0],
      ]),
    );
  });

  it('is what the list shows with that area alone, also with "connects areas" on', () => {
    for (const filter of [f({}), f({ statuses: ['open'] }), f({ cross: true }), f({ cross: true, areas: ['a', 'b'] }), f({ query: 'two' })]) {
      expect(areaCounts(list, filter, areas, '2026-10-30', touched)).toEqual(byHand(filter));
    }
  });
});
