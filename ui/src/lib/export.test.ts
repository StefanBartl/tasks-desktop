import { describe, expect, it, vi } from 'vitest';
import { copyText, printSheet, saveText, VIEW_PRINT_CLASS, VIEW_PRINT_ID } from './exportDom';
import {
  csvCell,
  csvSeparatorFor,
  EXPORT_FILES,
  exportFileName,
  exportText,
  JSON_FORMAT,
  rowsText,
  rowsToCsv,
  rowsToJson,
  rowsToMarkdown,
  sheetOf,
  toCsv,
  toMarkdown,
} from './export';
import { task } from './fixtures';
import { printDaily } from './dailyExport';

describe('csv', () => {
  it('quotes what needs it and doubles the quotes', () => {
    expect(csvCell('plain')).toBe('plain');
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell('two\nlines')).toBe('"two\nlines"');
  });

  it('does not let a cell run as a formula in a spreadsheet', () => {
    for (const bad of ['=1+1', '+1', '-1', '@SUM(A1)', '\tx', '\rx']) {
      // A cell with a line break is put in quotes after the mark was added.
      expect(csvCell(bad).replace(/^"/, '').startsWith("'"), JSON.stringify(bad)).toBe(true);
    }
    expect(csvCell('=HYPERLINK("x","y")')).toBe(`"'=HYPERLINK(""x"",""y"")"`);
  });

  it('has a header and one row per task, in the order given', () => {
    const csv = toCsv([
      task('a/one', { title: 'One, first', status: 'open', prio: 1, tags: ['x', 'y'], updated: '2026-10-18T10:00:00Z' }),
      task('a/two', { title: 'Two' }),
    ]);
    const lines = csv.trimEnd().split('\r\n');
    expect(lines[0]).toBe('id,title,status,actor,kind,prio,effort,value,severity,plan,phase,tags,updated');
    expect(lines[1]).toBe('a/one,"One, first",open,,,1,,,,,,x y,2026-10-18');
    expect(lines[2]).toBe('a/two,Two,,,,,,,,,,,');
  });
});

describe('the separator of a locale', () => {
  it('is ; where the decimal mark is a comma, and , elsewhere', () => {
    for (const locale of ['de', 'de-AT', 'fr', 'it-IT']) expect(csvSeparatorFor(locale), locale).toBe(';');
    for (const locale of ['en', 'en-US', 'ja']) expect(csvSeparatorFor(locale), locale).toBe(',');
  });

  it('falls back to a comma for a locale that is none, or for no locale', () => {
    expect(csvSeparatorFor(undefined)).toBe(',');
    expect(csvSeparatorFor('not a locale!')).toBe(',');
  });
});

describe('the separator', () => {
  it('splits the columns at the one the spreadsheet of the person reads', () => {
    const rows = [task('a/one', { title: 'One, first', status: 'open' })];
    expect(toCsv(rows).split('\r\n')[0]).toBe('id,title,status,actor,kind,prio,effort,value,severity,plan,phase,tags,updated');
    const german = toCsv(rows, ';').split('\r\n');
    expect(german[0]).toBe('id;title;status;actor;kind;prio;effort;value;severity;plan;phase;tags;updated');
    expect(german[1]).toBe('a/one;"One, first";open;;;;;;;;;;');
    expect(exportText(rows, 'csv', ';')).toBe(toCsv(rows, ';'));
  });

  it('puts a cell that holds either separator in quotes', () => {
    expect(csvCell('a;b')).toBe('"a;b"');
    expect(csvCell('a,b')).toBe('"a,b"');
  });
});

describe('markdown', () => {
  it('escapes the facts like the title', () => {
    expect(toMarkdown([task('a/one', { title: 'T', status: 'open', effort: '*big*' })])).toBe(
      '- [ ] `a/one` T (open, \\*big\\*)\n',
    );
  });

  it('is a list with the id, the title and the facts, markup in titles escaped', () => {
    const md = toMarkdown([
      task('a/one', { title: 'Fix *the* [thing]', status: 'open', prio: 2, effort: 'S' }),
      task('a/two', { title: 'Plain', status: 'done' }),
    ]);
    expect(md).toBe('- [ ] `a/one` Fix \\*the\\* \\[thing\\] (open, prio 2, S)\n- [x] `a/two` Plain (done)\n');
  });

  it('is empty for no task, and exportText picks the format', () => {
    expect(toMarkdown([])).toBe('');
    expect(exportText([task('a/b')], 'csv')).toContain('id,title');
    expect(exportText([task('a/b')], 'markdown')).toContain('`a/b`');
  });
});

describe('copyText', () => {
  it('writes the text and says so', async () => {
    const written: string[] = [];
    const ok = await copyText({ writeText: async (t: string) => void written.push(t) }, 'a,b');
    expect(ok).toBe(true);
    expect(written).toEqual(['a,b']);
  });

  it('says no when the browser refuses or there is no clipboard', async () => {
    const refuse = async () => {
      throw new DOMException('blocked', 'NotAllowedError');
    };
    expect(await copyText({ writeText: refuse }, 'x')).toBe(false);
    expect(await copyText(undefined, 'x')).toBe(false);
  });
});

describe('saveText', () => {
  /** Run `saveText` against a page that only keeps the blob it was given. */
  async function saved(type: string): Promise<string> {
    let blob: Blob | null = null;
    const link = { click: () => undefined, remove: () => undefined } as unknown as HTMLAnchorElement;
    const doc = {
      createElement: () => link,
      body: { append: () => undefined },
    } as unknown as Document;
    vi.stubGlobal('URL', {
      createObjectURL: (b: Blob) => ((blob = b), 'blob:x'),
      revokeObjectURL: () => undefined,
    });
    try {
      expect(saveText(doc, 'f', 'a;b', type)).toBe(true);
    } finally {
      vi.unstubAllGlobals();
    }
    return new TextDecoder('utf-8', { ignoreBOM: true }).decode(await (blob as unknown as Blob).arrayBuffer());
  }

  it('starts a CSV with a byte order mark and a Markdown file without', async () => {
    expect(await saved('text/csv;charset=utf-8')).toBe('\ufeffa;b');
    expect(await saved('text/markdown;charset=utf-8')).toBe('a;b');
  });

  it('starts a JSON file without one', async () => {
    expect(await saved(EXPORT_FILES.json.type)).toBe('a;b');
  });
});

describe('the rows of a view', () => {
  const rows = [
    { task: task('a/one', { title: 'One', status: 'doing', prio: 1, tags: ['x'] }), group: 'doing' },
    { task: task('a/two', { title: 'Two', status: 'open' }), group: 'open' },
    { task: task('a/three', { title: 'Three', status: 'open' }), group: 'open' },
  ];

  it('put the group in a first column of the CSV, only when the view has groups', () => {
    const lines = rowsToCsv(rows, ';').trimEnd().split('\r\n');
    expect(lines[0]).toBe('group;id;title;status;actor;kind;prio;effort;value;severity;plan;phase;tags;updated');
    expect(lines[1]).toBe('doing;a/one;One;doing;;;1;;;;;;x;');
    expect(lines.slice(2).map((l) => l.split(';').slice(0, 2).join(' '))).toEqual(['open a/two', 'open a/three']);
    expect(rowsToCsv([{ task: rows[0]!.task }]).split('\r\n')[0]).toBe(
      'id,title,status,actor,kind,prio,effort,value,severity,plan,phase,tags,updated',
    );
  });

  it('keep a group a spreadsheet would run as a formula from running', () => {
    expect(rowsToCsv([{ task: task('a/one'), group: '=1+1' }]).split('\r\n')[1]!.startsWith("'=1+1,")).toBe(true);
  });

  it('are JSON with the format, the view and each task with its own types, a missing field left out', () => {
    const doc = JSON.parse(rowsToJson(rows, 'board')) as { format: string; view: string; tasks: Record<string, unknown>[] };
    expect(doc.format).toBe(JSON_FORMAT);
    expect(doc.view).toBe('board');
    expect(doc.tasks[0]).toEqual({ group: 'doing', id: 'a/one', title: 'One', status: 'doing', prio: 1, tags: ['x'] });
    expect(doc.tasks.map((x) => x['id'])).toEqual(['a/one', 'a/two', 'a/three']);
    // A list without groups has no group key at all.
    expect(Object.hasOwn((JSON.parse(rowsToJson([{ task: rows[1]!.task }], 'list')) as typeof doc).tasks[0]!, 'group')).toBe(false);
  });

  it('give each group of the Markdown a heading, in the order the groups come', () => {
    expect(rowsToMarkdown(rows)).toBe(
      '## doing\n\n- [ ] `a/one` One (doing, prio 1)\n\n## open\n\n- [ ] `a/two` Two (open)\n- [ ] `a/three` Three (open)\n',
    );
    // The group of no value has a heading too, and markup in a group's name is escaped.
    expect(rowsToMarkdown([{ task: task('a/one', { title: 'T' }), group: '' }, { task: task('a/two', { title: 'U' }), group: '*x*' }])).toBe(
      '## -\n\n- [ ] `a/one` T\n\n## \\*x\\*\n\n- [ ] `a/two` U\n',
    );
  });

  it('of a matrix carry the row in a column of its own, in every format', () => {
    const cells = [
      { task: task('a/one', { title: 'One' }), group: 'doing', row: 'ui' },
      { task: task('a/two', { title: 'Two' }), group: 'open', row: '=cmd' },
    ];
    const lines = rowsToCsv(cells).trimEnd().split('\r\n');
    expect(lines[0]!.startsWith('group,row,id,')).toBe(true);
    expect(lines[1]!.startsWith('doing,ui,a/one,')).toBe(true);
    // The row is a cell like the others: it does not run as a formula.
    expect(lines[2]!.startsWith("open,'=cmd,a/two,")).toBe(true);
    expect((JSON.parse(rowsToJson(cells, 'v')) as { tasks: Record<string, unknown>[] }).tasks[0]).toMatchObject({ group: 'doing', row: 'ui' });
    expect(rowsToMarkdown(cells)).toBe('## ui / doing\n\n- [ ] `a/one` One\n\n## =cmd / open\n\n- [ ] `a/two` Two\n');
  });

  it('are picked by the format', () => {
    expect(rowsText(rows, 'csv', ',', 'v')).toBe(rowsToCsv(rows, ','));
    expect(rowsText(rows, 'json', ',', 'v')).toBe(rowsToJson(rows, 'v'));
    expect(rowsText(rows, 'markdown', ',', 'v')).toBe(rowsToMarkdown(rows));
  });
});

describe('the page for the printer', () => {
  const cells = (t: { id: string; title: string }) => [t.id, t.title];

  it('is one table without groups, and a section for each group in the order they come', () => {
    expect(sheetOf([{ task: task('a/1', { title: 'One' }) }], 'T', ['f'], ['ID', 'Title'], cells)).toEqual({
      title: 'T',
      facts: ['f'],
      headers: ['ID', 'Title'],
      sections: [{ rows: [['a/1', 'One']] }],
    });
    const grouped = sheetOf(
      [
        { task: task('a/1', { title: 'One' }), group: 'doing' },
        { task: task('a/2', { title: 'Two' }), group: 'open' },
        { task: task('a/3', { title: 'Three' }), group: 'open' },
        { task: task('a/4', { title: 'Four' }), group: 'c', row: 'r' },
      ],
      'T',
      [],
      ['ID', 'Title'],
      cells,
    );
    expect(grouped.sections.map((s) => [s.heading, s.rows.map((r) => r[0])])).toEqual([
      ['doing', ['a/1']],
      ['open', ['a/2', 'a/3']],
      ['r / c', ['a/4']],
    ]);
  });

  /** A document with what printSheet uses: elements with text, children and attributes, and the class of the root. */
  function fakeDoc() {
    type El = { tag: string; id: string; scope?: string; textContent: string; children: El[]; removed: boolean; append(...c: El[]): void; remove(): void };
    const make = (tag: string): El => ({
      tag,
      id: '',
      textContent: '',
      children: [],
      removed: false,
      append(...c: El[]) {
        this.children.push(...c);
      },
      remove() {
        this.removed = true;
      },
    });
    const body = make('body');
    const classes = new Set<string>();
    const doc = {
      createElement: make,
      body,
      getElementById: (id: string) => body.children.find((c) => c.id === id && !c.removed) ?? null,
      documentElement: { classList: { add: (c: string) => classes.add(c), remove: (c: string) => classes.delete(c) } },
    };
    return { doc: doc as unknown as Document, body, classes };
  }

  it('stands in the document as text while the dialog is open, and goes after it', () => {
    const { doc, body, classes } = fakeDoc();
    let printed = 0;
    let after: (() => void) | undefined;
    const win = { print: () => void (printed += 1), addEventListener: (_: string, fn: () => void) => void (after = fn) };
    const sheet = sheetOf([{ task: task('a/1', { title: '<b>x</b>' }), group: 'g' }], 'Tasks', ['List · 2026-10-24'], ['ID', 'Title'], cells);
    expect(printSheet(doc, win as never, sheet)).toBe(true);
    expect(printed).toBe(1);
    expect(classes.has(VIEW_PRINT_CLASS)).toBe(true);
    const page = body.children[0]!;
    expect(page.id).toBe(VIEW_PRINT_ID);
    expect(page.children.map((c) => `${c.tag}:${c.textContent}`).slice(0, 3)).toEqual(['h1:Tasks', 'p:List · 2026-10-24', 'h2:g']);
    // The title is text in a cell, never markup.
    const table = page.children[3]!;
    expect(table.children[1]!.children[0]!.children[1]!.textContent).toBe('<b>x</b>');
    expect(table.children[0]!.children[0]!.children.map((th) => `${th.textContent}:${th.scope}`)).toEqual(['ID:col', 'Title:col']);
    after?.();
    expect(page.removed).toBe(true);
    expect(classes.has(VIEW_PRINT_CLASS)).toBe(false);
  });

  it('takes a page of the tile Today that was left (no afterprint) away with its class, and the other way round', () => {
    const { doc, body, classes } = fakeDoc();
    const left = doc.createElement('div');
    left.id = 'daily-print';
    body.append(left as never);
    classes.add('print-daily');
    const win = { print: () => undefined, addEventListener: () => undefined };
    printSheet(doc, win as never, sheetOf([{ task: task('a/1') }], 'T', [], ['ID'], (t) => [t.id]));
    expect((left as unknown as { removed: boolean }).removed).toBe(true);
    expect(classes.has('print-daily')).toBe(false);
    expect(classes.has(VIEW_PRINT_CLASS)).toBe(true);
    // The tile's print takes the view's page away in turn.
    printDaily(doc, win as never, 'Week', 'x', []);
    expect(body.children.find((c) => c.id === VIEW_PRINT_ID)!.removed).toBe(true);
    expect(classes.has(VIEW_PRINT_CLASS)).toBe(false);
    expect(classes.has('print-daily')).toBe(true);
  });

  it('takes the page of a print before away, and says false when the page could not be made', () => {
    const { doc, body } = fakeDoc();
    const win = { print: () => undefined, addEventListener: () => undefined };
    const sheet = sheetOf([{ task: task('a/1') }], 'T', [], ['ID'], (t) => [t.id]);
    printSheet(doc, win as never, sheet);
    printSheet(doc, win as never, sheet);
    expect(body.children.filter((c) => !c.removed)).toHaveLength(1);
    expect(printSheet({} as Document, win as never, sheet)).toBe(false);
  });
});

describe('the name of the file', () => {
  it('names the view and the day, with the ending of the format', () => {
    expect(exportFileName('board', '2026-10-24', 'csv')).toBe('tasks-board-2026-10-24.csv');
    expect(exportFileName('plan-p1', '2026-10-24', 'json')).toBe('tasks-plan-p1-2026-10-24.json');
    expect(exportFileName('list', '2026-10-24', 'markdown')).toBe('tasks-list-2026-10-24.md');
  });

  it('keeps the name of a view to safe letters', () => {
    expect(exportFileName('view-../../Evil Name?', '2026-10-24', 'csv')).toBe('tasks-view-..-..-evil-name-2026-10-24.csv');
    expect(exportFileName('///', '2026-10-24', 'csv')).toBe('tasks-list-2026-10-24.csv');
  });
});
