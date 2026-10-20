import { describe, expect, it } from 'vitest';
import type { Finished } from './contract';
import {
  canPage,
  currentPeriod,
  DEFAULT_METRICS,
  FINISHED_READ,
  METRICS,
  metricValues,
  parseDailyPrefs,
  periodDays,
  shiftPeriod,
} from './daily';

const task = (created?: string, updated?: string) => ({ created, updated }) as never;

describe('the days of a period', () => {
  it('is the day itself, the week from Monday to Sunday, the month from its first to its last day', () => {
    // 2026-10-20 is a Tuesday.
    expect(periodDays({ mode: 'day', anchor: '2026-10-20' })).toEqual({ since: '2026-10-20', until: '2026-10-20' });
    expect(periodDays({ mode: 'week', anchor: '2026-10-20' })).toEqual({ since: '2026-10-19', until: '2026-10-25' });
    // A Sunday belongs to the week that ends on it, a Monday starts one.
    expect(periodDays({ mode: 'week', anchor: '2026-10-25' })).toEqual({ since: '2026-10-19', until: '2026-10-25' });
    expect(periodDays({ mode: 'week', anchor: '2026-10-26' })).toEqual({ since: '2026-10-26', until: '2026-11-01' });
    expect(periodDays({ mode: 'month', anchor: '2026-10-20' })).toEqual({ since: '2026-10-01', until: '2026-10-31' });
    expect(periodDays({ mode: 'month', anchor: '2028-02-10' })).toEqual({ since: '2028-02-01', until: '2028-02-29' });
  });

  it('takes the days a person names, and the anchor day alone when they are no days or backwards', () => {
    const custom = (from?: string, to?: string) => periodDays({ mode: 'custom', anchor: '2026-10-20', from, to });
    expect(custom('2026-10-01', '2026-10-15')).toEqual({ since: '2026-10-01', until: '2026-10-15' });
    expect(custom('2026-10-15', '2026-10-01')).toEqual({ since: '2026-10-20', until: '2026-10-20' });
    expect(custom('2026-02-30', '2026-03-01')).toEqual({ since: '2026-10-20', until: '2026-10-20' });
    expect(custom()).toEqual({ since: '2026-10-20', until: '2026-10-20' });
  });
});

describe('turning the page', () => {
  it('goes a day, a week or a month back and forth, over the end of a month and a year', () => {
    expect(shiftPeriod({ mode: 'day', anchor: '2026-03-01' }, -1).anchor).toBe('2026-02-28');
    expect(periodDays(shiftPeriod({ mode: 'week', anchor: '2026-10-20' }, -1))).toEqual({ since: '2026-10-12', until: '2026-10-18' });
    expect(periodDays(shiftPeriod({ mode: 'month', anchor: '2026-01-31' }, -1))).toEqual({ since: '2025-12-01', until: '2025-12-31' });
    expect(periodDays(shiftPeriod({ mode: 'month', anchor: '2026-12-15' }, 1))).toEqual({ since: '2027-01-01', until: '2027-01-31' });
    // The 31st must not skip a month.
    expect(periodDays(shiftPeriod({ mode: 'month', anchor: '2026-03-31' }, -1))).toEqual({ since: '2026-02-01', until: '2026-02-28' });
  });

  it('moves a named period by its own length', () => {
    const period = { mode: 'custom' as const, anchor: '2026-10-10', from: '2026-10-10', to: '2026-10-16' };
    const back = shiftPeriod(period, -1);
    expect([back.from, back.to]).toEqual(['2026-10-03', '2026-10-09']);
    const on = shiftPeriod(period, 1);
    expect([on.from, on.to]).toEqual(['2026-10-17', '2026-10-23']);
  });

  it('can go back always and forward only while the period does not hold today yet', () => {
    const today = '2026-10-20';
    expect(canPage({ mode: 'day', anchor: today }, 1, today)).toBe(false);
    expect(canPage({ mode: 'day', anchor: today }, -1, today)).toBe(true);
    expect(canPage({ mode: 'week', anchor: '2026-10-14' }, 1, today)).toBe(true);
    expect(canPage({ mode: 'week', anchor: '2026-10-21' }, 1, today)).toBe(false);
    expect(canPage({ mode: 'month', anchor: '2026-09-15' }, 1, today)).toBe(true);
    expect(currentPeriod('week', today)).toEqual({ mode: 'week', anchor: today });
  });
});

