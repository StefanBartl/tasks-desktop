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

/** The grip of a row: follows its own pointer from `start` to `end` and tells `sink` about it. */
export function createGrip(
  sink: () => ((event: PointerDragEvent) => void) | undefined,
  blocked: () => boolean,
): (e: PointerEvent, id: string, phase: PointerDragEvent['phase']) => void {
  // The row whose grip a finger holds: the pointer is followed on the grip (captured), wherever it goes.
  let gripped: string | null = null;
  return (e, id, phase) => {
    const on = sink();
    if (!on) return;
    if (phase === 'start') {
      if (!startsOnGrip(e.pointerType) || blocked()) return;
      e.preventDefault();
      try {
        (e.currentTarget as Element).setPointerCapture(e.pointerId);
      } catch {
        // A pointer that is gone cannot be captured; the events then stay on whatever is under the finger.
      }
      gripped = id;
    } else if (gripped !== id) {
      return;
    }
    if (phase === 'end' || phase === 'cancel') gripped = null;
    on({ phase, id, x: e.clientX, y: e.clientY });
  };
}

/** What a point of the board is over. */
export type BoardTarget =
  | { kind: 'card'; id: string; column: string; top: number; height: number }
  | { kind: 'column'; column: string }
  | { kind: 'done' };

/** The card, the column or the strip for finishing that the point is on (a card carries `data-card` and `data-card-column`). */
export function boardTargetAt(doc: PointSource, x: number, y: number): BoardTarget | null {
  const el = doc.elementFromPoint(x, y);
  if (!el) return null;
  const card = el.closest('[data-card]');
  const id = card?.getAttribute('data-card');
  const cardColumn = card?.getAttribute('data-card-column');
  if (card && id && cardColumn) {
    const rect = card.getBoundingClientRect();
    return { kind: 'card', id, column: cardColumn, top: rect.top, height: rect.height };
  }
  if (el.closest('[data-donezone]')) return { kind: 'done' };
  const column = el.closest('[data-column]')?.getAttribute('data-column');
  return column ? { kind: 'column', column } : null;
}
