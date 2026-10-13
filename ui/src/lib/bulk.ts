// Bulk changes: a set of marked tasks and the one batch that changes them all.

import type { TaskEntry } from './contract';

/** The most operations the hub takes in one request (`OPS_MAX` of the hub); a mark is refused past it. */
export const BULK_MAX = 100;

/** `id` marked or unmarked. A mark past `BULK_MAX` is refused (the list comes back as it was). */
export function toggleMark(marks: readonly string[], id: string): string[] {
  if (marks.includes(id)) return marks.filter((m) => m !== id);
  return marks.length >= BULK_MAX ? [...marks] : [...marks, id];
}

/** The marks of the tasks that are still there, in the order they were made. */
export function pruneMarks(marks: readonly string[], tasks: readonly TaskEntry[]): string[] {
  const ids = new Set(tasks.map((t) => t.id));
  return marks.filter((m) => ids.has(m));
}

/** Mark every id in `ids` (up to `BULK_MAX`), keeping what is marked. */
export function markAll(marks: readonly string[], ids: readonly string[]): string[] {
  const out = [...marks];
  const have = new Set(out);
  for (const id of ids) {
    if (out.length >= BULK_MAX) break;
    if (!have.has(id)) {
      have.add(id);
      out.push(id);
    }
  }
  return out;
}

/**
 * One `set` for each marked task that is still in the list, each with the version of the file that was shown, so a
 * file changed since is a conflict of its own and never overwritten.
 */
export function bulkSetOps(
  tasks: readonly TaskEntry[],
  marks: readonly string[],
  patch: Record<string, unknown>,
): { op: 'set'; id: string; patch: Record<string, unknown>; if_match?: string }[] {
  const byId = new Map(tasks.map((t) => [t.id, t] as const));
  const ops: { op: 'set'; id: string; patch: Record<string, unknown>; if_match?: string }[] = [];
  for (const id of marks) {
    const task = byId.get(id);
    if (!task) continue;
    ops.push({ op: 'set', id, patch: { ...patch }, ...(task.etag ? { if_match: task.etag } : {}) });
  }
  return ops;
}
