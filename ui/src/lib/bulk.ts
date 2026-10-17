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

/** Whether a key press in a field of the bar means "apply" (Enter, but not the Enter that ends an IME composition). */
export function isApplyKey(event: { key: string; isComposing?: boolean }): boolean {
  return event.key === 'Enter' && event.isComposing !== true;
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

/** One `move_area` of the bulk bar. */
export interface MoveOp {
  op: 'move_area';
  id: string;
  to_area: string;
  if_match?: string;
}

/**
 * One `move_area` for each marked task that is not in `toArea` already, each with the version of the file that was
 * shown. A batch is not all-or-nothing: each move stands alone, a task that changed meanwhile fails alone.
 */
export function bulkMoveOps(tasks: readonly TaskEntry[], marks: readonly string[], toArea: string): MoveOp[] {
  const byId = new Map(tasks.map((t) => [t.id, t] as const));
  const ops: MoveOp[] = [];
  for (const id of marks) {
    const task = byId.get(id);
    if (!task || task.area === toArea || task.status === 'done') continue;
    ops.push({ op: 'move_area', id, to_area: toArea, ...(task.etag ? { if_match: task.etag } : {}) });
  }
  return ops;
}

/** What the dry run said about one move of the bulk bar. */
export interface MoveCheck {
  id: string;
  /** The id after the move; empty when the engine refused it. */
  newId: string;
  /** Why it cannot be made (the engine's words); empty when it can. */
  reasons: string[];
  /** Places that name the old id and will name the new one. */
  references: number;
  /** The tasks and plans that name the old id (the engine's report): their files are rewritten by the move. */
  namedBy: string[];
}

/**
 * The answer of the dry run, one line per move in the order of `ops`. An entry that names no move is a refusal (its
 * message is the reason); one that is missing from the answer is told as refused with no reason.
 */
export function moveChecks(
  ops: readonly MoveOp[],
  results: readonly {
    n: number;
    move?: { new_id: string; conflicts: { message: string }[]; references: { id?: string; path?: string }[] };
    error?: { message?: string };
  }[],
): MoveCheck[] {
  return ops.map((op, i) => {
    const entry = results.find((r) => r.n === i + 1);
    const move = entry?.move;
    if (!move) return { id: op.id, newId: '', reasons: [entry?.error?.message ?? ''], references: 0, namedBy: [] };
    return {
      id: op.id,
      newId: move.new_id,
      reasons: move.conflicts.map((c) => c.message),
      references: move.references.length,
      namedBy: move.references.flatMap((r) => (typeof r.id === 'string' ? [r.id] : [])),
    };
  });
}

/**
 * The moves in the order they can all be made. Moving a task rewrites the files of the tasks that name it, so a marked
 * task that names another marked one would carry a version that is gone when its own move comes: it goes first (its
 * move rewrites nothing of its own). Otherwise the order of `ops` stays. Where tasks name each other in a circle no
 * order helps: the rest goes in the order of `ops`, and the one whose file changed fails alone (a conflict, told).
 */
export function moveOrder<T extends { id: string }>(ops: readonly T[], checks: readonly MoveCheck[]): T[] {
  const inBatch = new Set(ops.map((o) => o.id));
  const namedBy = new Map(checks.map((c) => [c.id, c.namedBy.filter((id) => inBatch.has(id) && id !== c.id)] as const));
  const left = [...ops];
  const done = new Set<string>();
  const out: T[] = [];
  while (left.length > 0) {
    let i = left.findIndex((o) => (namedBy.get(o.id) ?? []).every((id) => done.has(id)));
    if (i < 0) i = 0;
    const next = left.splice(i, 1)[0] as T;
    out.push(next);
    done.add(next.id);
  }
  return out;
}

/** One entry of the answer to a batch of moves, as far as the way back needs it. */
interface MoveAnswer {
  n: number;
  ok: boolean;
  outcome?: string;
  inverse?: { op: string; id: string; to_area?: string; if_match?: string };
  rewritten?: { id: string }[];
}

/**
 * The way back from a batch of moves: the engine's inverse of each move that was made, in an order they can all be
 * made in (a task that names another goes first, as on the way there). The version an inverse carries is the one its
 * move left; when a later move of the same batch rewrote that file (it names a task moved after it), that version is
 * gone and only the engine knows the new one, so that inverse goes without it rather than fail as a conflict of the
 * batch with itself. Undefined when a made move has no inverse.
 */
export function moveUndo(results: readonly MoveAnswer[]): MoveOp[] | undefined {
  const made = results.filter((r) => r.ok && r.outcome === 'moved').sort((a, b) => a.n - b.n);
  const back: MoveOp[] = [];
  const checks: MoveCheck[] = [];
  for (const [k, r] of made.entries()) {
    const inv = r.inverse;
    if (!inv || inv.op !== 'move_area' || typeof inv.to_area !== 'string') return undefined;
    const rewrittenLater = made.slice(k + 1).some((later) => (later.rewritten ?? []).some((w) => w.id === inv.id));
    back.push({
      op: 'move_area',
      id: inv.id,
      to_area: inv.to_area,
      ...(inv.if_match && !rewrittenLater ? { if_match: inv.if_match } : {}),
    });
    const namedBy = (r.rewritten ?? []).map((w) => w.id);
    checks.push({ id: inv.id, newId: '', reasons: [], references: namedBy.length, namedBy });
  }
  return back.length > 0 ? moveOrder(back, checks) : undefined;
}

/**
 * The marks after a batch of moves: a moved task keeps its mark under its new id (the old id points nowhere), the rest
 * stays as it was, order kept. `moved` maps the old id to the new one.
 */
export function followMoves(marks: readonly string[], moved: ReadonlyMap<string, string>): string[] {
  const out: string[] = [];
  for (const id of marks) {
    const next = moved.get(id) ?? id;
    if (!out.includes(next)) out.push(next);
  }
  return out;
}
