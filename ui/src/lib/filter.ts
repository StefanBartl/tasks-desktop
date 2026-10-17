// Filtering the list. The UI never sorts: the order is the engine's `rank`
// (plan order), and a filter only takes tasks out of it.

import { connectsAreas } from './cross';
import { isDue, localToday } from './remind';
import type { TaskEntry } from './contract';

/** The fields a task can be filtered by besides area, status and actor. */
export const FIELD_KEYS = [
  'kind',
  'prio',
  'effort',
  'value',
  'tag',
  'category',
  'severity',
  'state',
  'plan',
  'phase',
] as const;
export type FieldKey = (typeof FIELD_KEYS)[number];

/** How long ago a task was last changed: within 7, 30 or 90 days, or longer ago. */
export type UpdatedWindow = '' | '7' | '30' | '90' | 'older';
export const UPDATED_WINDOWS: readonly UpdatedWindow[] = ['7', '30', '90', 'older'];
/** Whether the task carries a reminder, or one that is due. */
export type ReminderChoice = '' | 'set' | 'due';
export const REMINDER_CHOICES: readonly ReminderChoice[] = ['set', 'due'];

/** The fields with a natural order, for "at least / at most". */
export const RANGE_KEYS = ['prio', 'effort', 'value'] as const;
export type RangeKey = (typeof RANGE_KEYS)[number];
/** One end of a range: the word shown (`M`, `2`) and the number it compares as (the engine's `effort_days` for an effort). */
export interface Bound {
  label: string;
  n: number;
}
/** The time fields a range of days can be put on. */
export const DATE_KEYS = ['created', 'updated', 'remind'] as const;
export type DateKey = (typeof DATE_KEYS)[number];

export interface Filter {
  /** Tasks of any of these areas; none chosen means every area. */
  areas: string[];
  /** Any of these statuses. */
  statuses: string[];
  /** Any of these actors; `none` is a task nobody classified. */
  actors: string[];
  query: string;
  /** Per field: any of these values; no entry or an empty list means every value. `none` is "not written". */
  fields: Partial<Record<FieldKey, string[]>>;
  updated: UpdatedWindow;
  reminder: ReminderChoice;
  /** Per ordered field: at least `min`, at most `max`; a task without the field is not in a range that is on. */
  ranges: Partial<Record<RangeKey, { min?: Bound; max?: Bound }>>;
  /** Per time field: from and to, both `YYYY-MM-DD` and both included; a task without the field is out. */
  dates: Partial<Record<DateKey, { from?: string; to?: string }>>;
  /** Only tasks that connect areas (see `cross.ts`): the chosen areas, or any. */
  cross: boolean;
}

export const emptyFilter: Filter = {
  areas: [],
  statuses: [],
  actors: [],
  query: '',
  fields: {},
  updated: '',
  reminder: '',
  ranges: {},
  dates: {},
  cross: false,
};

/** A filter with nothing on, sharing no list or record with another (a state that is changed by copying, never in place). */
export function freshFilter(): Filter {
  return { ...emptyFilter, areas: [], statuses: [], actors: [], fields: {}, ranges: {}, dates: {} };
}

/** A task with no `actor` is chosen by this word. */
export const NO_ACTOR = 'none';
/**
 * A task that does not carry a field is chosen by this value. It starts with a control character, which a tag, a
 * plan or a phase cannot hold (the engine refuses one), so no real value is mistaken for it.
 */
export const NONE = '\u0000none';

/** The values a task has for a field (`none` when it has no value). */
export function fieldValues(task: TaskEntry, key: FieldKey): string[] {
  const one = (v: string | number | undefined): string[] => [v === undefined || v === '' ? NONE : String(v)];
  switch (key) {
    case 'kind':
      return one(task.kind);
    case 'prio':
      return one(task.prio);
    case 'effort':
      return one(task.effort);
    case 'value':
      return one(task.value);
    case 'severity':
      return one(task.severity);
    case 'state':
      return one(task.readiness?.state);
    case 'plan':
      return one(task.plan);
    case 'phase':
      return one(task.phase);
    case 'tag':
      return task.tags.length > 0 ? task.tags : [NONE];
    case 'category':
      return task.category.length > 0 ? task.category.map(String) : [NONE];
  }
}

/** The order the values of a field have by nature; others follow alphabetically, `none` is last. */
const ORDER: Partial<Record<FieldKey, readonly string[]>> = {
  kind: ['bug', 'feature', 'task'],
  prio: ['1', '2', '3'],
  effort: ['XS', 'S', 'M', 'L', 'XL'],
  value: ['1', '2', '3', '4', '5'],
  severity: ['low', 'medium', 'high', 'critical'],
  state: ['ready', 'decision', 'waiting', 'stuck', 'freed', 'parked', 'unknown'],
};

