// The ways out of the page for an export: a file the browser saves, or the clipboard.

const BOM = '\ufeff';

export function saveText(doc: Document, name: string, text: string, type: string): boolean {
  try {
    // A byte order mark lets a spreadsheet read the umlauts of a CSV as UTF-8.
    const blob = new Blob([BOM, text], { type });
    const url = URL.createObjectURL(blob);
    const link = doc.createElement('a');
    link.href = url;
    link.download = name;
    doc.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 0);
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
