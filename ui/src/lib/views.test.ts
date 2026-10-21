import { describe, expect, it } from 'vitest';
import type { View } from './contract';
import { emptyFilter, type Filter } from './filter';
import { cleanTitle, emptySelect, filterOfSelect, formOf, selectOfFilter, TITLE_MAX, toggledGroup } from './views';

const filter = (extra: Partial<Filter> = {}): Filter => ({ ...emptyFilter, ...extra });

describe('the saved views', () => {
  it('take a title as one line, trimmed and cut where the engine stops', () => {
    expect(cleanTitle('  Mine \n of today ')).toBe('Mine of today');
    expect(cleanTitle(' \n\t ')).toBeNull();
    expect([...cleanTitle('ä'.repeat(TITLE_MAX + 5))!]).toHaveLength(TITLE_MAX);
  });

  it('give back what a view_save carries, without the id, the version and the dates', () => {
    const view = {
      id: 'pub/mine',
      area: 'pub',
      title: 'Mine',
      display: 'matrix',
      group_by: 'status',
      group_by2: 'prio',
      collapsed: ['open'],
      select: { ...emptySelect(), tags: ['ui'], query: 'x' },
      etag: 'e',
      created: '2026-10-20',
    } as View;
    expect(formOf(view)).toEqual({
      title: 'Mine',
      display: 'matrix',
      group_by: 'status',
      group_by2: 'prio',
      collapsed: ['open'],
      select: { ...emptySelect(), tags: ['ui'], query: 'x' },
    });
    expect('group_by2' in formOf({ ...view, group_by2: undefined } as View)).toBe(false);
  });

  it('read a selection as the filter of the list: kinds, tags and plans as its fields', () => {
    const f = filterOfSelect({ areas: ['pub'], statuses: ['doing'], actors: ['me'], kinds: ['bug'], tags: ['ui'], plans: ['pub/p'], query: 'w' });
    expect(f.areas).toEqual(['pub']);
    expect(f.statuses).toEqual(['doing']);
    expect(f.actors).toEqual(['me']);
    expect(f.fields).toEqual({ kind: ['bug'], tag: ['ui'], plan: ['pub/p'] });
    expect(f.query).toBe('w');
    expect(filterOfSelect(emptySelect()).fields).toEqual({});
  });

  it('keep the part of a filter a view can hold, and say when some was left out', () => {
    const kept = selectOfFilter(filter({ areas: ['pub'], query: ' word ', fields: { tag: ['ui'], plan: ['pub/p'], kind: ['bug'] } }));
    expect(kept).toEqual({
      select: { areas: ['pub'], statuses: [], actors: [], kinds: ['bug'], tags: ['ui'], plans: ['pub/p'], query: 'word' },
      dropped: false,
    });
    // "Not written" has no word in a view.
    expect(selectOfFilter(filter({ actors: ['none', 'me'] }))).toEqual({ select: { ...emptySelect(), actors: ['me'] }, dropped: true });
    // What a view does not hold at all.
    expect(selectOfFilter(filter({ fields: { severity: ['high'] } })).dropped).toBe(true);
    expect(selectOfFilter(filter({ updated: '7' })).dropped).toBe(true);
    expect(selectOfFilter(filter({ quickWin: true })).dropped).toBe(true);
    expect(selectOfFilter(filter()).dropped).toBe(false);
    expect('query' in selectOfFilter(filter({ query: '  ' })).select).toBe(false);
  });

  it('fold a group that is open and open one that is folded', () => {
    expect(toggledGroup(['a'], 'b')).toEqual(['a', 'b']);
    expect(toggledGroup(['a', 'b'], 'a')).toEqual(['b']);
  });
});
