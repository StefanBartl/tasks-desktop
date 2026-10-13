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
): Move {
  if (id === target.id) return { kind: 'refused', reason: 'self' };
  const card = tasks.find((t) => t.id === id);
  const near = tasks.find((t) => t.id === target.id);
  if (!card || !near) return { kind: 'refused', reason: 'unknown' };
  if (card.status !== near.status) return { kind: 'refused', reason: 'status' };
  if (runKey(card) !== runKey(near)) return { kind: 'refused', reason: 'group' };
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

/** The group label shown over a run of cards: the priority part of `status|eff_prio`. */
export function groupLabel(group: string | undefined): string | null {
  if (!group) return null;
  const at = group.indexOf('|');
  return at < 0 ? null : group.slice(at + 1);
}
