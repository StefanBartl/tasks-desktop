import { describe, expect, it } from 'vitest';
import { fromEngineList, type EngineList } from './engineLists';
import { task } from './fixtures';

const list = (options: Record<string, string | boolean>): EngineList =>
  ({ name: 'l', source: 'builtin', summary: 's', options }) as unknown as EngineList;

const tasks = [
  task('a/one', { effort: 'S', effort_days: 1 }),
  task('a/two', { effort: 'M', effort_days: 3 }),
];

describe('a list of the engine on the page', () => {
  it('lays status, actor, area and the plain fields onto the filter, and the order onto the sort', () => {
    const a = fromEngineList(
      list({ status: 'open,doing', actor: 'cdx,none', area: 'lib.nvim', kind: 'bug', tag: 'x,y', plan: 'p', sort: 'roi' }),
      tasks,
    );
    expect(a.filter.statuses).toEqual(['open', 'doing']);
    expect(a.filter.actors).toEqual(['cdx', 'none']);
    expect(a.filter.areas).toEqual(['lib.nvim']);
    expect(a.filter.fields).toEqual({ kind: ['bug'], tag: ['x', 'y'], plan: ['p'] });
    expect(a.sort).toBe('roi');
    expect(a.unsupported).toEqual([]);
  });

  it('turns the bounds into ranges and the lists of values into choices', () => {
    const a = fromEngineList(list({ prio: '<=2', value: '>=4', effort: '<=S' }), tasks);
    expect(a.filter.ranges.prio).toEqual({ max: { label: '2', n: 2 } });
    expect(a.filter.ranges.value).toEqual({ min: { label: '4', n: 4 } });
    expect(a.filter.ranges.effort).toEqual({ max: { label: 'S', n: 1 } });
    const b = fromEngineList(list({ prio: '1,2', value: '4,5', effort: 'S,M' }), tasks);
    expect(b.filter.fields).toEqual({ prio: ['1', '2'], value: ['4', '5'], effort: ['S', 'M'] });
    expect(b.filter.ranges).toEqual({});
  });

  it('names what the page cannot say, and does not drop it without a word', () => {
    const a = fromEngineList(
      list({ readiness: 'ready', stale: '30', blocked: true, quick_win: true, unestimated: true, status: 'open' }),
      tasks,
    );
    expect(a.filter.statuses).toEqual(['open']);
    expect(a.unsupported.sort()).toEqual(['blocked', 'quick_win', 'readiness: ready', 'stale: 30', 'unestimated']);
  });

  it('names an effort bound that no task of the vault can place, and a sort word that is not ours', () => {
    const a = fromEngineList(list({ effort: '<=XL', sort: 'sideways' }), tasks);
    expect(a.filter.ranges.effort).toBeUndefined();
    expect(a.unsupported).toEqual(['effort: <=XL', 'sort: sideways']);
    expect(a.sort).toBe('default');
  });

  it('takes a reminder switch, and leaves a switch that is off', () => {
    expect(fromEngineList(list({ reminders: true }), tasks).filter.reminder).toBe('set');
    expect(fromEngineList(list({ blocked: false, status: '' }), tasks).unsupported).toEqual([]);
  });
});