/** The values a field has in these tasks, in their natural order, with the number of tasks that have each. */
export function fieldOptions(
  tasks: readonly TaskEntry[],
  key: FieldKey,
): { value: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const task of tasks) {
    for (const value of new Set(fieldValues(task, key))) counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  const order = ORDER[key] ?? [];
  const rank = (v: string): number => (v === NONE ? 2 : order.includes(v) ? 0 : 1);
  // `0.5d` and `0.25d` are decimals, not two numbers around a dot: efforts in days sort by their value.
  const days = (v: string): number | null => {
    const m = /^(\d+(?:\.\d+)?)d$/.exec(v);
    return m ? Number(m[1]) : null;
  };
  const byValue = (a: string, b: string): number => {
    const x = days(a);
    const y = days(b);
    return x !== null && y !== null ? x - y : a.localeCompare(b, undefined, { numeric: true });
  };
  return [...counts.entries()]
    .map(([value, count]) => ({ value, count }))
    .sort(
      (a, b) =>
        rank(a.value) - rank(b.value) ||
        (rank(a.value) === 0 ? order.indexOf(a.value) - order.indexOf(b.value) : byValue(a.value, b.value)),
    );
}

/**
 * The options of a choice with the values that are on added when no task has them any more: the choice must still
 * show them, or the chip for such a value could not be matched by an option that can be switched off.
 */
export function withSelected<T extends { value: string }>(
  options: readonly T[],
  selected: readonly string[],
  make: (value: string) => T,
): T[] {
  const missing = selected.filter((v) => !options.some((o) => o.value === v));
  return missing.length === 0 ? [...options] : [...options, ...missing.map(make)];
}

/** Whole days from `from` to `to` (both `YYYY-MM-DD`; a time after the date is ignored). */
function daysBetween(from: string, to: string): number | null {
  const a = Date.parse(`${from.slice(0, 10)}T00:00:00Z`);
  const b = Date.parse(`${to.slice(0, 10)}T00:00:00Z`);
  return Number.isNaN(a) || Number.isNaN(b) ? null : Math.round((b - a) / 86_400_000);
}

function inWindow(updated: string | undefined, window: UpdatedWindow, today: string): boolean {
  if (window === '') return true;
  if (updated === undefined) return false;
  const days = daysBetween(updated, today);
  if (days === null) return false;
  return window === 'older' ? days > 90 : days <= Number(window);
}

/** The number a task has for an ordered field (an effort compares by the days the engine worked out). */
export function rangeNumber(task: TaskEntry, key: RangeKey): number | undefined {
  switch (key) {
    case 'prio':
      return task.prio;
    case 'value':
      return task.value;
    case 'effort':
      return task.effort_days;
  }
}

/** The calendar day (`YYYY-MM-DD`) a task has for a time field. */
export function dayOf(task: TaskEntry, key: DateKey): string | undefined {
  const raw = task[key];
  return raw === undefined || raw === null ? undefined : String(raw).slice(0, 10);
}

/** The values of an ordered field the tasks have, in their order, each with the number it compares as. */
export function boundOptions(tasks: readonly TaskEntry[], key: RangeKey): Bound[] {
  const seen = new Map<string, number>();
  for (const task of tasks) {
    const n = rangeNumber(task, key);
    const label = key === 'effort' ? task.effort : n === undefined ? undefined : String(n);
    if (label !== undefined && n !== undefined && !seen.has(label)) seen.set(label, n);
  }
  return [...seen.entries()].map(([label, n]) => ({ label, n })).sort((a, b) => a.n - b.n);
}

