// The estimate matrix: effort and value of many tasks set side by side. The page keeps a draft of the cells the person
// changed and asks the engine what the figures would be (`estimate` with `assume`); it never reckons a sum itself
// (WEB-13). Only the cells that differ from the file are written, in one batch.

import type { Op } from './api';
import type { TaskEntry } from './contract';

/** The most tasks the matrix holds (the engine and the hub take a thousand; a matrix of a hundred is already long). */
export const MATRIX_MAX = 100;

/** What the person chose for one task; a missing key is "as the file has it". */
export interface Cell {
  effort?: string;
  value?: number;
  /** The version of the file when the person first chose a cell of this task: a change made since is a conflict. */
  etag?: string;
}

export type Draft = Record<string, Cell>;

export function withCell(
  draft: Draft,
  id: string,
  field: 'effort' | 'value',
  value: string | number | undefined,
  /** The version of the task's file as it is now; kept from the first choice on. */
  etag?: string,
): Draft {
  const cell: Cell = { ...draft[id] };
  if (value === undefined) delete cell[field];
  else (cell as Record<string, string | number>)[field] = value;
  if (cell.etag === undefined && etag !== undefined) cell.etag = etag;
  const next = { ...draft };
  if (cell.effort === undefined && cell.value === undefined) delete next[id];
  else next[id] = cell;
  return next;
}

/** The assumptions to ask the engine about: the cells of the draft that name a task of `ids`, nothing else. */
export function assumeOf(
  draft: Draft,
  ids?: readonly string[],
): { id: string; effort?: string; value?: number }[] {
  const out: { id: string; effort?: string; value?: number }[] = [];
  for (const [id, cell] of Object.entries(draft)) {
    if (ids && !ids.includes(id)) continue;
    out.push({
      id,
      ...(cell.effort !== undefined ? { effort: cell.effort } : {}),
      ...(cell.value !== undefined ? { value: cell.value } : {}),
    });
  }
  return out;
}

/** The draft without the tasks that are not there any more (finished, moved: the engine would refuse them). */
export function pruneDraft(draft: Draft, ids: readonly string[]): Draft {
  const keep = new Set(ids);
  return Object.fromEntries(Object.entries(draft).filter(([id]) => keep.has(id)));
}

/**
 * One `set` for every task whose draft differs from its file, with only the keys that differ and the version the file
 * had when the cell was chosen (a task changed since is a conflict of its own, also one changed while the dialog was
 * open). A cell equal to what the file has writes nothing.
 */
export function changesOf(tasks: readonly TaskEntry[], draft: Draft): Op[] {
  const ops: Op[] = [];
  for (const task of tasks) {
    const cell = draft[task.id];
    if (!cell) continue;
    const patch: Record<string, unknown> = {};
    if (cell.effort !== undefined && cell.effort !== task.effort) patch.effort = cell.effort;
    if (cell.value !== undefined && cell.value !== task.value) patch.value = cell.value;
    if (Object.keys(patch).length > 0) {
      const seen = cell.etag ?? task.etag;
      ops.push({ op: 'set', id: task.id, patch, ...(seen ? { if_match: seen } : {}) });
    }
  }
  return ops;
}

/** The tasks the matrix opens on: the marked ones, else those the list shows (up to `MATRIX_MAX`). */
export function matrixIds(marks: readonly string[], shown: readonly TaskEntry[]): string[] {
  const ids = marks.length > 0 ? marks : shown.map((t) => t.id);
  return ids.slice(0, MATRIX_MAX);
}

/**
 * The tasks that failed in an answer of `ops`, by the position of the operation or the id the error names; null when
 * a failure cannot be traced to a task (then nothing is taken off the draft).
 */
export function failedIdsOf(
  ops: readonly Op[],
  results: readonly { n: number; ok: boolean; error?: { details?: unknown } }[],
): Set<string> | null {
  const failed = new Set<string>();
  let unknown = false;
  for (const r of results) {
    if (r.ok) continue;
    const op = ops[r.n - 1];
    const id = (op && 'id' in op ? op.id : undefined) ?? (r.error?.details as { id?: unknown } | undefined)?.id;
    if (typeof id === 'string') failed.add(id);
    else unknown = true;
  }
  return unknown ? null : failed;
}
