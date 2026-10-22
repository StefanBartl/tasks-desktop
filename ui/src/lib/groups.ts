// Groups: the tasks of a view laid in groups by a field, and the operation that a drag from one group to another is.
// Nothing here knows a field: which fields there are, what values each can have and how each is written is the engine's
// (`tasks.groupings`, WEB-13). This only reads the value a task has for a field and turns a drop into the operation the
// engine names for it (`set`, the list of tags, a move of the area).

import type { Op } from './api';
import type { Groupings, TaskEntry } from './contract';

/** A field a view can group by, as the engine describes it. */
export type Grouping = Groupings['fields'][number];

/** The value that stands for "this task has none" (a group of its own: a target too). */
export const NONE = '';

/** One group: its value (`NONE` for the tasks that have none) and the tasks that are in it. */
export interface Group<T> {
  value: string;
  items: T[];
}

/**
 * The values of a derived field another document of the engine holds (not the task entry): the caller reads them there
 * (`cross` from `tasks.links`). Undefined: the field is read from the entry.
 */
export type Derived = (task: TaskEntry, field: Grouping['field']) => string[] | undefined;

/**
 * The values a task has for a grouping, as the words of `grouping.values`: one, several for a list (tags), or none.
 * The field names the engine gives are the names of the entry, except `state` (the readiness) and what `derived` reads
 * - this reads, it does not judge.
 */
export function valuesOf(task: TaskEntry, grouping: Grouping, derived?: Derived): string[] {
  const read = derived?.(task, grouping.field);
  if (read !== undefined) return read;
  const entry = task as unknown as Record<string, unknown>;
  const raw = grouping.field === 'state' ? task.readiness?.state : entry[grouping.field];
  if (Array.isArray(raw)) return raw.filter((v): v is string => typeof v === 'string' && v !== '').map(String);
  if (raw === undefined || raw === null || raw === '') return [];
  return [String(raw)];
}

/**
 * The tasks in groups: one group for every value the engine names, in its order (an empty group stays: it is a place to
 * drop), a value the engine did not name after them in the order it is met, and the tasks that have none last. A task
 * with several values (tags) stands in each of their groups; the group of none shows only when some task has none.
 */
export function groupsOf<T extends TaskEntry>(items: readonly T[], grouping: Grouping, derived?: Derived): Group<T>[] {
  const groups = new Map<string, T[]>();
  for (const value of grouping.values) groups.set(value, []);
  const unnamed: string[] = [];
  const none: T[] = [];
  for (const item of items) {
    const values = valuesOf(item, grouping, derived);
    if (values.length === 0) {
      none.push(item);
      continue;
    }
    for (const value of values) {
      let list = groups.get(value);
      if (!list) {
        list = [];
        groups.set(value, list);
        unnamed.push(value);
      }
      list.push(item);
    }
  }
  const out: Group<T>[] = [...grouping.values, ...unnamed].map((value) => ({ value, items: groups.get(value) ?? [] }));
  if (none.length > 0) out.push({ value: NONE, items: none });
  return out;
}

/** The count a group shows: how many tasks are in it. */
export function countOf(group: Group<unknown>): number {
  return group.items.length;
}

/** The group before (`-1`) or after (`1`) `value`, or null at the end: where a key moves a card to. */
export function neighbourGroup(groups: readonly Group<unknown>[], value: string, dir: 1 | -1): string | null {
  const at = groups.findIndex((g) => g.value === value);
  if (at < 0) return null;
  return groups[at + dir]?.value ?? null;
}

/** Whether a drop with `copy` (the Ctrl key) keeps the group it leaves: only a list of tags can; any other field moves. */
export function keepsGroup(grouping: Grouping, copy: boolean): boolean {
  return copy && grouping.mode === 'tags';
}

/** What a drop comes to. */
export type Drop =
  | { kind: 'ops'; ops: Op[] }
  /** The area: not an operation of the field but a move of the file, which the page asks the engine to preview first. */
  | { kind: 'move_area'; id: string; area: string }
  | { kind: 'refused'; reason: 'read_only' | 'same' | 'required' | 'unknown' | 'area' };

/** A field of the file the page turns back to what the file has: a number as a number, the rest as it is. */
function written(grouping: Grouping, value: string): string | number {
  return grouping.value_type === 'number' ? Number(value) : value;
}

/**
 * The drop of `task` from the group `from` onto the group `to` (`NONE` is the group of those that have none). `copy`
 * (the Ctrl key) keeps the group it leaves: only for a list of tags, where a task can be in both.
 *
 * - a field of the file (`set`): one `set` of the field, with the version of the file the card showed (`if_match`); the
 *   group of none takes the key out (`null`), except for a field the file must have (`status`);
 * - the list of tags: one `set` of the whole list - the tag of the group left goes, the tag of the group entered comes
 *   (a tag the task has already is not doubled); with `copy` nothing goes;
 * - the area: not written here (`move_area`);
 * - a field the engine does not write (no `mode`): refused.
 */
