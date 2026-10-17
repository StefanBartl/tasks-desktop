import { describe, expect, it } from 'vitest';
import {
  NONE,
  activeFilters,
  boundOptions,
  applyFilter,
  emptyFilter,
  extraCount,
  fieldOptions,
  fieldValues,
  freshFilter,
  matches,
  narrows,
  parseFilter,
  serializeFilter,
  without,
  withSelected,
  type Filter,
} from './filter';
import type { Readiness } from './contract';
import { touchedAreas } from './cross';
import { task } from './fixtures';

const ready = (state: Readiness['state']): Readiness => ({ state, rank: 1, leverage: 0, open_blockers: [] });

const TODAY = '2026-10-15';

const a = task('lib/a', {
  kind: 'bug',
  prio: 1,
  effort: 'S',
  value: 5,
  tags: ['ui', 'docs'],
  category: ['bug'],
  severity: 'high',
  readiness: ready('ready'),
  plan: 'lib/the-plan',
  phase: 'p1',
  updated: '2026-10-10',
  remind: '2026-10-01',
});
const b = task('lib/b', { kind: 'feature', prio: 2, effort: 'L', tags: ['ui'], readiness: ready('waiting'), updated: '2026-08-01' });
const c = task('cas/c', { prio: 3, effort: '3d', remind: '2027-01-01' });
const all = [a, b, c];

const only = (patch: Partial<Filter>): Filter => ({ ...emptyFilter, areas: [], statuses: [], actors: [], fields: {}, ...patch });
const ids = (f: Filter): string[] => applyFilter(all, f, TODAY).map((t) => t.id);

describe('the values of a field', () => {
  it('names a missing value `none` and lists the values a task has', () => {
    expect(fieldValues(a, 'prio')).toEqual(['1']);
    expect(fieldValues(c, 'kind')).toEqual([NONE]);
    expect(fieldValues(a, 'tag')).toEqual(['ui', 'docs']);
    expect(fieldValues(c, 'tag')).toEqual([NONE]);
    expect(fieldValues(b, 'state')).toEqual(['waiting']);
    expect(fieldValues(c, 'state')).toEqual([NONE]);
    expect(fieldValues(a, 'category')).toEqual(['bug']);
  });
  it('offers every category the tasks carry, the newer ones of the engine too (no list of its own)', () => {
    const tasks = [
      task('lib/ux', { category: ['ux', 'bindings'] }),
      task('lib/ci', { category: ['refactor', 'tests', 'ci'] }),
      task('lib/old', { category: ['bug'] }),
    ];
    expect(fieldOptions(tasks, 'category').map((o) => o.value)).toEqual([
      'bindings',
      'bug',
      'ci',
      'refactor',
      'tests',
      'ux',
    ]);
  });
});

describe('filtering by a field', () => {
  it('takes any of the chosen values, and needs every field that is chosen', () => {
    expect(ids(only({ fields: { prio: ['1', '3'] } }))).toEqual(['lib/a', 'cas/c']);
    expect(ids(only({ fields: { prio: ['1', '3'], kind: ['bug'] } }))).toEqual(['lib/a']);
    expect(ids(only({ fields: { tag: ['docs'] } }))).toEqual(['lib/a']);
    expect(ids(only({ fields: { tag: ['ui'] } }))).toEqual(['lib/a', 'lib/b']);
  });
  it('can ask for the tasks that do not have the field', () => {
    expect(ids(only({ fields: { kind: [NONE] } }))).toEqual(['cas/c']);
    expect(ids(only({ fields: { tag: [NONE] } }))).toEqual(['cas/c']);
    expect(ids(only({ fields: { state: [NONE] } }))).toEqual(['cas/c']);
  });
  it('treats an empty list as no filter', () => {
    expect(ids(only({ fields: { prio: [] } }))).toEqual(['lib/a', 'lib/b', 'cas/c']);
  });
  it('filters by the state of the plan, the plan and the phase', () => {
    expect(ids(only({ fields: { state: ['ready'] } }))).toEqual(['lib/a']);
    expect(ids(only({ fields: { plan: ['lib/the-plan'], phase: ['p1'] } }))).toEqual(['lib/a']);
  });
});

