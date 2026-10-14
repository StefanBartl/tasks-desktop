import { describe, expect, it } from 'vitest';
import {
  NONE,
  activeFilters,
  applyFilter,
  emptyFilter,
  extraCount,
  fieldOptions,
  fieldValues,
  matches,
  without,
  type Filter,
} from './filter';
import type { Readiness } from './contract';
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
