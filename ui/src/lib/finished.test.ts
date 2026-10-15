import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PREFS,
  intersect,
  addDays,
  isDay,
  monthRange,
  parsePrefs,
  percent,
  rangeOf,
  weekRange,
} from './finished';

describe('days', () => {
  it('knows a real calendar day', () => {
    expect(isDay('2026-02-28')).toBe(true);
    expect(isDay('2024-02-29')).toBe(true);
    expect(isDay('2026-02-29')).toBe(false);
    expect(isDay('2026-13-01')).toBe(false);
    expect(isDay('yesterday')).toBe(false);
    expect(isDay('')).toBe(false);
  });
  it('adds days over the end of a month and a year', () => {
    expect(addDays('2026-01-31', 1)).toBe('2026-02-01');
    expect(addDays('2026-01-01', -1)).toBe('2025-12-31');
    expect(addDays('2024-02-28', 2)).toBe('2024-03-01');
  });
});

describe('rangeOf', () => {
  const none = { from: '', to: '' };
  it('counts the day itself: 30 days end today and start 29 days before', () => {
    expect(rangeOf('30', '2026-03-31', none)).toEqual({
      since: '2026-03-02',
      until: '2026-03-31',
    });
    expect(rangeOf('90', '2026-03-31', none)).toEqual({
      since: '2026-01-01',
      until: '2026-03-31',
    });
  });
  it('is the year so far, or open', () => {
    expect(rangeOf('year', '2026-10-15', none)).toEqual({
      since: '2026-01-01',
      until: '2026-10-15',
    });
    expect(rangeOf('all', '2026-10-15', none)).toEqual({});
  });
  it('takes what was typed and leaves out what is no day', () => {
    expect(rangeOf('custom', '2026-10-15', { from: '2026-02-01', to: '2026-02-28' })).toEqual({
      since: '2026-02-01',
      until: '2026-02-28',
    });
    expect(rangeOf('custom', '2026-10-15', { from: '2026-02-30', to: '2026-02-28' })).toEqual({ until: '2026-02-28' });
    expect(rangeOf('custom', '2026-10-15', none)).toEqual({});
  });
});

describe('periods of a row', () => {
  it('is a month from its first to its last day', () => {
    expect(monthRange('2026-02')).toEqual({
      since: '2026-02-01',
      until: '2026-02-28',
    });
    expect(monthRange('2024-02')).toEqual({
      since: '2024-02-01',
      until: '2024-02-29',
    });
    expect(monthRange('2025-12')).toEqual({
      since: '2025-12-01',
      until: '2025-12-31',
    });
    expect(monthRange('nonsense')).toEqual({});
  });
  it('is a week from its Monday to the Sunday', () => {
    expect(weekRange('2025-12-29')).toEqual({
      since: '2025-12-29',
      until: '2026-01-04',
    });
  });
});

describe('percent', () => {
  it('rounds, and has nothing to say about nothing', () => {
    expect(percent(1, 3)).toBe(33);
    expect(percent(2, 3)).toBe(67);
    expect(percent(0, 0)).toBe(0);
  });
});

describe('prefs', () => {
  it('reads what was saved', () => {
    const saved = JSON.stringify({
      preset: 'custom',
      from: '2026-01-01',
      to: '2026-02-01',
      step: 'week',
    });
    expect(parsePrefs(saved)).toEqual({
      preset: 'custom',
      from: '2026-01-01',
      to: '2026-02-01',
      step: 'week',
    });
  });
  it('falls back to the default for anything it does not know', () => {
    expect(parsePrefs(null)).toEqual(DEFAULT_PREFS);
    expect(parsePrefs('{nope')).toEqual(DEFAULT_PREFS);
    expect(parsePrefs('[1]')).toEqual(DEFAULT_PREFS);
    expect(
      parsePrefs(
        JSON.stringify({
          preset: 'decade',
          from: '2026-02-30',
          to: 5,
          step: 'year',
        }),
      ),
    ).toEqual(DEFAULT_PREFS);
  });
});

describe('intersect', () => {
  it('keeps the later start and the earlier end', () => {
    expect(
      intersect({ since: '2026-09-01', until: '2026-09-30' }, { since: '2026-09-16', until: '2026-10-15' }),
    ).toEqual({ since: '2026-09-16', until: '2026-09-30' });
  });
  it('takes the side that is closed when the other is open', () => {
    expect(intersect({ since: '2026-09-01', until: '2026-09-30' }, {})).toEqual({
      since: '2026-09-01',
      until: '2026-09-30',
    });
    expect(intersect({}, { until: '2026-01-31' })).toEqual({ until: '2026-01-31' });
    expect(intersect({}, {})).toEqual({});
  });
});