const finishedDoc = (over: Partial<Finished> = {}): Finished =>
  ({
    total: 3,
    items: [
      { id: 'a/1', effort_days: 0.25, done_in: 'repo@abc' },
      { id: 'a/2', effort_days: 2, done_in: 'repo@abc' },
      { id: 'a/3', done_in: 'other@def' },
    ],
    stats: { effort_days: 2.25, by_kind: [{ kind: 'bug', count: 1, effort_days: 0 }], by_prio: [{ prio: 1, count: 2, effort_days: 0 }] },
    ...over,
  }) as unknown as Finished;

describe('the evaluations of a period', () => {
  const days = { since: '2026-10-19', until: '2026-10-25' };

  it('counts the made and the changed tasks of the whole period from the snapshot', () => {
    const v = metricValues([task('2026-10-19'), task('2026-10-25', '2026-10-25'), task('2026-10-01', '2026-10-22'), task('2026-10-26')], null, days);
    expect([v.created.value, v.changed.value]).toEqual([2, 1]);
  });

  it('does not know what comes from the finished tasks until the engine has told them', () => {
    const v = metricValues([], null, days);
    for (const m of ['finished', 'quick', 'effort', 'commits', 'bugs', 'prio1'] as const) expect(v[m], m).toEqual({ value: null, partial: false });
  });

  it('works out the finished ones, the quick wins, the effort, the different commits, the bugs and the priority 1', () => {
    const v = metricValues([], finishedDoc(), days);
    expect(v.finished.value).toBe(3);
    expect(v.quick.value).toBe(1);
    expect(v.effort.value).toBe(2.3);
    expect(v.commits.value).toBe(2);
    expect(v.bugs.value).toBe(1);
    expect(v.prio1.value).toBe(2);
    expect(Object.values(v).every((x) => !x.partial)).toBe(true);
  });

  it('says "at least" for what is counted from the items when the engine had more than were read', () => {
    const v = metricValues([], finishedDoc({ total: FINISHED_READ + 10 }), days);
    expect(v.quick.partial).toBe(true);
    expect(v.commits.partial).toBe(true);
    // What the engine added up itself is exact.
    expect(v.finished.partial).toBe(false);
    expect(v.bugs.partial).toBe(false);
  });

  it('knows eight evaluations, and shows three until the person chooses', () => {
    expect(METRICS).toHaveLength(8);
    expect(DEFAULT_METRICS).toEqual(['finished', 'created', 'changed']);
  });
});

describe('what the person chose', () => {
  it('reads back the mode, the days and the evaluations, in the order of the list', () => {
    const text = JSON.stringify({ mode: 'custom', from: '2026-10-01', to: '2026-10-09', metrics: ['bugs', 'finished', 'nonsense'] });
    expect(parseDailyPrefs(text)).toEqual({ mode: 'custom', from: '2026-10-01', to: '2026-10-09', metrics: ['finished', 'bugs'] });
  });

  it('gives the default for anything else, and keeps an empty choice empty', () => {
    const base = { mode: 'day', metrics: ['finished', 'created', 'changed'] };
    for (const text of [null, '', 'x', '[]', '7', '{"mode":"year"}']) expect(parseDailyPrefs(text), String(text)).toEqual(base);
    expect(parseDailyPrefs('{"mode":"week","metrics":[]}')).toEqual({ mode: 'week', metrics: [] });
    expect(parseDailyPrefs('{"from":"2026-02-30","metrics":"all"}')).toEqual(base);
  });
});
