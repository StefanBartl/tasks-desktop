import { describe, expect, it } from 'vitest';
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
    for (const bad of ['=1+1', '+1', '-1', '@SUM(A1)']) expect(csvCell(bad).startsWith("'")).toBe(true);
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

describe('markdown', () => {
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
