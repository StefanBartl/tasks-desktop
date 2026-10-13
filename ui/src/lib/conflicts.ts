// The conflict center: the changes the engine refused because the file moved on (or was gone, or locked) are kept in
// one place instead of one toast each. For every one the person sees what was wanted next to what is there now, and
// can try again on the version that is there (which is a decision, so it is never done by itself) or let it go.

import type { Op } from './api';
import type { Result, TaskEntry } from './contract';

/** The kinds of operation whose refusal is kept. */
type Kept = Extract<Op, { op: 'set' | 'reorder' }>;

/** The refusals that say "not now, or not like this": the file changed, is gone or is locked. */
export const CONFLICT_CODES: readonly string[] = ['conflict', 'not_found', 'locked', 'lock_stuck'];

/** Entries kept; the oldest go. */
export const CONFLICTS_MAX = 50;

export interface Conflict {
  /** One entry for the same change of the same task: a newer refusal replaces the older one. */
  key: string;
  id: string;
  op: Kept;
  code: string;
  /** When it was refused (ms since the epoch). */
  at: number;
}

function keyOf(op: Kept): string {
  const what = op.op === 'set' ? Object.keys(op.patch).sort().join(',') : 'order';
  return `${op.op}:${op.id}:${what}`;
}

function kept(op: Op | undefined): op is Kept {
  return op !== undefined && (op.op === 'set' || op.op === 'reorder');
}

/** The refusals in the answer of a write, with the operation each one was. */
export function conflictsOf(ops: readonly Op[], result: Result, now: number): Conflict[] {
  const out: Conflict[] = [];
  for (const entry of result.results) {
    if (entry.ok) continue;
    const code = entry.error?.code;
    if (code === undefined || !CONFLICT_CODES.includes(code)) continue;
    // The entry names its operation by position: that is the one that was sent.
    const op = ops[entry.n - 1];
    if (!kept(op)) continue;
    out.push({ key: keyOf(op), id: op.id, op, code, at: now });
  }
  return out;
}

/** Every change of a request that the engine refused as a whole (a `409`): the tasks it named are all in doubt. */
export function conflictsOfRequest(ops: readonly Op[], now: number): Conflict[] {
  return ops.filter(kept).map((op) => ({ key: keyOf(op), id: op.id, op, code: 'conflict', at: now }));
}

/** `add` in front of `list`: a newer refusal of the same change replaces the older, the newest come first. */
export function mergeConflicts(list: readonly Conflict[], add: readonly Conflict[]): Conflict[] {
  if (add.length === 0) return [...list];
  const fresh = new Set(add.map((c) => c.key));
  return [...add, ...list.filter((c) => !fresh.has(c.key))].slice(0, CONFLICTS_MAX);
}

/** A value as the list shows it: a list joined, nothing as a dash. */
export function formatValue(value: unknown): string {
  if (value === null || value === undefined || value === '') return '-';
  if (Array.isArray(value)) return value.length === 0 ? '-' : value.map(String).join(', ');
  return String(value);
}

export interface Difference {
  key: string;
  wanted: string;
  now: string;
}

/** For a `set`: each key that was wanted, what was wanted and what the task has now. A `reorder` has none. */
export function differences(conflict: Conflict, task: TaskEntry | undefined): Difference[] {
  if (conflict.op.op !== 'set') return [];
  const current = task as unknown as Record<string, unknown> | undefined;
  return Object.entries(conflict.op.patch).map(([key, wanted]) => ({
    key,
    wanted: formatValue(wanted),
    now: current ? formatValue(current[key]) : '-',
  }));
}

/** Whether the change is already what the task has (a retry would write nothing). */
export function alreadyDone(conflict: Conflict, task: TaskEntry | undefined): boolean {
  const diff = differences(conflict, task);
  return diff.length > 0 && diff.every((d) => d.wanted === d.now);
}

/**
 * The operation for "try again": a `set` with the version the task has now (so the person's choice, shown beside
 * what is there, replaces it). A change of the order is not repeated: the place it meant is gone with the list that
 * moved on. A task that is not there has nothing to try.
 */
export function retryOp(conflict: Conflict, task: TaskEntry | undefined): Op | null {
  if (conflict.op.op !== 'set' || task === undefined) return null;
  return {
    op: 'set',
    id: conflict.id,
    patch: { ...conflict.op.patch },
    ...(task.etag ? { if_match: task.etag } : {}),
  };
}