export function dropOps(task: TaskEntry, grouping: Grouping, from: string, to: string, copy = false): Drop {
  if (grouping.mode === undefined || !grouping.writable) return { kind: 'refused', reason: 'read_only' };
  if (from === to && !copy) return { kind: 'refused', reason: 'same' };
  if (grouping.mode === 'move_area') {
    if (to === NONE) return { kind: 'refused', reason: 'required' };
    return { kind: 'move_area', id: task.id, area: to };
  }
  if (to !== NONE && !grouping.values.includes(to)) return { kind: 'refused', reason: 'unknown' };
  const guard = task.etag ? { if_match: task.etag } : {};
  if (grouping.mode === 'tags') {
    const has = task.tags ?? [];
    const next = has.filter((tag) => copy || tag !== from);
    if (to !== NONE && !next.includes(to)) next.push(to);
    if (next.length === has.length && next.every((tag, i) => tag === has[i])) return { kind: 'refused', reason: 'same' };
    return { kind: 'ops', ops: [{ op: 'set', id: task.id, patch: { tags: next.length > 0 ? next : null }, ...guard }] };
  }
  if (to === NONE) {
    if (grouping.field === 'status') return { kind: 'refused', reason: 'required' };
    return { kind: 'ops', ops: [{ op: 'set', id: task.id, patch: { [grouping.field]: null }, ...guard }] };
  }
  return { kind: 'ops', ops: [{ op: 'set', id: task.id, patch: { [grouping.field]: written(grouping, to) }, ...guard }] };
}

/** A cell of a matrix: the value of its row and of its column. */
export interface Cell {
  row: string;
  column: string;
}

/**
 * The drop of `task` from the cell `from` onto the cell `to` of a matrix: what changes of the row and of the column, as
 * ONE `set` (both fields on the version shown, so the file is never left with one of them written). A field that stays
 * is not written; a field that cannot be written so (read only, the area) refuses the whole drop.
 */
export function cellDropOps(task: TaskEntry, rows: Grouping, columns: Grouping, from: Cell, to: Cell): Drop {
  const parts: Drop[] = [];
  if (from.row !== to.row) parts.push(dropOps(task, rows, from.row, to.row));
  if (from.column !== to.column) parts.push(dropOps(task, columns, from.column, to.column));
  if (parts.length === 0) return { kind: 'refused', reason: 'same' };
  const patch: Record<string, unknown> = {};
  for (const part of parts) {
    // The area is a move of the file, asked of the engine first: a view grouped by area does that, a matrix does not.
    if (part.kind === 'move_area') return { kind: 'refused', reason: 'area' };
    if (part.kind === 'refused') return part;
    for (const op of part.ops) if (op.op === 'set') Object.assign(patch, op.patch);
  }
  const guard = task.etag ? { if_match: task.etag } : {};
  return { kind: 'ops', ops: [{ op: 'set', id: task.id, patch, ...guard }] };
}

/** The cell next to `at` in a matrix: a row up or down (`rows`), a column to the left or right, or null at the edge. */
export function neighbourCell(
  rows: readonly Group<unknown>[],
  columns: readonly Group<unknown>[],
  at: Cell,
  move: 'up' | 'down' | 'left' | 'right',
): Cell | null {
  if (move === 'up' || move === 'down') {
    const row = neighbourGroup(rows, at.row, move === 'down' ? 1 : -1);
    return row === null ? null : { row, column: at.column };
  }
  const column = neighbourGroup(columns, at.column, move === 'right' ? 1 : -1);
  return column === null ? null : { row: at.row, column };
}

/**
 * The two fields of a matrix: the cells of rows by columns, each with the tasks in both. Rows and columns are the groups
 * of the two groupings over all the tasks (so every row has the same columns, an empty cell included); the task of a list
 * field stands in every cell it belongs to.
 */
export function cellsOf<T extends TaskEntry>(
  items: readonly T[],
  rows: Grouping,
  columns: Grouping,
  derived?: Derived,
): { row: string; column: string; items: T[] }[] {
  const columnGroups = groupsOf(items, columns, derived).map((g) => ({ value: g.value, ids: new Set(g.items.map((i) => i.id)) }));
  const out: { row: string; column: string; items: T[] }[] = [];
  for (const row of groupsOf(items, rows, derived)) {
    for (const column of columnGroups) {
      out.push({ row: row.value, column: column.value, items: row.items.filter((i) => column.ids.has(i.id)) });
    }
  }
  return out;
}
