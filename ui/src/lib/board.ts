// The board: one column for each status, the cards in the order the engine gave them (the page never sorts), and the
// two moves of a card - to another column (`set status`) and inside its group (`reorder`).

import type { Op } from './api';
import type { TaskEntry } from './contract';

/** The open statuses, left to right. */
export const COLUMNS = ['doing', 'decision', 'blocked', 'open', 'parked'] as const;
export type Column = (typeof COLUMNS)[number];

export function isColumn(status: string | undefined): status is Column {
  return status !== undefined && (COLUMNS as readonly string[]).includes(status);
}

/** Cards a column shows before "show more" (a long column is drawn in steps). */
export const COLUMN_FIRST = 50;

/** The tasks of each column, in the order they came in. A task with another status is not on the board. */
export function columnsOf(tasks: readonly TaskEntry[]): Record<Column, TaskEntry[]> {
  const out: Record<Column, TaskEntry[]> = { doing: [], decision: [], blocked: [], open: [], parked: [] };
  for (const task of tasks) {
    if (isColumn(task.status)) out[task.status].push(task);
  }
  return out;
}

/**
 * What the engine orders inside: the same status and effective priority (`group`) in the same stage. A card of the same
 * priority in another stage is another run - the engine refuses to place one beside the other.
 */
export function runKey(task: TaskEntry): string {
  return `${task.group ?? ''}#${task.readiness?.stage ?? ''}`;
}

/** Where the card goes in a column, or why it cannot. */
export type Move =
  | { kind: 'ok'; op: Op }
  /** Beside cards of another priority: set the priority too, if the person agrees (`ops` are sent in this order). */
  | { kind: 'prio'; id: string; from: string; prio: number; ops: Op[] }
  | { kind: 'refused'; reason: 'group' | 'status' | 'self' | 'edge' | 'unknown' };

/**
 * `id` placed before or after `target`. The engine moves a card inside its group only (the same status and the same
 * effective priority), so a target of another group is refused here rather than sent: the order has no meaning across
 * a priority border.
 */
export function placeNear(
  tasks: readonly TaskEntry[],
  id: string,
  target: { id: string; place: 'before' | 'after' },
  /** Whether the engine says it gives `readiness.eff_prio` (capability `eff_prio`); without it no priority is guessed. */
  prioKnown = true,
): Move {
  if (id === target.id) return { kind: 'refused', reason: 'self' };
  const card = tasks.find((t) => t.id === id);
  const near = tasks.find((t) => t.id === target.id);
  if (!card || !near) return { kind: 'refused', reason: 'unknown' };
  if (card.status !== near.status) return { kind: 'refused', reason: 'status' };
  if (runKey(card) !== runKey(near)) {
    const prio = prioKnown ? priorityOf(near) : null;
    // Only the priority differs: the move can carry it along. Another stage is another run, which no priority changes.
    if (prio === null || stageOf(card) === null || stageOf(card) !== stageOf(near)) {
      return { kind: 'refused', reason: 'group' };
    }
    return {
      kind: 'prio',
      id,
      from: groupLabel(card) ?? '-',
      prio,
      ops: [
        { op: 'set', id, patch: { prio }, ...(card.etag ? { if_match: card.etag } : {}) },
        // No version of the card: the set before it has changed the file. The group is the guard.
        { op: 'reorder', id, ...(target.place === 'before' ? { before: near.id } : { after: near.id }), group: near.group },
      ],
    };
  }
  return {
    kind: 'ok',
    op: {
      op: 'reorder',
      id,
      ...(target.place === 'before' ? { before: near.id } : { after: near.id }),
      ...(card.group ? { group: card.group } : {}),
      ...(card.etag ? { if_match: card.etag } : {}),
    },
  };
}

/**
 * One place up (`-1`) or down (`1`) among the cards of the same group in `column`. The edge of the group has nowhere
 * to go.
 */
export function stepInGroup(column: readonly TaskEntry[], id: string, dir: 1 | -1): Move {
  const card = column.find((t) => t.id === id);
  if (!card) return { kind: 'refused', reason: 'unknown' };
  const members = column.filter((t) => runKey(t) === runKey(card));
  const at = members.findIndex((t) => t.id === id);
  const near = members[at + dir];
  if (!near) return { kind: 'refused', reason: 'edge' };
  return placeNear(column, id, { id: near.id, place: dir === 1 ? 'after' : 'before' });
}

/** The column left (`-1`) or right (`1`) of `status`, or null at the end. */
export function neighbourColumn(status: string | undefined, dir: 1 | -1): Column | null {
  if (!isColumn(status)) return null;
  return COLUMNS[COLUMNS.indexOf(status) + dir] ?? null;
}

/**
 * Which half of a card a pointer is on: above the middle puts the dragged card before it, below the middle after.
 */
export function placeOf(pointerY: number, top: number, height: number): 'before' | 'after' {
  return pointerY < top + height / 2 ? 'before' : 'after';
}

/** The stage of a card, or null when the engine did not say (a task in a cycle has none). */
export function stageOf(task: TaskEntry): number | null {
  return task.readiness?.stage ?? null;
}

/**
 * The priority the engine groups a task by (`readiness.eff_prio`), or null for none. The `group` key is the engine's
 * guard for `reorder` and is passed back as it is; the page never takes it apart (WEB-13).
 */
export function priorityOf(task: TaskEntry): number | null {
  return task.readiness?.eff_prio ?? null;
}

/**
 * The label shown over a run of cards: the priority, `-` without one, null for a card the engine gave no group - and
 * null when the engine does not promise the number (`known` false: no `eff_prio` capability), so that it is not shown
 * as "no priority".
 */
export function groupLabel(task: TaskEntry, known = true): string | null {
  if (!known || !task.group) return null;
  const prio = priorityOf(task);
  return prio === null ? '-' : String(prio);
}
