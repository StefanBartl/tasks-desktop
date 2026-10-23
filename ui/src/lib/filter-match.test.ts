// "Any of the chosen values" and "all of them": only for the fields a task holds several values of (tags,
// categories); remembered with the filter, named on the chip, and not taken into a saved view.
import { describe, expect, it } from 'vitest';
import {
  applyFilter,
  emptyFilter,
  freshFilter,
  isMultiKey,
  parseFilter,
  serializeFilter,
  wantsAll,
  withMatch,
  type Filter,
} from './filter';
import { chipJoins, chipLabel } from './filter-chips';
import { task } from './fixtures';
import { selectOfFilter } from './views';

const list = [
  task('a/ui-only', { tags: ['ui'] }),
  task('a/ui-and-menu', { tags: ['ui', 'menu'] }),
  task('a/menu-only', { tags: ['menu'] }),
  task('a/none', {}),
];
const ids = (f: Partial<Filter>) => applyFilter(list, { ...emptyFilter, ...f }).map((t) => t.id);

describe('any or all of the chosen tags', () => {
  it('takes a task with any of them by default (OR)', () => {
    expect(ids({ fields: { tag: ['ui', 'menu'] } })).toEqual(['a/ui-only', 'a/ui-and-menu', 'a/menu-only']);
  });

  it('takes only a task with every one of them when all are wanted (AND)', () => {
    expect(ids({ fields: { tag: ['ui', 'menu'] }, matchAll: ['tag'] })).toEqual(['a/ui-and-menu']);
  });

  it('is the same for one chosen value', () => {
    expect(ids({ fields: { tag: ['ui'] }, matchAll: ['tag'] })).toEqual(ids({ fields: { tag: ['ui'] } }));
  });

  it('is offered only for the fields a task holds several values of', () => {
    expect(isMultiKey('tag')).toBe(true);
    expect(isMultiKey('category')).toBe(true);
    expect(isMultiKey('kind')).toBe(false);
    // A field with one value per task is never "all", whatever the memory says.
    expect(wantsAll({ ...emptyFilter, matchAll: ['tag'] }, 'kind')).toBe(false);
  });

  it('switches on and off without touching the other field', () => {
    const on = withMatch(withMatch(freshFilter(), 'tag', 'all'), 'category', 'all');
    expect(on.matchAll.sort()).toEqual(['category', 'tag']);
    expect(withMatch(on, 'tag', 'any').matchAll).toEqual(['category']);
  });

  it('is remembered, and a memory with an unknown or doubled field gives only the known ones', () => {
    const f = { ...freshFilter(), fields: { tag: ['ui'] }, matchAll: ['tag' as const] };
    expect(parseFilter(serializeFilter(f)).matchAll).toEqual(['tag']);
    expect(parseFilter(JSON.stringify({ matchAll: ['tag', 'kind', 'tag', 7] })).matchAll).toEqual(['tag']);
    expect(parseFilter(JSON.stringify({})).matchAll).toEqual([]);
  });

  it('says so on the chip', () => {
    const f = { ...freshFilter(), fields: { tag: ['ui'] }, matchAll: ['tag' as const] };
    const areas = { short: true, all: [] };
    expect(chipLabel('en', f, { kind: 'tag', value: 'ui' }, areas)).toContain('(all)');
    expect(chipLabel('en', { ...f, matchAll: [] }, { kind: 'tag', value: 'ui' }, areas)).not.toContain('(all)');
  });

  it('is not taken into a saved view, which selects by any tag', () => {
    const two = { ...freshFilter(), fields: { tag: ['ui', 'menu'] } };
    expect(selectOfFilter(two).dropped).toBe(false);
    expect(selectOfFilter({ ...two, matchAll: ['tag'] }).dropped).toBe(true);
    // With one tag "all" and "any" are the same, so nothing is lost.
    expect(selectOfFilter({ ...two, fields: { tag: ['ui'] }, matchAll: ['tag'] }).dropped).toBe(false);
  });
});

describe('the word between the chips', () => {
  const f = (over: Partial<Filter>): Filter => ({ ...freshFilter(), ...over });

  it('is or within one field and and between fields, none before the first chip', () => {
    expect(chipJoins(f({ areas: ['a', 'b'], statuses: ['open'], fields: { tag: ['ui'] } }))).toEqual([null, 'or', 'and', 'and']);
  });

  it('is and within the tags when all of them are wanted', () => {
    expect(chipJoins(f({ fields: { tag: ['ui', 'menu'], category: ['bug', 'docs'] }, matchAll: ['tag'] }))).toEqual([
      null,
      'and',
      'and',
      'or',
    ]);
  });

  it('takes each span of a field and of days as a field of its own', () => {
    const bound = { label: '1', n: 1 };
    expect(
      chipJoins(f({ ranges: { prio: { min: bound }, value: { max: bound } }, dates: { created: { from: '2026-01-01' } } })),
    ).toEqual([null, 'and', 'and']);
  });

  it('joins the first chip to the search words with and', () => {
    expect(chipJoins(f({ statuses: ['open'] }), true)).toEqual(['and']);
    expect(chipJoins(f({}), true)).toEqual([]);
  });
});
