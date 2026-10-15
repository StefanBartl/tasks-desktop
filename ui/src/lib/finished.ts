// The finished tasks: the periods the page asks for and how a figure is drawn. The counting (per area, month, ...)
// is the engine's (`tasks.finished`, WEB-13); this only turns a choice into the days of a question.

export type Preset = '30' | '90' | 'year' | 'all' | 'custom';

export const PRESETS: readonly Preset[] = ['30', '90', 'year', 'all', 'custom'];

/** The days the engine is asked for, both included; a missing end is open. */
export interface Range {
  since?: string;
  until?: string;
}

const DAY = /^(\d{4})-(\d{2})-(\d{2})$/;

/** `YYYY-MM-DD` that is a real calendar day. */
export function isDay(text: string): boolean {
  const m = DAY.exec(text);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const at = new Date(Date.UTC(y, mo - 1, d));
  return at.getUTCFullYear() === y && at.getUTCMonth() === mo - 1 && at.getUTCDate() === d;
}

/** The day `n` days after (or before, when negative) `day`. */
export function addDays(day: string, n: number): string {
  const m = DAY.exec(day);
  if (!m) return day;
  const at = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]) + n));
  return at.toISOString().slice(0, 10);
}

/** The period of a choice. `custom` takes what was typed; a day that is no day is left open. */
export function rangeOf(preset: Preset, today: string, custom: { from: string; to: string }): Range {
  switch (preset) {
    case '30':
      return { since: addDays(today, -29), until: today };
    case '90':
      return { since: addDays(today, -89), until: today };
    case 'year':
      return { since: `${today.slice(0, 4)}-01-01`, until: today };
    case 'all':
      return {};
    case 'custom': {
      const range: Range = {};
      if (isDay(custom.from)) range.since = custom.from;
      if (isDay(custom.to)) range.until = custom.to;
      return range;
    }
  }
}

/** The first and the last day of a month `YYYY-MM`. */
export function monthRange(month: string): Range {
  const m = /^(\d{4})-(\d{2})$/.exec(month);
  if (!m) return {};
  const last = new Date(Date.UTC(Number(m[1]), Number(m[2]), 0)).getUTCDate();
  return {
    since: `${month}-01`,
    until: `${month}-${String(last).padStart(2, '0')}`,
  };
}

/** The seven days of the week that starts on `monday`. */
export function weekRange(monday: string): Range {
  return { since: monday, until: addDays(monday, 6) };
}

/** A share as a whole percent; 0 when there is nothing to share. */
export function percent(count: number, total: number): number {
  return total > 0 ? Math.round((count / total) * 100) : 0;
}

/** What the view remembers: the period (and the two days of "Choose days") and the step of the course. */
export interface Prefs {
  preset: Preset;
  from: string;
  to: string;
  step: 'month' | 'week';
}

export const DEFAULT_PREFS: Prefs = {
  preset: '90',
  from: '',
  to: '',
  step: 'month',
};

/** The remembered choice; anything that is not a choice of this version is left at the default. */
export function parsePrefs(text: string | null | undefined): Prefs {
  const out = { ...DEFAULT_PREFS };
  if (!text) return out;
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return out;
  }
  if (typeof raw !== 'object' || raw === null) return out;
  const o = raw as Record<string, unknown>;
  if (typeof o.preset === 'string' && (PRESETS as readonly string[]).includes(o.preset))
    out.preset = o.preset as Preset;
  if (typeof o.from === 'string' && isDay(o.from)) out.from = o.from;
  if (typeof o.to === 'string' && isDay(o.to)) out.to = o.to;
  if (o.step === 'week') out.step = 'week';
  return out;
}