describe('filtering by time and reminder', () => {
  it('knows how long ago a task changed; a task without a date is in no window', () => {
    expect(ids(only({ updated: '7' }))).toEqual(['lib/a']);
    expect(ids(only({ updated: '90' }))).toEqual(['lib/a', 'lib/b']);
    expect(ids(only({ updated: 'older' }))).toEqual([]);
    expect(matches(task('x/y', { updated: '2026-01-01' }), only({ updated: 'older' }), TODAY)).toBe(true);
    expect(matches(task('x/y'), only({ updated: '30' }), TODAY)).toBe(false);
    expect(matches(task('x/y'), only({ updated: 'older' }), TODAY)).toBe(false);
  });
  it('tells a reminder from a reminder that is due', () => {
    expect(ids(only({ reminder: 'set' }))).toEqual(['lib/a', 'cas/c']);
    expect(ids(only({ reminder: 'due' }))).toEqual(['lib/a']);
  });
});

describe('the options of a field', () => {
  it('come in the natural order with their counts, `none` last', () => {
    expect(fieldOptions(all, 'prio')).toEqual([
      { value: '1', count: 1 },
      { value: '2', count: 1 },
      { value: '3', count: 1 },
    ]);
    expect(fieldOptions(all, 'effort').map((o) => o.value)).toEqual(['S', 'L', '3d']);
    expect(fieldOptions(all, 'kind')).toEqual([
      { value: 'bug', count: 1 },
      { value: 'feature', count: 1 },
      { value: NONE, count: 1 },
    ]);
    expect(fieldOptions(all, 'tag')).toEqual([
      { value: 'docs', count: 1 },
      { value: 'ui', count: 2 },
      { value: NONE, count: 1 },
    ]);
  });
});

describe('what is switched on', () => {
  it('lists every value, takes one off, and counts the filters beyond area, status and actor', () => {
    const f = only({
      areas: ['lib'],
      statuses: ['open'],
      fields: { prio: ['1', '2'], tag: ['ui'] },
      updated: '30',
      reminder: 'due',
    });
    expect(activeFilters(f)).toEqual([
      { kind: 'area', value: 'lib' },
      { kind: 'status', value: 'open' },
      { kind: 'prio', value: '1' },
      { kind: 'prio', value: '2' },
      { kind: 'tag', value: 'ui' },
      { kind: 'updated', value: '30' },
      { kind: 'reminder', value: 'due' },
    ]);
    expect(extraCount(f)).toBe(5);
    expect(without(f, { kind: 'prio', value: '1' }).fields.prio).toEqual(['2']);
    expect(without(f, { kind: 'updated', value: '30' }).updated).toBe('');
    expect(without(f, { kind: 'area', value: 'lib' }).areas).toEqual([]);
    expect(activeFilters(emptyFilter)).toEqual([]);
  });
});

describe('the filter for tasks that connect areas', () => {
  const x = task('lib/x', { blocked_by: ['rules/y'] });
  const y = task('rules/y');
  const z = task('cas/z');
  const tasks = [x, y, z];
  const touched = touchedAreas(tasks);
  const run = (f: Filter): string[] => applyFilter(tasks, f, TODAY, touched).map((t) => t.id);

  it('keeps the tasks on either end of a link between areas', () => {
    expect(run(only({ cross: true }))).toEqual(['lib/x', 'rules/y']);
    expect(run(only({}))).toEqual(['lib/x', 'rules/y', 'cas/z']);
  });
  it('counts only the chosen areas, and combines with the area filter', () => {
    expect(run(only({ cross: true, areas: ['lib', 'rules'] }))).toEqual(['lib/x', 'rules/y']);
    expect(run(only({ cross: true, areas: ['lib', 'cas'] }))).toEqual([]);
    expect(run(only({ cross: true, areas: ['lib'] }))).toEqual([]);
  });
  it('shows nothing connected when the index is not given, and is a chip that comes off', () => {
    expect(applyFilter(tasks, only({ cross: true }), TODAY)).toEqual([]);
    expect(activeFilters(only({ cross: true }))).toEqual([{ kind: 'cross', value: 'on' }]);
    expect(without(only({ cross: true }), { kind: 'cross', value: 'on' }).cross).toBe(false);
    expect(extraCount(only({ cross: true }))).toBe(1);
  });
});

