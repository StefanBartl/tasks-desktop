import { describe, expect, it } from 'vitest';
import { drawDaily, imageSize, PRINT_ID, printDaily } from './dailyExport';

const colors = { background: 'white', text: 'black', muted: 'gray' };

describe('the image', () => {
  it('is as tall as its rows, and has at least one', () => {
    expect(imageSize(3).height).toBeGreaterThan(imageSize(1).height);
    expect(imageSize(0)).toEqual(imageSize(1));
  });

  it('writes the title, the days and every row (the word left, the number right) over the background', () => {
    const calls: [string, unknown, unknown?][] = [];
    const ctx = {
      font: '',
      textBaseline: 'alphabetic',
      textAlign: 'left',
      fillStyle: '' as string | CanvasGradient | CanvasPattern,
      fillRect: (...a: number[]) => void calls.push(['rect', a]),
      fillText: function (this: { textAlign: string }, text: string, x: number) {
        calls.push(['text', text, `${this.textAlign}:${x}`]);
      },
    };
    drawDaily(ctx as never, colors, 'Today', '2026-10-20', [
      { label: 'finished', value: '3' },
      { label: 'new', value: '≥ 12' },
    ]);
    expect(calls[0]).toEqual(['rect', [0, 0, 520, imageSize(2).height]]);
    const texts = calls.filter((c) => c[0] === 'text').map((c) => c[1]);
    expect(texts).toEqual(['Today', '2026-10-20', 'finished', '3', 'new', '≥ 12']);
    // The numbers stand at the right edge, the words at the left.
    expect(calls.filter((c) => c[0] === 'text').map((c) => c[2])).toEqual(['left:24', 'left:24', 'left:24', 'right:496', 'left:24', 'right:496']);
  });
});

/** The few calls printDaily makes, on plain objects (the tests run without a DOM). */
function fakeDocument() {
  const make = (tag: string) => {
    const el: { tag: string; children: unknown[]; textContent: string; id: string; scope?: string; append: (...c: unknown[]) => void; remove: () => void; removed: boolean } = {
      tag,
      children: [],
      textContent: '',
      id: '',
      removed: false,
      append: (...c) => void el.children.push(...c),
      remove: () => void (el.removed = true),
    };
    return el;
  };
  const classes = new Set<string>();
  const body = make('body');
  const doc = {
    createElement: make,
    body,
    documentElement: { classList: { add: (c: string) => classes.add(c), remove: (c: string) => classes.delete(c) } },
  };
  return { doc: doc as unknown as Document, classes, body };
}

describe('the page for the printer', () => {
  it('stands in the document while the dialog is open, hides the rest by a class, and goes after it', () => {
    const { doc, classes, body } = fakeDocument();
    let printed = 0;
    let after: (() => void) | undefined;
    const win = { print: () => void (printed += 1), addEventListener: (_: string, fn: () => void) => void (after = fn) };
    printDaily(doc, win as never, 'Week', '2026-10-19 – 2026-10-25', [{ label: 'finished', value: '5' }]);
    expect(printed).toBe(1);
    expect(classes.has('print-daily')).toBe(true);
    const page = body.children[0] as { id: string; removed: boolean; children: { textContent: string }[] };
    expect(page.id).toBe(PRINT_ID);
    expect(page.children[0]?.textContent).toBe('Week');
    expect(page.children[1]?.textContent).toBe('2026-10-19 – 2026-10-25');
    after?.();
    expect(classes.has('print-daily')).toBe(false);
    expect(page.removed).toBe(true);
  });
});
