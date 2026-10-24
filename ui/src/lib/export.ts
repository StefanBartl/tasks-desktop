// The tasks a view shows (or the ones marked) as text for somewhere else: Markdown for a note or a mail, CSV for a
// spreadsheet, JSON for a program. Only fields the page already holds; nothing is read again and the order and the
// groups are the view's.

import type { TaskEntry } from './contract';

export type ExportFormat = 'markdown' | 'csv' | 'json';

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

/** The separator of a column: a spreadsheet in a German or Austrian setup reads `;`, the rest `,`. */
export type CsvSeparator = ',' | ';';

/**
 * The separator a spreadsheet of this locale reads: where the decimal mark is a comma (German, French, most of Europe)
 * the list separator is `;`, elsewhere `,`. It follows the locale of the browser, which is the one of the system and so
 * of the spreadsheet, not the language the page happens to be shown in.
 */
export function csvSeparatorFor(locale: string | undefined): CsvSeparator {
  try {
    const decimal = new Intl.NumberFormat(locale || 'en').formatToParts(1.1).find((p) => p.type === 'decimal')?.value;
    return decimal === ',' ? ';' : ',';
  } catch {
    return ',';
  }
}

/**
 * A task as a view shows it: with the group it stands in (a column of the board, a stage of the plan, a group or a
 * cell of a saved view). A task the view shows twice (a tag group for each of its tags) is two rows.
 */
export interface ExportRow {
  task: TaskEntry;
  group?: string;
}

const rowsOf = (tasks: readonly TaskEntry[]): ExportRow[] => tasks.map((task) => ({ task }));
const grouped = (rows: readonly ExportRow[]): boolean => rows.some((r) => r.group !== undefined);

/** The rows as CSV; a view with groups puts the group in a first column. */
export function rowsToCsv(rows: readonly ExportRow[], separator: CsvSeparator = ','): string {
  const withGroup = grouped(rows);
  const lines = [(withGroup ? ['group', ...CSV_COLUMNS] : [...CSV_COLUMNS]).join(separator)];
  for (const { task, group } of rows) {
    const cells = CSV_COLUMNS.map((c) => csvCell(field(task, c)));
    lines.push((withGroup ? [csvCell(group ?? ''), ...cells] : cells).join(separator));
  }
  return lines.join('\r\n') + '\r\n';
}

export function toCsv(tasks: readonly TaskEntry[], separator: CsvSeparator = ','): string {
  return rowsToCsv(rowsOf(tasks), separator);
}

/** The name of the format inside a JSON export: a reader can tell what it holds, and a later shape gets a new one. */
export const JSON_FORMAT = 'tasks-desktop-export/1';

/**
 * The rows as JSON: the fields of the CSV with their own types (a number stays a number, the tags a list), a field the
 * task does not have left out, and the group where the view has one. `view` names the view they come from.
 */
export function rowsToJson(rows: readonly ExportRow[], view: string): string {
  const tasks = rows.map(({ task, group }) => {
    const out: Record<string, unknown> = group === undefined ? {} : { group };
    for (const column of CSV_COLUMNS) {
      const value = task[column];
      if (value !== undefined && value !== null) out[column] = value;
    }
    return out;
  });
  return JSON.stringify({ format: JSON_FORMAT, view, tasks }, null, 2) + '\n';
}

/** A title may hold characters Markdown reads as markup; they are escaped. */
function mdText(text: string): string {
  return text.replace(/[\\`*_{}[\]<>#|]/g, (c) => `\\${c}`).replace(/\s+/g, ' ').trim();
}

function mdLine(task: TaskEntry): string {
  const facts = [task.status, task.prio === undefined ? '' : `prio ${task.prio}`, task.effort, task.actor]
    .filter((x): x is string => typeof x === 'string' && x !== '')
    .map(mdText)
    .join(', ');
  return `- ${task.status === 'done' ? '[x]' : '[ ]'} \`${task.id}\` ${mdText(task.title)}${facts ? ` (${facts})` : ''}`;
}

/** The rows as a Markdown list; a view with groups gives each group a heading of its own (in the order they come). */
export function rowsToMarkdown(rows: readonly ExportRow[]): string {
  if (rows.length === 0) return '';
  if (!grouped(rows)) return rows.map((r) => mdLine(r.task)).join('\n') + '\n';
  const parts: string[] = [];
  let current: string | undefined;
  for (const { task, group } of rows) {
    const name = group ?? '';
    if (parts.length === 0 || name !== current) {
      if (parts.length > 0) parts.push('');
      parts.push(`## ${mdText(name) || '-'}`, '');
      current = name;
    }
    parts.push(mdLine(task));
  }
  return parts.join('\n') + '\n';
}

export function toMarkdown(tasks: readonly TaskEntry[]): string {
  return rowsToMarkdown(rowsOf(tasks));
}

export function exportText(tasks: readonly TaskEntry[], format: ExportFormat, separator: CsvSeparator = ','): string {
  return rowsText(rowsOf(tasks), format, separator, 'list');
}

export function rowsText(rows: readonly ExportRow[], format: ExportFormat, separator: CsvSeparator, view: string): string {
  if (format === 'csv') return rowsToCsv(rows, separator);
  if (format === 'json') return rowsToJson(rows, view);
  return rowsToMarkdown(rows);
}

/** The file of a format: its ending and its media type. */
export const EXPORT_FILES: Record<ExportFormat, { ext: string; type: string }> = {
  csv: { ext: 'csv', type: 'text/csv;charset=utf-8' },
  json: { ext: 'json', type: 'application/json;charset=utf-8' },
  markdown: { ext: 'md', type: 'text/markdown;charset=utf-8' },
};

/** The name of the file: the view it shows and the day, e.g. `tasks-board-2026-10-24.csv`. A view's name is kept to safe letters. */
export function exportFileName(view: string, day: string, format: ExportFormat): string {
  const safe = view.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'list';
  return `tasks-${safe}-${day}.${EXPORT_FILES[format].ext}`;
}
