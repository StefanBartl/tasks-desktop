// The summary of a period on the start page (the tile Today): the period (a day, a week, a month, or days the person
// names), the evaluations that can be counted in it, and what the person chose to see. The counting is plain
// functions; the finished tasks and their figures are the engine's (`tasks.finished`), the made and the changed ones
// are counted from the snapshot (`created`, `updated`).

import type { Finished, TaskEntry } from './contract';
import { addDays, isDay } from './finished';

// ── the period ────────────────────────────────────────────────────────────────────────────────────────────────────

export type PeriodMode = 'day' | 'week' | 'month' | 'custom';
export const PERIOD_MODES: readonly PeriodMode[] = ['day', 'week', 'month', 'custom'];

export interface Period {
  mode: PeriodMode;
  /** A day inside the period (a day, a week and a month are the ones this day lies in). */
  anchor: string;
  /** The days of a period the person names; both included. */
  from?: string;
  to?: string;
}

/** The days of a period, both included. */
export interface Days {
  since: string;
  until: string;
}

function parts(day: string): [number, number, number] {
  return [Number(day.slice(0, 4)), Number(day.slice(5, 7)), Number(day.slice(8, 10))];
}

function monthStart(day: string, delta = 0): string {
  const [y, m] = parts(day);
  return new Date(Date.UTC(y, m - 1 + delta, 1)).toISOString().slice(0, 10);
}

/** The days of a period. A custom one with a day that is no day, or backwards, is the anchor day alone. */
export function periodDays(period: Period): Days {
  const { anchor } = period;
  switch (period.mode) {
    case 'day':
      return { since: anchor, until: anchor };
    case 'week': {
      // The week starts on Monday.
      const weekday = (new Date(`${anchor}T00:00:00Z`).getUTCDay() + 6) % 7;
      const since = addDays(anchor, -weekday);
      return { since, until: addDays(since, 6) };
    }
    case 'month': {
      const since = monthStart(anchor);
      return { since, until: addDays(monthStart(anchor, 1), -1) };
    }
    case 'custom': {
      const { from, to } = period;
      if (from !== undefined && to !== undefined && isDay(from) && isDay(to) && from <= to) return { since: from, until: to };
      return { since: anchor, until: anchor };
    }
  }
}

/** The period before (-1) or after (1): a day, a week, a month, or as many days as a named period is long. */
export function shiftPeriod(period: Period, direction: -1 | 1): Period {
  switch (period.mode) {
    case 'day':
      return { ...period, anchor: addDays(period.anchor, direction) };
    case 'week':
      return { ...period, anchor: addDays(period.anchor, 7 * direction) };
    case 'month':
      return { ...period, anchor: monthStart(period.anchor, direction) };
    case 'custom': {
      const { since, until } = periodDays(period);
      const length = Math.round((Date.parse(`${until}T00:00:00Z`) - Date.parse(`${since}T00:00:00Z`)) / 86_400_000) + 1;
      const from = addDays(since, length * direction);
      return { ...period, anchor: from, from, to: addDays(until, length * direction) };
    }
  }
}

/** Whether the period can be turned to: there is no later one than the one that holds `today`. */
export function canPage(period: Period, direction: -1 | 1, today: string): boolean {
  return direction < 0 || periodDays(period).until < today;
}

/** The period of today in a mode; a custom one starts as the named days, or today alone. */
export function currentPeriod(mode: PeriodMode, today: string, custom?: { from?: string; to?: string }): Period {
  return { mode, anchor: today, ...(custom?.from ? { from: custom.from } : {}), ...(custom?.to ? { to: custom.to } : {}) };
}

// ── the evaluations ───────────────────────────────────────────────────────────────────────────────────────────────

/** What can be counted. The first three are the ones shown until the person chooses. */
export const METRICS = ['finished', 'created', 'changed', 'quick', 'effort', 'commits', 'bugs', 'prio1'] as const;
export type Metric = (typeof METRICS)[number];
export const DEFAULT_METRICS: readonly Metric[] = ['finished', 'created', 'changed'];

