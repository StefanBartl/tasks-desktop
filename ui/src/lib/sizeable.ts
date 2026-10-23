// A block whose size the person can drag. The block takes the size it was given; while it is being sized it shows the
// browser's own grip in its lower right corner (CSS `resize`), and the size it has when the mouse is let go is
// handed back to be remembered; the arrow keys on its size button do the same by keyboard. A block that was never
// sized keeps the size of the layout.

import { keyedSize, MIN_SIZE, sizeChanged, type Size } from './sizes';

export interface SizeableParams {
  /** The size the person gave the block, or `null` for the size of the layout. */
  size: Size | null;
  /** Whether the grip is shown. */
  active: boolean;
  /** The size the block has after a drag of the grip or a press of an arrow key. */
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
    // The grip stops where a remembered size would be clamped to, so the block does not jump when it is let go.
    node.style.minWidth = active ? `${MIN_SIZE.w}px` : '';
    node.style.minHeight = active ? `${MIN_SIZE.h}px` : '';
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

  // The keyboard: while the grip is shown, the arrow keys on the block's size button move its lower right corner.
  function key(event: KeyboardEvent): void {
    if (!current.active || !(event.target instanceof Element) || !event.target.closest('[data-size-toggle]')) return;
    const next = keyedSize(measure(), event.key);
    if (next === null) return;
    event.preventDefault();
    current.onsize(next);
  }

  apply();
  node.addEventListener('pointerdown', down);
  node.addEventListener('keydown', key);
  window.addEventListener('pointerup', up);
  return {
    update(next: SizeableParams): void {
      current = next;
      apply();
    },
    destroy(): void {
      node.removeEventListener('pointerdown', down);
      node.removeEventListener('keydown', key);
      window.removeEventListener('pointerup', up);
    },
  };
}
