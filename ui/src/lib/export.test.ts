import { describe, expect, it, vi } from 'vitest';
import { copyText, saveText } from './exportDom';
import { csvCell, exportText, toCsv, toMarkdown } from './export';
import { task } from './fixtures';

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
});
