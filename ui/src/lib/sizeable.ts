// A block whose size the person can drag. The block takes the size it was given; while it is being sized it shows the
// browser's own grip in its lower right corner (CSS `resize`), and the size it has when the mouse is let go is
// handed back to be remembered. A block that was never sized keeps the size of the layout.

import { sizeChanged, type Size } from './sizes';

export interface SizeableParams {
  /** The size the person gave the block, or `null` for the size of the layout. */
  size: Size | null;
  /** Whether the grip is shown. */
  active: boolean;
  /** The size the block has after a drag of the grip. */
  onsize: (size: Size) => void;
}

export function sizeable(node: HTMLElement, params: SizeableParams) {
  let current = params;
  let start: Size | null = null;

  const measure = (): Size => {
    const r = node.getBoundingClientRect();
    return { w: r.width, h: r.height };
  };

  function apply(): void {
    const { size, active } = current;
    node.style.width = size ? `${size.w}px` : '';
    node.style.height = size ? `${size.h}px` : '';
    node.style.resize = active ? 'both' : '';
    // `resize` works only on a box that does not show its overflow; a sized block scrolls what does not fit.
    node.style.overflow = active || size ? 'auto' : '';
    node.classList.toggle('sizing', active);
  }

  // The grip is the browser's: its drag starts with a press in the block and ends with the release, anywhere.
  function down(): void {
    if (current.active) start = measure();
  }
  function up(): void {
    if (start === null) return;
    const end = measure();
    const was = start;
    start = null;
    if (sizeChanged(was, end)) current.onsize(end);
  }

  apply();
  node.addEventListener('pointerdown', down);
  window.addEventListener('pointerup', up);
  return {
    update(next: SizeableParams): void {
      current = next;
      apply();
    },
    destroy(): void {
      node.removeEventListener('pointerdown', down);
      window.removeEventListener('pointerup', up);
    },
  };
}
