// Dragging a row with a finger: HTML5 drag does not start on a touch screen, so the grip of a row follows its own
// pointer (touch or pen) and the places to drop on are found by the point the finger is on.

/** What the grip of a row tells the panel. */
export interface PointerDragEvent {
  phase: 'start' | 'move' | 'end' | 'cancel';
  /** The task whose row is dragged. */
  id: string;
  x: number;
  y: number;
}

/** The part of a document the lookup needs (the real one has more). */
export interface PointSource {
  elementFromPoint(x: number, y: number): Element | null;
}

/** The area whose place to drop is under the point, if any (a place carries `data-area`). */
export function areaAt(doc: PointSource, x: number, y: number): string | null {
  const place = doc.elementFromPoint(x, y)?.closest('[data-area]');
  const area = place?.getAttribute('data-area');
  return area === undefined || area === null || area === '' ? null : area;
}

/** A finger or a pen starts a drag by the grip; the mouse has the HTML5 drag of the row. */
export function startsOnGrip(pointerType: string): boolean {
  return pointerType === 'touch' || pointerType === 'pen';
}