describe('edges the review found', () => {
  const at = (updated: string) => task('x/t', { updated });
  const win = (updated: string, window: Filter['updated']): boolean => matches(at(updated), only({ updated: window }), TODAY);

  it('puts the edges of the time windows where they say: 7 days is in, 8 is not; 90 is in, 91 is older', () => {
    expect(win('2026-10-08', '7')).toBe(true); // 7 days ago
    expect(win('2026-10-07', '7')).toBe(false); // 8 days ago
    expect(win('2026-10-07', '30')).toBe(true);
    expect(win('2026-07-17', '90')).toBe(true); // 90 days ago
    expect(win('2026-07-16', '90')).toBe(false); // 91 days ago
    expect(win('2026-07-16', 'older')).toBe(true);
    expect(win('2026-07-17', 'older')).toBe(false);
    // a time after the date does not change the day
    expect(win('2026-10-08T23:59:00', '7')).toBe(true);
  });

  it('counts a task once for a value it names twice', () => {
    const twice = task('x/two', { tags: ['ui', 'ui'] });
    expect(fieldOptions([twice], 'tag')).toEqual([{ value: 'ui', count: 1 }]);
  });

  it('sorts the efforts in days by their value, after the sizes', () => {
    const e = (id: string, effort: string) => task(id, { effort: effort as never });
    const options = fieldOptions([e('x/a', '10d'), e('x/b', '0.5d'), e('x/c', 'M'), e('x/d', '0.25d'), e('x/e', '2d')], 'effort');
    expect(options.map((o) => o.value)).toEqual(['M', '0.25d', '0.5d', '2d', '10d']);
  });

  it('does not take a tag that is called none for a task that has no tag', () => {
    const named = task('x/named', { tags: ['none'] });
    const bare = task('x/bare');
    const f = only({ fields: { tag: ['none'] } });
    expect(matches(named, f, TODAY)).toBe(true);
    expect(matches(bare, f, TODAY)).toBe(false);
    expect(matches(bare, only({ fields: { tag: [NONE] } }), TODAY)).toBe(true);
    expect(matches(named, only({ fields: { tag: [NONE] } }), TODAY)).toBe(false);
    expect(fieldOptions([named, bare], 'tag').map((o) => o.value)).toEqual(['none', NONE]);
  });
});

describe('withSelected', () => {
  it('adds a value that is on but that no task has any more, and leaves the rest as it is', () => {
    const options = [{ value: '1' }, { value: '2' }];
    expect(withSelected(options, ['2'], (value) => ({ value }))).toEqual([{ value: '1' }, { value: '2' }]);
    expect(withSelected(options, ['2', '9'], (value) => ({ value: `${value}!` }))).toEqual([
      { value: '1' },
      { value: '2' },
      { value: '9!' },
    ]);
    expect(withSelected([], [], (value) => ({ value }))).toEqual([]);
  });
});

