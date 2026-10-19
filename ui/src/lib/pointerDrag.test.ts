import { describe, expect, it } from 'vitest';
import { areaAt, startsOnGrip } from './pointerDrag';

/** An element that answers `closest` for the places to drop, as the document does. */
function place(area: string | null, inside = false): Element {
  const own = { getAttribute: (n: string) => (n === 'data-area' ? area : null) };
  return { closest: (sel: string) => (sel === '[data-area]' && (area !== null || inside) ? (area === null ? null : own) : null) } as unknown as Element;
}

describe('the place under a finger', () => {
  it('is the area of the place the point is on, or of the one it is inside', () => {
    const doc = { elementFromPoint: (x: number) => (x === 1 ? place('other') : x === 2 ? place(null) : null) };
    expect(areaAt(doc, 1, 0)).toBe('other');
    expect(areaAt(doc, 2, 0)).toBeNull();
    expect(areaAt(doc, 3, 0)).toBeNull();
  });

  it('is none for an empty name', () => {
    expect(areaAt({ elementFromPoint: () => place('') }, 0, 0)).toBeNull();
  });
});

describe('who drags by the grip', () => {
  it('is a finger or a pen, not the mouse', () => {
    expect(startsOnGrip('touch')).toBe(true);
    expect(startsOnGrip('pen')).toBe(true);
    expect(startsOnGrip('mouse')).toBe(false);
  });
});
