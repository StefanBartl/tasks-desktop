// A snippet and its marks as pieces to draw. The marks are positions in UTF-16
// code units, which is what a JavaScript string is indexed by.

export interface Piece {
  text: string;
  mark: boolean;
}

/** `text` cut at the marks. A mark that is out of range or backwards is left out. */
export function pieces(text: string, marks: readonly (readonly [number, number])[]): Piece[] {
  const out: Piece[] = [];
  let at = 0;
  const ordered = [...marks].sort((a, b) => a[0] - b[0]);
  for (const [start, end] of ordered) {
    if (!Number.isInteger(start) || !Number.isInteger(end)) continue;
    if (start < at || end <= start || end > text.length) continue;
    if (start > at) out.push({ text: text.slice(at, start), mark: false });
    out.push({ text: text.slice(start, end), mark: true });
    at = end;
  }
  if (at < text.length) out.push({ text: text.slice(at), mark: false });
  return out;
}