describe('at least / at most and spans of days', () => {
  // Fixtures carry no `effort_days`; the engine delivers it, so the tests set it.
  const sized = [
    task('p/xs', { prio: 3, effort: 'XS', effort_days: 0.25, value: 1, created: '2026-01-05', updated: '2026-02-01T10:00:00Z' }),
    task('p/m', { prio: 2, effort: 'M', effort_days: 2, value: 3, created: '2026-03-05', remind: '2026-04-01' }),
    task('p/xl', { prio: 1, effort: 'XL', effort_days: 8, value: 5, created: '2026-06-05' }),
    task('p/none', {}),
  ];
  const got = (f: Partial<Filter>): string[] => applyFilter(sized, only(f), TODAY).map((t) => t.id);
  const bound = (label: string, n: number) => ({ label, n });

  it('takes the ends in, compares an effort by its days, and leaves out a task that lacks the field', () => {
    expect(got({ ranges: { prio: { min: bound('2', 2) } } })).toEqual(['p/xs', 'p/m']);
    expect(got({ ranges: { prio: { max: bound('2', 2) } } })).toEqual(['p/m', 'p/xl']);
    expect(got({ ranges: { value: { min: bound('3', 3), max: bound('4', 4) } } })).toEqual(['p/m']);
    expect(got({ ranges: { effort: { min: bound('M', 2) } } })).toEqual(['p/m', 'p/xl']);
    expect(got({ ranges: { effort: { max: bound('M', 2) } } })).toEqual(['p/xs', 'p/m']);
    expect(got({ ranges: { effort: { min: bound('S', 1), max: bound('L', 4) } }, fields: { prio: ['2'] } })).toEqual(['p/m']);
  });
  it('lists the values the tasks have in the order of their numbers', () => {
    expect(boundOptions(sized, 'effort')).toEqual([bound('XS', 0.25), bound('M', 2), bound('XL', 8)]);
    expect(boundOptions(sized, 'prio').map((o) => o.label)).toEqual(['1', '2', '3']);
  });
  it('cuts a time field to a span of days, both days included', () => {
    expect(got({ dates: { created: { from: '2026-03-05' } } })).toEqual(['p/m', 'p/xl']);
    expect(got({ dates: { created: { to: '2026-03-05' } } })).toEqual(['p/xs', 'p/m']);
    expect(got({ dates: { created: { from: '2026-02-01', to: '2026-04-01' } } })).toEqual(['p/m']);
    expect(got({ dates: { updated: { to: '2026-02-01' } } })).toEqual(['p/xs']);
    expect(got({ dates: { remind: { from: '2026-04-01', to: '2026-04-01' } } })).toEqual(['p/m']);
  });
  it('shows a range or a span as one thing that is on, and takes it off as one', () => {
    const f = only({ ranges: { prio: { min: bound('2', 2) } }, dates: { created: { from: '2026-03-05' } } });
    expect(activeFilters(f)).toEqual([
      { kind: 'range', value: 'prio' },
      { kind: 'date', value: 'created' },
    ]);
    expect(extraCount(f)).toBe(2);
    expect(activeFilters(without(without(f, { kind: 'range', value: 'prio' }), { kind: 'date', value: 'created' }))).toEqual([]);
  });
});

describe('what narrows', () => {
  it('counts the search words too, which are no chip', () => {
    expect(narrows(freshFilter())).toBe(false);
    expect(narrows({ ...freshFilter(), query: '  ' })).toBe(false);
    expect(narrows({ ...freshFilter(), query: 'alpha' })).toBe(true);
    expect(narrows({ ...freshFilter(), statuses: ['doing'] })).toBe(true);
    expect(activeFilters({ ...freshFilter(), query: 'alpha' })).toEqual([]);
  });
});

describe('the filter that is remembered', () => {
  it('comes back as it went, without the search words', () => {
    const f = only({
      areas: ['lib'],
      statuses: ['doing'],
      fields: { tag: ['ui'] },
      ranges: { effort: { max: { label: 'M', n: 2 } } },
      dates: { updated: { from: '2026-01-01' } },
      cross: true,
      updated: '30',
      query: 'words',
    });
    expect(parseFilter(serializeFilter(f))).toEqual({ ...f, query: '' });
  });
  it('takes the good parts of a damaged or older memory and an empty filter for the rest', () => {
    expect(parseFilter(null)).toEqual(freshFilter());
    expect(parseFilter('{')).toEqual(freshFilter());
    expect(parseFilter('[1]')).toEqual(freshFilter());
    // An older memory has no ranges or dates; wrong shapes and unknown keys are dropped.
    const got = parseFilter(
      JSON.stringify({
        areas: ['a', 7],
        fields: { tag: ['x'], nonsense: ['y'] },
        ranges: { prio: { min: { label: 'P', n: 'x' } }, value: { max: { label: '4', n: 4 } } },
        dates: { created: { from: 'yesterday', to: '2026-02-30x' }, updated: { to: '2026-05-01' } },
        updated: 'forever',
      }),
    );
    expect(got.areas).toEqual(['a']);
    expect(got.fields).toEqual({ tag: ['x'] });
    expect(got.ranges).toEqual({ value: { max: { label: '4', n: 4 } } });
    expect(got.dates).toEqual({ updated: { to: '2026-05-01' } });
    expect(got.updated).toBe('');
  });
});
