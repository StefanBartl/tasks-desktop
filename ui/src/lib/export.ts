// The tasks the list shows (or the ones marked) as text for somewhere else: Markdown for a note or a mail, CSV for a
// spreadsheet. Only fields the page already holds; nothing is read again and the order is the list's.

import type { TaskEntry } from './contract';

export type ExportFormat = 'markdown' | 'csv';

export const CSV_COLUMNS = [
  'id',
  'title',
  'status',
  'actor',
  'kind',
  'prio',
  'effort',
  'value',
  'severity',
  'plan',
  'phase',
  'tags',
  'updated',
] as const;

function day(value: string | undefined): string {
  return value === undefined ? '' : value.slice(0, 10);
}

function field(task: TaskEntry, column: (typeof CSV_COLUMNS)[number]): string {
  switch (column) {
    case 'tags':
      return task.tags.join(' ');
    case 'updated':
      return day(task.updated);
    default: {
      const value = task[column];
      return value === undefined || value === null ? '' : String(value);
    }
  }
}

/**
 * One cell. Quoted when it holds a separator, a quote or a line break. A cell a spreadsheet would read as a formula
 * (it starts with `=`, `+`, `-`, `@`, a tab or a carriage return) gets a quote mark in front, so a title cannot run.
 */
export function csvCell(text: string): string {
  const safe = /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
  return /[",;\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

export function toCsv(tasks: readonly TaskEntry[]): string {
  const rows = [CSV_COLUMNS.join(',')];
  for (const task of tasks) rows.push(CSV_COLUMNS.map((c) => csvCell(field(task, c))).join(','));
  return rows.join('\r\n') + '\r\n';
}

/** A title may hold characters Markdown reads as markup; they are escaped. */
function mdText(text: string): string {
  return text.replace(/[\\`*_{}[\]<>#|]/g, (c) => `\\${c}`).replace(/\s+/g, ' ').trim();
}

export function toMarkdown(tasks: readonly TaskEntry[]): string {
  const lines = tasks.map((task) => {
    const facts = [task.status, task.prio === undefined ? '' : `prio ${task.prio}`, task.effort, task.actor]
      .filter((x): x is string => typeof x === 'string' && x !== '')
      .join(', ');
    return `- ${task.status === 'done' ? '[x]' : '[ ]'} \`${task.id}\` ${mdText(task.title)}${facts ? ` (${facts})` : ''}`;
  });
  return lines.length === 0 ? '' : lines.join('\n') + '\n';
}

export function exportText(tasks: readonly TaskEntry[], format: ExportFormat): string {
  return format === 'csv' ? toCsv(tasks) : toMarkdown(tasks);
}
