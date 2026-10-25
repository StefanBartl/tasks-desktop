// The inbox: open tasks that are not sorted yet (no priority, no effort, no actor written), and the single keys that
// sort them. The page decides nothing about the values: it sends what the key names and the engine judges.

import type { TaskEntry } from './contract';

/** What a task in the inbox still lacks. */
export type Missing = 'prio' | 'effort' | 'actor';

export function missingOf(task: TaskEntry): Missing[] {
  const out: Missing[] = [];
  if (task.prio === undefined) out.push('prio');
  if (!task.effort) out.push('effort');
  // `actor` is derived when the file does not say: only a written one counts as sorted.
  if (task.actor_written !== true) out.push('actor');
  return out;
}

/**
 * The tasks that lack something, one area after the other (by name), inside an area in the order they came in (the
 * engine's plan order). The order does not depend on what is missing: a task that is being sorted keeps its place until
 * it leaves, so the rows do not jump under the keys.
 */
export function inboxOf(tasks: readonly TaskEntry[]): TaskEntry[] {
  // A plain comparison, not `localeCompare`: the getter runs for every key and every draw, and a collator costs a
  // lot of time for thousands of rows. The names of areas are the engine's; the order only has to be one order.
  const areaOf = (t: TaskEntry): string => String(t.area ?? '');
  return tasks.filter((t) => missingOf(t).length > 0).sort((a, b) => (areaOf(a) < areaOf(b) ? -1 : areaOf(a) > areaOf(b) ? 1 : 0));
}

/** One key, one field and the value it writes. */
export interface TriageKey {
  field: Missing;
  value: string | number;
}

/**
 * The keys: 1 2 3 for the priority; a s d f for the effort XS S M L and Shift with f for XL (the sizes grow to the
 * right); m p i for the actor me, pair and cdx (an agent). Case is read from the Shift key, not from the letter: a
 * CapsLock does not make a plain f an XL.
 */
export function triageKey(key: string, shift: boolean): TriageKey | null {
  if (key === '1' || key === '2' || key === '3') return { field: 'prio', value: Number(key) };
  const letter = key.toLowerCase();
  if (letter === 'f') return { field: 'effort', value: shift ? 'XL' : 'L' };
  if (shift) return null;
  switch (letter) {
    case 'a':
      return { field: 'effort', value: 'XS' };
    case 's':
      return { field: 'effort', value: 'S' };
    case 'd':
      return { field: 'effort', value: 'M' };
    case 'm':
      return { field: 'actor', value: 'me' };
    case 'p':
      return { field: 'actor', value: 'pair' };
    case 'i':
      return { field: 'actor', value: 'cdx' };
    default:
      return null;
  }
}

/** How many rows the inbox draws before the person asks for more (a vault can hold thousands of unsorted tasks). */
export const INBOX_PAGE = 100;

/**
 * How many of the rows are drawn: the limit grown in whole pages, and at least up to the selected row, so a key that
 * moves the selection far down never selects a row that is not on the page.
 */
export function shownCount(rows: readonly { id: string }[], selectedId: string | null, limit: number): number {
  const at = selectedId === null ? -1 : rows.findIndex((r) => r.id === selectedId);
  return Math.min(rows.length, Math.max(limit, at + 1));
}
