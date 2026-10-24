// The rows of the view that is shown, for the export: the tasks the page draws, in its order and with the group each
// stands in. The same functions that make the groups of the views make these; nothing is sorted or reckoned here.

import { COLUMNS, columnsOf } from './board';
import type { TaskEntry } from './contract';
import type { ExportRow } from './export';
import type { Group } from './groups';
import type { Stage } from './plan';

/** The board: a column for each status, in the order of the columns, the engine's order inside. */
export function boardRows(tasks: readonly TaskEntry[]): ExportRow[] {
  const columns = columnsOf(tasks);
  return COLUMNS.flatMap((column) => columns[column].map((task) => ({ task, group: column })));
}

/** The plan: the stages in order (the tasks without a stage last, as the view has them). */
export function stageRows(stages: readonly Stage[]): ExportRow[] {
  return stages.flatMap((s) => s.tasks.map((task) => ({ task, group: s.stage === null ? 'no stage' : `stage ${s.stage}` })));
}

/** A saved view shown as columns or as a list: its groups in order (the group of no value is an empty one). */
export function groupRows(groups: readonly Group<TaskEntry>[]): ExportRow[] {
  return groups.flatMap((g) => g.items.map((task) => ({ task, group: g.value })));
}

/** A saved view shown as a matrix: the cells row by row, each named by its row and its column. */
export function cellRows(cells: readonly { row: string; column: string; items: TaskEntry[] }[]): ExportRow[] {
  return cells.flatMap((c) => c.items.map((task) => ({ task, group: `${c.row} / ${c.column}` })));
}

/** Only the marked tasks, when some are marked: the marks say what is meant. */
export function onlyMarked(rows: readonly ExportRow[], marks: ReadonlySet<string>): ExportRow[] {
  return marks.size === 0 ? [...rows] : rows.filter((r) => marks.has(r.task.id));
}

/**
 * The rows that may leave the page, and how many tasks may not: a task of a private or unclassified area stays in
 * the app (rules WEB-17 and SRV-21), as it stays out of the browser's cache. A task counts once, however many rows.
 */
export function mayLeave(rows: readonly ExportRow[], allowed: (task: TaskEntry) => boolean): { rows: ExportRow[]; kept: number } {
  const out: ExportRow[] = [];
  const kept = new Set<string>();
  for (const row of rows) {
    if (allowed(row.task)) out.push(row);
    else kept.add(row.task.id);
  }
  return { rows: out, kept: kept.size };
}

/** How many tasks the rows hold (a task in two groups is one). */
export function taskCount(rows: readonly ExportRow[]): number {
  return new Set(rows.map((r) => r.task.id)).size;
}