export function matches(
  task: TaskEntry,
  filter: Filter,
  today: string = localToday(),
  touched?: ReadonlyMap<string, ReadonlySet<string>>,
): boolean {
  if (filter.areas.length > 0 && !filter.areas.includes(task.area)) return false;
  if (filter.statuses.length > 0 && !filter.statuses.includes(task.status ?? '')) return false;
  if (filter.actors.length > 0 && !filter.actors.includes(task.actor ?? NO_ACTOR)) return false;
  for (const key of FIELD_KEYS) {
    const chosen = filter.fields[key];
    if (chosen && chosen.length > 0 && !fieldValues(task, key).some((v) => chosen.includes(v))) return false;
  }
  for (const key of RANGE_KEYS) {
    const range = filter.ranges[key];
    if (range && (range.min || range.max)) {
      const n = rangeNumber(task, key);
      if (n === undefined || (range.min && n < range.min.n) || (range.max && n > range.max.n)) return false;
    }
  }
  for (const key of DATE_KEYS) {
    const span = filter.dates[key];
    if (span && (span.from || span.to)) {
      const day = dayOf(task, key);
      if (day === undefined || (span.from && day < span.from) || (span.to && day > span.to)) return false;
    }
  }
  if (!inWindow(task.updated, filter.updated, today)) return false;
  if (filter.reminder === 'set' && task.remind === undefined) return false;
  if (filter.reminder === 'due' && !isDue(task.remind, today)) return false;
  if (filter.cross && !connectsAreas(touched?.get(task.id), filter.areas)) return false;
  const query = filter.query.trim().toLowerCase();
  if (query !== '') {
    const hay = `${task.id} ${task.title}`.toLowerCase();
    // Every word must be there, in any order.
    for (const word of query.split(/\s+/)) {
      if (!hay.includes(word)) return false;
    }
  }
  return true;
}

/** Switch one value of a chosen list on or off. */
export function toggled(list: readonly string[], value: string): string[] {
  return list.includes(value) ? list.filter((v) => v !== value) : [...list, value];
}

/**
 * The name of an area as it is shown. A folder of the vault may carry the
 * prefix `wkdbook-`; it is left out when that makes no second area look
 * alike. The task ids keep the real name.
 */
export function areaLabel(name: string, all: readonly string[]): string {
  const short = name.replace(/^wkdbook-/i, '');
  if (short === '' || short === name) return name;
  const taken = all.some((other) => other !== name && other.toLowerCase() === short.toLowerCase());
  return taken ? name : short;
}

export function applyFilter(
  tasks: readonly TaskEntry[],
  filter: Filter,
  today: string = localToday(),
  touched?: ReadonlyMap<string, ReadonlySet<string>>,
): TaskEntry[] {
  return tasks.filter((t) => matches(t, filter, today, touched));
}

/** One thing a filter holds, for the row of chips that names what is switched on and takes it off again. */
export type ActiveKind =
  | 'area'
  | 'status'
  | 'actor'
  | FieldKey
  | 'updated'
  | 'reminder'
  | 'cross'
  | 'range'
  | 'date';
export interface ActiveFilter {
  kind: ActiveKind;
  value: string;
}

/** Every value that is switched on, in the order the filter bar shows them. The search words are not among them. */
export function activeFilters(filter: Filter): ActiveFilter[] {
  const out: ActiveFilter[] = [];
  for (const value of filter.areas) out.push({ kind: 'area', value });
  for (const value of filter.statuses) out.push({ kind: 'status', value });
  for (const value of filter.actors) out.push({ kind: 'actor', value });
  for (const key of FIELD_KEYS) for (const value of filter.fields[key] ?? []) out.push({ kind: key, value });
  for (const key of RANGE_KEYS) {
    const r = filter.ranges[key];
    if (r && (r.min || r.max)) out.push({ kind: 'range', value: key });
  }
  for (const key of DATE_KEYS) {
    const d = filter.dates[key];
    if (d && (d.from || d.to)) out.push({ kind: 'date', value: key });
  }
  if (filter.updated !== '') out.push({ kind: 'updated', value: filter.updated });
  if (filter.reminder !== '') out.push({ kind: 'reminder', value: filter.reminder });
  if (filter.cross) out.push({ kind: 'cross', value: 'on' });
  return out;
}

/** Anything narrows the list: a chosen value, or words in the search box (they are no chip, but they narrow as much). */
export function narrows(filter: Filter): boolean {
  return activeFilters(filter).length > 0 || filter.query.trim() !== '';
}

/** How many of the filters beyond area, status and actor are on. */
export function extraCount(filter: Filter): number {
  return activeFilters(filter).filter((a) => a.kind !== 'area' && a.kind !== 'status' && a.kind !== 'actor')
    .length;
}

/** The filter with one value switched off. */
export function without(filter: Filter, item: ActiveFilter): Filter {
  const drop = (list: readonly string[]): string[] => list.filter((v) => v !== item.value);
  switch (item.kind) {
    case 'area':
      return { ...filter, areas: drop(filter.areas) };
    case 'status':
      return { ...filter, statuses: drop(filter.statuses) };
    case 'actor':
      return { ...filter, actors: drop(filter.actors) };
    case 'updated':
      return { ...filter, updated: '' };
    case 'reminder':
      return { ...filter, reminder: '' };
    case 'cross':
      return { ...filter, cross: false };
    case 'range':
      return { ...filter, ranges: { ...filter.ranges, [item.value]: undefined } };
    case 'date':
      return { ...filter, dates: { ...filter.dates, [item.value]: undefined } };
    default:
      return { ...filter, fields: { ...filter.fields, [item.kind]: drop(filter.fields[item.kind] ?? []) } };
  }
}

