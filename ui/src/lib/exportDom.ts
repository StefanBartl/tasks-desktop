// The ways out of the page for an export: a file the browser saves, the clipboard, or the page for the printer.

import type { PrintSheet } from './export';

const BOM = '\ufeff';

/** The id of the page for the printer: while it stands, the print rules (app.css) hide everything else. */
export const VIEW_PRINT_ID = 'view-print';
/** The class on the root while that page stands. */
export const VIEW_PRINT_CLASS = 'print-view';

/**
 * Put the sheet into the document as a page of its own and open the print dialog; the page goes when the dialog is
 * done (`afterprint`). Text only, set with `textContent`: a title is never read as markup.
 */
export function printSheet(doc: Document, win: Pick<Window, 'print' | 'addEventListener'>, sheet: PrintSheet): boolean {
  try {
    doc.getElementById(VIEW_PRINT_ID)?.remove();
    const page = doc.createElement('div');
    page.id = VIEW_PRINT_ID;
    const text = <K extends keyof HTMLElementTagNameMap>(tag: K, value: string): HTMLElementTagNameMap[K] => {
      const el = doc.createElement(tag);
      el.textContent = value;
      return el;
    };
    page.append(text('h1', sheet.title));
    for (const fact of sheet.facts) page.append(text('p', fact));
    for (const section of sheet.sections) {
      if (section.heading !== undefined) page.append(text('h2', section.heading));
      const table = doc.createElement('table');
      const head = doc.createElement('thead');
      const headRow = doc.createElement('tr');
      for (const h of sheet.headers) {
        const th = text('th', h);
        th.scope = 'col';
        headRow.append(th);
      }
      head.append(headRow);
      const body = doc.createElement('tbody');
      for (const row of section.rows) {
        const tr = doc.createElement('tr');
        for (const cell of row) tr.append(text('td', cell));
        body.append(tr);
      }
      table.append(head, body);
      page.append(table);
    }
    doc.body.append(page);
    doc.documentElement.classList.add(VIEW_PRINT_CLASS);
    win.addEventListener(
      'afterprint',
      () => {
        page.remove();
        doc.documentElement.classList.remove(VIEW_PRINT_CLASS);
      },
      { once: true },
    );
    win.print();
    return true;
  } catch {
    return false;
  }
}

export function saveText(doc: Document, name: string, text: string, type: string): boolean {
  try {
    // A byte order mark lets a spreadsheet read the umlauts of a CSV as UTF-8; a Markdown file has none.
    const blob = new Blob(type.startsWith('text/csv') ? [BOM, text] : [text], { type });
    const url = URL.createObjectURL(blob);
    const link = doc.createElement('a');
    link.href = url;
    link.download = name;
    doc.body.append(link);
    link.click();
    link.remove();
    // Not at once: an engine may still be reading the blob when the click returns.
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
    return true;
  } catch {
    return false;
  }
}

/** The other way out: the text on the clipboard (the policy of the page lets it write, never read). */
export async function copyText(clipboard: Pick<Clipboard, 'writeText'> | undefined, text: string): Promise<boolean> {
  if (clipboard === undefined) return false;
  try {
    await clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}
