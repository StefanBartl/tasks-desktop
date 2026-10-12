// Filtering the list. The UI never sorts: the order is the engine's `rank`
// (plan order), and a filter only takes tasks out of it.

import type { TaskEntry } from './contract';

export interface Filter {
  area: string | null;
  status: string | null;
  actor: string | null;
  query: string;
}

export const emptyFilter: Filter = { area: null, status: null, actor: null, query: '' };

export function matches(task: TaskEntry, filter: Filter): boolean {
  if (filter.area !== null && task.area !== filter.area) return false;
  if (filter.status !== null && task.status !== filter.status) return false;
  if (filter.actor !== null && task.actor !== filter.actor) return false;
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
