// The sizes the person gave the blocks of the page (the tiles of today, the list). A block that was never sized has
// no entry and takes the size the layout gives it.

export interface Size {
  w: number;
  h: number;
}
export type Sizes = Record<string, Size>;

/** The smallest a block may be made, in pixels: below that its head no longer fits. */
export const MIN_SIZE: Size = { w: 160, h: 80 };
/** The largest, so a slip of the mouse does not make a block wider than any screen. */
export const MAX_SIZE: Size = { w: 4000, h: 4000 };

export function clampSize(size: Size): Size {
  const clamp = (v: number, lo: number, hi: number) => Math.round(Math.min(hi, Math.max(lo, v)));
  return { w: clamp(size.w, MIN_SIZE.w, MAX_SIZE.w), h: clamp(size.h, MIN_SIZE.h, MAX_SIZE.h) };
}

/** The sizes with one block set (clamped), or given back to the layout with `null`. */
export function withSize(sizes: Sizes, key: string, size: Size | null): Sizes {
  const { [key]: _gone, ...rest } = sizes;
  return size === null ? rest : { ...rest, [key]: clampSize(size) };
}

export function serializeSizes(sizes: Sizes): string {
  return JSON.stringify(sizes);
}

/** The remembered sizes; an entry that is not two finite numbers is left out. */
export function parseSizes(text: string | null): Sizes {
  let raw: unknown;
  try {
    raw = text ? JSON.parse(text) : null;
  } catch {
    return {};
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return {};
  const out: Sizes = {};
  for (const [key, v] of Object.entries(raw)) {
    if (typeof v !== 'object' || v === null) continue;
    const { w, h } = v as Record<string, unknown>;
    if (typeof w === 'number' && typeof h === 'number' && Number.isFinite(w) && Number.isFinite(h)) {
      out[key] = clampSize({ w, h });
    }
  }
  return out;
}

/** Whether two sizes differ by more than the rounding of a pixel (a press without a drag changes nothing). */
export function sizeChanged(a: Size, b: Size): boolean {
  return Math.abs(a.w - b.w) > 1 || Math.abs(a.h - b.h) > 1;
}
