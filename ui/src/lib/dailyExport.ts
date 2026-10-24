// The ways out of the tile Today: an image (PNG, drawn on a canvas) and a page for the printer or a PDF. Both take the
// same rows (a word and a number each), so what leaves the page is what the tile shows.

import { clearPrintPages } from './exportDom';

export interface DailyRow {
  label: string;
  value: string;
}

export interface DailyColors {
  background: string;
  text: string;
  muted: string;
}

const PAD = 24;
const WIDTH = 520;
const ROW = 34;
const HEAD = 70;

/** The size of the image for this many rows. */
export function imageSize(rows: number): { width: number; height: number } {
  return { width: WIDTH, height: HEAD + PAD + Math.max(1, rows) * ROW };
}

type Surface = Pick<CanvasRenderingContext2D, 'fillRect' | 'fillText' | 'font' | 'fillStyle' | 'textBaseline' | 'textAlign'>;

/** Draw the tile on a surface: the title, the days, then one row per evaluation (the word left, the number right). */
export function drawDaily(ctx: Surface, colors: DailyColors, title: string, range: string, rows: readonly DailyRow[]): void {
  const { width, height } = imageSize(rows.length);
  ctx.fillStyle = colors.background;
  ctx.fillRect(0, 0, width, height);
  ctx.textBaseline = 'alphabetic';
  ctx.textAlign = 'left';
  ctx.fillStyle = colors.text;
  ctx.font = '600 22px system-ui, sans-serif';
  ctx.fillText(title, PAD, PAD + 18);
  ctx.fillStyle = colors.muted;
  ctx.font = '14px system-ui, sans-serif';
  ctx.fillText(range, PAD, PAD + 42);
  rows.forEach((row, i) => {
    const y = HEAD + PAD + i * ROW;
    ctx.textAlign = 'left';
    ctx.fillStyle = colors.muted;
    ctx.font = '15px system-ui, sans-serif';
    ctx.fillText(row.label, PAD, y);
    ctx.textAlign = 'right';
    ctx.fillStyle = colors.text;
    ctx.font = '600 20px system-ui, sans-serif';
    ctx.fillText(row.value, width - PAD, y);
  });
}

/** The tile as a PNG, or `null` when the browser cannot draw one. */
export function dailyPng(doc: Document, colors: DailyColors, title: string, range: string, rows: readonly DailyRow[]): Promise<Blob | null> {
  return new Promise((resolve) => {
    try {
      const canvas = doc.createElement('canvas');
      const { width, height } = imageSize(rows.length);
      canvas.width = width * 2;
      canvas.height = height * 2;
      const ctx = canvas.getContext('2d');
      if (!ctx) return resolve(null);
      ctx.scale(2, 2);
      drawDaily(ctx, colors, title, range, rows);
      canvas.toBlob((blob) => resolve(blob), 'image/png');
    } catch {
      resolve(null);
    }
  });
}

/** Have the browser save a blob as a file. */
export function saveBlob(doc: Document, name: string, blob: Blob): boolean {
  try {
    const url = URL.createObjectURL(blob);
    const link = doc.createElement('a');
    link.href = url;
    link.download = name;
    doc.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
    return true;
  } catch {
    return false;
  }
}

/** The id of the page that is printed: everything else is hidden by the print rules while it stands. */
export const PRINT_ID = 'daily-print';

/**
 * A page of its own for the printer (or "Save as PDF" of the print dialog): the title, the days and the rows. It stands in
 * the document only while the dialog is open; the print rules of the page hide the rest of it.
 */
export function printDaily(doc: Document, win: Pick<Window, 'print' | 'addEventListener'>, title: string, range: string, rows: readonly DailyRow[]): void {
  clearPrintPages(doc);
  const page = doc.createElement('div');
  page.id = PRINT_ID;
  const h = doc.createElement('h1');
  h.textContent = title;
  const p = doc.createElement('p');
  p.textContent = range;
  const table = doc.createElement('table');
  for (const row of rows) {
    const tr = doc.createElement('tr');
    const th = doc.createElement('th');
    th.textContent = row.label;
    th.scope = 'row';
    const td = doc.createElement('td');
    td.textContent = row.value;
    tr.append(th, td);
    table.append(tr);
  }
  page.append(h, p, table);
  doc.body.append(page);
  doc.documentElement.classList.add('print-daily');
  const clean = (): void => {
    page.remove();
    doc.documentElement.classList.remove('print-daily');
  };
  win.addEventListener('afterprint', clean, { once: true });
  win.print();
}
