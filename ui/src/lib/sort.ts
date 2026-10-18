// The orders the engine offers for the list (`tasks list --sort`). The page never sorts by itself: it asks the
// engine for the ids in the order of a word and lays the tasks it holds along that order.

import type { TaskEntry } from './contract';

export const SORTS = ['default', 'prio-effort', 'severity', 'frecency', 'roi'] as const;
export type SortWord = (typeof SORTS)[number];

/** A remembered word, or the plan's order when it is none of ours. */
export function parseSort(value: unknown): SortWord {
  return typeof value === 'string' && (SORTS as readonly string[]).includes(value) ? (value as SortWord) : 'default';
}

/** The ids of an answer as a place each: the first id is 0. */
export function orderOf(ids: readonly string[]): Map<string, number> {
  return new Map(ids.map((id, i) => [id, i]));
}

/**
 * The tasks along `order`. A task the order does not name (it came after the answer) follows the named ones in
 * the order it had; the sort is stable, so ties keep the order they came in.
 */
export function applyOrder(tasks: readonly TaskEntry[], order: ReadonlyMap<string, number> | null): TaskEntry[] {
  if (order === null) return [...tasks];
  const last = order.size;
  return tasks
    .map((task, i) => ({ task, i }))
    .sort((a, b) => (order.get(a.task.id) ?? last) - (order.get(b.task.id) ?? last) || a.i - b.i)
    .map((x) => x.task);
}