/** The task after `current` in `list` (or the first), moved by `delta`. */
export function moveSelection(
  list: readonly TaskEntry[],
  currentId: string | null,
  delta: number,
): string | null {
  if (list.length === 0) return null;
  const at = currentId === null ? -1 : list.findIndex((t) => t.id === currentId);
  if (at === -1) return list[delta >= 0 ? 0 : list.length - 1]?.id ?? null;
  const next = Math.min(list.length - 1, Math.max(0, at + delta));
  return list[next]?.id ?? null;
}

/** Tasks that wait for a decision of the user: `decision` status or readiness, for `me`. */
export function waitingForMe(tasks: readonly TaskEntry[]): TaskEntry[] {
  return tasks.filter(
    (t) =>
      (t.status === 'decision' || t.readiness?.state === 'decision') &&
      (t.actor === 'me' || t.actor === undefined),
  );
}

/**
 * The filter as it is remembered (without the search words, which are for the moment), and the filter read back from
 * what was remembered: a damaged or older memory gives the parts it can and an empty filter for the rest.
 */
export function serializeFilter(filter: Filter, vault?: string | null): string {
  const { query: _query, ...rest } = filter;
  return JSON.stringify(vault === undefined ? rest : { ...rest, vault });
}

/**
 * The vault a remembered filter was made in: a name, `null` for a hub with one vault and no list, `undefined` when
 * the memory does not say (an older one, or written before the hub named its vault).
 */
export function filterVaultOf(text: string | null): string | null | undefined {
  try {
    const raw: unknown = text ? JSON.parse(text) : undefined;
    if (typeof raw !== 'object' || raw === null || !('vault' in raw)) return undefined;
    const vault = (raw as { vault: unknown }).vault;
    return typeof vault === 'string' || vault === null ? vault : undefined;
  } catch {
    return undefined;
  }
}

export function parseFilter(text: string | null): Filter {
  const out = freshFilter();
  let raw: unknown;
  try {
    raw = text ? JSON.parse(text) : null;
  } catch {
    return out;
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return out;
  const o = raw as Record<string, unknown>;
  const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
  out.areas = strings(o.areas);
  out.statuses = strings(o.statuses);
  out.actors = strings(o.actors);
  out.cross = o.cross === true;
  if (typeof o.updated === 'string' && (o.updated === '' || (UPDATED_WINDOWS as readonly string[]).includes(o.updated)))
    out.updated = o.updated as UpdatedWindow;
  if (typeof o.reminder === 'string' && (o.reminder === '' || (REMINDER_CHOICES as readonly string[]).includes(o.reminder)))
    out.reminder = o.reminder as ReminderChoice;
  if (typeof o.fields === 'object' && o.fields !== null) {
    for (const key of FIELD_KEYS) {
      const list = strings((o.fields as Record<string, unknown>)[key]);
      if (list.length > 0) out.fields[key] = list;
    }
  }
  const bound = (v: unknown): Bound | undefined => {
    if (typeof v !== 'object' || v === null) return undefined;
    const b = v as Record<string, unknown>;
    return typeof b.label === 'string' && typeof b.n === 'number' && Number.isFinite(b.n)
      ? { label: b.label, n: b.n }
      : undefined;
  };
  if (typeof o.ranges === 'object' && o.ranges !== null) {
    for (const key of RANGE_KEYS) {
      const r = (o.ranges as Record<string, unknown>)[key] as Record<string, unknown> | undefined;
      const min = bound(r?.min);
      const max = bound(r?.max);
      if (min || max) out.ranges[key] = { ...(min ? { min } : {}), ...(max ? { max } : {}) };
    }
  }
  const day = (v: unknown): string | undefined =>
    typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : undefined;
  if (typeof o.dates === 'object' && o.dates !== null) {
    for (const key of DATE_KEYS) {
      const d = (o.dates as Record<string, unknown>)[key] as Record<string, unknown> | undefined;
      const from = day(d?.from);
      const to = day(d?.to);
      if (from || to) out.dates[key] = { ...(from ? { from } : {}), ...(to ? { to } : {}) };
    }
  }
  return out;
}
