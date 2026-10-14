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
}

export type Draft = Record<string, Cell>;

/** `id` with `field` set to `value`, or put back to "as the file has it" (`undefined`). Empty cells are dropped. */
export function withCell(draft: Draft, id: string, field: keyof Cell, value: string | number | undefined): Draft {
  const cell: Cell = { ...draft[id] };
  if (value === undefined) delete cell[field];
  else (cell as Record<string, string | number>)[field] = value;
  const next = { ...draft };
  if (cell.effort === undefined && cell.value === undefined) delete next[id];
  else next[id] = cell;
  return next;
}

/** The assumptions to ask the engine about: the cells of the draft, nothing else. */
export function assumeOf(draft: Draft): { id: string; effort?: string; value?: number }[] {
  return Object.entries(draft).map(([id, cell]) => ({ id, ...cell }));
}

/**
 * One `set` for every task whose draft differs from its file, with only the keys that differ and the version that was
 * shown (a task changed since is a conflict of its own). A cell equal to what the file has writes nothing.
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
      ops.push({ op: 'set', id: task.id, patch, ...(task.etag ? { if_match: task.etag } : {}) });
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
