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

/** Tags to put on and to take off every marked task (what a task has otherwise stays). */
export interface TagEdit {
  add: readonly string[];
  remove: readonly string[];
}

/** The tags of a task after `edit`, or null when they stay as they are (removed first, then added, order kept). */
export function editedTags(current: readonly string[] | undefined, edit: TagEdit): string[] | null {
  const now = current ?? [];
  const drop = new Set(edit.remove);
  const next = now.filter((tag) => !drop.has(tag));
  for (const tag of edit.add) if (!next.includes(tag)) next.push(tag);
  return next.length === now.length && next.every((tag, i) => tag === now[i]) ? null : next;
}

/**
 * One `set` for each marked task that still changes, each with the version of the file that was shown, so a file
 * changed since is a conflict of its own and never overwritten. `tags` is worked out for each task from the tags it
 * has (none left is `null`, which takes the key away); a task that has what was asked for already is left out.
 */
export function bulkSetOps(
  tasks: readonly TaskEntry[],
  marks: readonly string[],
  patch: Record<string, unknown>,
  tags?: TagEdit,
): { op: 'set'; id: string; patch: Record<string, unknown>; if_match?: string }[] {
  const byId = new Map(tasks.map((t) => [t.id, t] as const));
  const ops: { op: 'set'; id: string; patch: Record<string, unknown>; if_match?: string }[] = [];
  for (const id of marks) {
    const task = byId.get(id);
    if (!task) continue;
    const own: Record<string, unknown> = { ...patch };
    if (tags) {
      const next = editedTags(task.tags, tags);
      if (next !== null) own.tags = next.length === 0 ? null : next;
    }
    if (Object.keys(own).length === 0) continue;
    ops.push({ op: 'set', id, patch: own, ...(task.etag ? { if_match: task.etag } : {}) });
  }
  return ops;
}
