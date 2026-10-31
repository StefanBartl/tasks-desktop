// The acceptance view: the test-sheet block testing.nvim writes into a live-check task (`testing sheets report --tasks`)
// read as a work list. The page reads the text the report wrote (the criteria as checkboxes, the snapshot names); it
// decides nothing about the state of a sheet (the engine reads the states line, `TaskEntry.sheets`) and writes a tick
// back as the one changed line of the body (`set_body` on the version read).

import type { TaskEntry } from './contract';

const BEGIN = '<!-- testing:sheets:begin -->';
const END = '<!-- testing:sheets:end -->';
const STATES = '<!-- testing:sheets:states';

/** One criterion of a sheet: a person judges it (`judge`) or does it by hand (`manual`). */
export interface Item {
  kind: 'judge' | 'manual';
  text: string;
  checked: boolean;
  /** The line of the body (0-based), so that a tick rewrites that line and nothing else. */
  line: number;
}

/** One sheet of the block, with what is left for a person. */
export interface Sheet {
  title: string;
  /** The id of the sheet; absent for a sheet that does not load (it has none). */
  id?: string;
  /** The state its entry of the states line gives: `inbox`, `manual`, `green`, ... */
  state?: string;
  items: Item[];
  /** The snapshots to look at, as the block names them: `<repo>/TESTS/__snapshots__/<path>.snap`. */
  snapshots: string[];
}

const BOX = /^(\s*)- \[([ xX])\] ([^\r]*)(\r?)$/;
const SHEET = /^- \*\*(.*)\*\* \((.*)\): [\s\S]*$/;

/** The code spans (`...`) of a line, in order. */
function codes(text: string): string[] {
  return [...text.matchAll(/`([^`]*)`/g)].map((m) => m[1] ?? '');
}

/** The `<id>=<state>` pairs of the states line. */
function statesOf(lines: readonly string[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of lines) {
    if (!line.startsWith(STATES)) continue;
    const rest = line.slice(STATES.length).replace(/-->\s*$/, '').trim();
    for (const part of rest.split(/\s+/)) {
      const at = part.lastIndexOf('=');
      if (at > 0) out.set(part.slice(0, at), part.slice(at + 1));
    }
  }
  return out;
}

/**
 * The sheets of the block in a task's body; none without a block, or with a broken one (two blocks, a begin without
 * its end): a body the report did not write is not read.
 */
export function parseSheets(body: string): Sheet[] {
  const lines = body.split('\n');
  const begins = lines.flatMap((l, i) => (l.trim() === BEGIN ? [i] : []));
  const ends = lines.flatMap((l, i) => (l.trim() === END ? [i] : []));
  if (begins.length !== 1 || ends.length !== 1) return [];
  const from = begins[0] ?? 0;
  const to = ends[0] ?? 0;
  if (to < from) return [];
  const states = statesOf(lines.slice(from, to));
  const sheets: Sheet[] = [];
  let sheet: Sheet | null = null;
  let kind: Item['kind'] | null = null;
  for (let i = from + 1; i < to; i++) {
    const line = lines[i] ?? '';
    const head = SHEET.exec(line);
    if (head) {
      const spans = codes(head[2] ?? '');
      // `(`id`, `where`)`: two spans with an id, one for a sheet that does not load.
      const id = spans.length > 1 ? spans[0] : undefined;
      sheet = { title: head[1] ?? '', ...(id ? { id } : {}), items: [], snapshots: [] };
      const state = id ? states.get(id) : undefined;
      if (state) sheet.state = state;
      sheets.push(sheet);
      kind = null;
      continue;
    }
    if (!sheet) continue;
    const trimmed = line.trim();
    if (trimmed === '- Judge:') kind = 'judge';
    else if (trimmed === '- By hand:') kind = 'manual';
    else if (trimmed.startsWith('- Look at:')) {
      sheet.snapshots = codes(trimmed);
      kind = null;
    } else {
      const box = BOX.exec(line);
      if (box && kind) sheet.items.push({ kind, text: box[3] ?? '', checked: box[2] !== ' ', line: i });
    }
  }
  return sheets;
}

/** The sheets that wait for a person: green by machine (`inbox`) or by hand only (`manual`), with something to tick. */
export function waiting(sheets: readonly Sheet[]): Sheet[] {
  return sheets.filter((s) => (s.state === 'inbox' || s.state === 'manual') && s.items.length > 0);
}

/** Whether every criterion of the waiting sheets is ticked (and there is one): then the page offers `done`. */
export function allTicked(sheets: readonly Sheet[]): boolean {
  const open = waiting(sheets);
  return open.length > 0 && open.every((s) => s.items.every((i) => i.checked));
}

/** How many criteria are ticked and how many there are, over the waiting sheets. */
export function progress(sheets: readonly Sheet[]): { ticked: number; total: number } {
  let ticked = 0;
  let total = 0;
  for (const sheet of waiting(sheets)) {
    for (const item of sheet.items) {
      total++;
      if (item.checked) ticked++;
    }
  }
  return { ticked, total };
}

/**
 * The body with the box of `item` set to `checked`: only that line changes. Null when the line is not that box any
 * more (the body changed since it was read): the page then reads it again instead of writing over the new text.
 */
export function tickItem(body: string, item: Pick<Item, 'line' | 'text'>, checked: boolean): string | null {
  const lines = body.split('\n');
  const box = BOX.exec(lines[item.line] ?? '');
  if (!box || box[3] !== item.text) return null;
  lines[item.line] = `${box[1]}- [${checked ? 'x' : ' '}] ${item.text}${box[4]}`;
  return lines.join('\n');
}

/** The open live-check tasks that wait for a person: their sheets' worst state is `inbox` or `manual`. */
export function abnahmeOf(tasks: readonly TaskEntry[]): TaskEntry[] {
  return tasks.filter((t) => t.sheets?.state === 'inbox' || t.sheets?.state === 'manual');
}

/** A snapshot as the rows of a grid: the text, a trailing newline not an extra row. */
export function rowsOf(text: string): string[] {
  const rows = text.replace(/\r\n/g, '\n').split('\n');
  if (rows.length > 1 && rows[rows.length - 1] === '') rows.pop();
  return rows;
}
