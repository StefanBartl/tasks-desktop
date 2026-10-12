// Filtering the list. The UI never sorts: the order is the engine's `rank`
// (plan order), and a filter only takes tasks out of it.

import type { TaskEntry } from './contract';

export interface Filter {
  /** Tasks of any of these areas; none chosen means every area. */
  areas: string[];
  /** Any of these statuses. */
  statuses: string[];
  /** Any of these actors; `none` is a task nobody classified. */
  actors: string[];
  query: string;
}

export const emptyFilter: Filter = { areas: [], statuses: [], actors: [], query: '' };

/** A task with no `actor` is chosen by this word. */
export const NO_ACTOR = 'none';

export function matches(task: TaskEntry, filter: Filter): boolean {
  if (filter.areas.length > 0 && !filter.areas.includes(task.area)) return false;
  if (filter.statuses.length > 0 && !filter.statuses.includes(task.status ?? '')) return false;
  if (filter.actors.length > 0 && !filter.actors.includes(task.actor ?? NO_ACTOR)) return false;
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

export function applyFilter(tasks: readonly TaskEntry[], filter: Filter): TaskEntry[] {
  return tasks.filter((t) => matches(t, filter));
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