/** A task of 0.5 days or less counts as a quick win. */
export const QUICK_DAYS = 0.5;

export interface MetricValue {
  /** `null`: not known (the engine has not told the finished tasks). */
  value: number | null;
  /** The finished tasks were more than were read: the number is at least this. */
  partial: boolean;
}

/** The engine answers at most this many finished tasks at a time. */
export const FINISHED_PAGE = 100;
/** The finished tasks read for a period, over several pages, at most. */
export const FINISHED_READ = 500;

/**
 * Every evaluation for the days. `created` and `changed` come from the open tasks (a task made and finished within the
 * period is counted as finished); the others from the finished tasks of the Backlogs, `null` while they are not known.
 */
export function metricValues(
  tasks: readonly Pick<TaskEntry, 'created' | 'updated'>[],
  finished: Finished | null,
  days: Days,
): Record<Metric, MetricValue> {
  let created = 0;
  let changed = 0;
  for (const task of tasks) {
    const made = task.created as unknown as string | undefined;
    const touched = task.updated as unknown as string | undefined;
    if (made !== undefined && made >= days.since && made <= days.until) created += 1;
    else if (touched !== undefined && touched >= days.since && touched <= days.until) changed += 1;
  }
  const none: MetricValue = { value: null, partial: false };
  const known = (value: number, partial = false): MetricValue => ({ value, partial });
  if (finished === null) {
    return { finished: none, created: known(created), changed: known(changed), quick: none, effort: none, commits: none, bugs: none, prio1: none };
  }
  const cut = finished.items.length < finished.total;
  const quick = finished.items.filter((i) => i.effort_days !== undefined && i.effort_days <= QUICK_DAYS).length;
  const commits = new Set(finished.items.map((i) => i.done_in).filter((c): c is string => typeof c === 'string' && c !== '')).size;
  const kind = (name: string) => finished.stats.by_kind.find((k) => k.kind === name)?.count ?? 0;
  const prio = (n: number) => finished.stats.by_prio.find((p) => p.prio === n)?.count ?? 0;
  return {
    finished: known(finished.total),
    created: known(created),
    changed: known(changed),
    quick: known(quick, cut),
    effort: known(Math.round(finished.stats.effort_days * 10) / 10),
    commits: known(commits, cut),
    bugs: known(kind('bug')),
    prio1: known(prio(1)),
  };
}

/** The made and the changed tasks of one day (the first two figures of the tile). */
export function dailyFigures(tasks: readonly Pick<TaskEntry, 'created' | 'updated'>[], day: string): { created: number; changed: number } {
  const v = metricValues(tasks, null, { since: day, until: day });
  return { created: v.created.value ?? 0, changed: v.changed.value ?? 0 };
}

// ── what the person chose ─────────────────────────────────────────────────────────────────────────────────────────

export interface DailyPrefs {
  mode: PeriodMode;
  from?: string;
  to?: string;
  metrics: Metric[];
}

export const DEFAULT_PREFS: DailyPrefs = { mode: 'day', metrics: [...DEFAULT_METRICS] };

/** The stored text read back; anything that is not a choice the page makes gives the default for that part. */
export function parseDailyPrefs(text: string | null): DailyPrefs {
  const fallback = (): DailyPrefs => ({ mode: 'day', metrics: [...DEFAULT_METRICS] });
  if (!text) return fallback();
  try {
    const raw = JSON.parse(text) as Record<string, unknown> | null;
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return fallback();
    const mode = PERIOD_MODES.find((m) => m === raw['mode']) ?? 'day';
    const chosen = raw['metrics'];
    const metrics = Array.isArray(chosen) ? METRICS.filter((m) => chosen.includes(m)) : [...DEFAULT_METRICS];
    const from = typeof raw['from'] === 'string' && isDay(raw['from']) ? raw['from'] : undefined;
    const to = typeof raw['to'] === 'string' && isDay(raw['to']) ? raw['to'] : undefined;
    return { mode, metrics, ...(from ? { from } : {}), ...(to ? { to } : {}) };
  } catch {
    return fallback();
  }
}
