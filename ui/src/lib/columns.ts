// The widths of the columns of the list. The id and the marks on the right can be dragged to a width; the title
// takes what is left. A column that was never dragged has no width here and takes the width the row gives it by
// default (the marks as wide as they are, the title the rest).

export const COLUMN_KEYS = ['id', 'meta'] as const;
export type ColumnKey = (typeof COLUMN_KEYS)[number];

/** A width in pixels per column, or `null` for the default. */
export type ListColumns = Record<ColumnKey, number | null>;

/** The narrowest and widest a column may be dragged to, in pixels. */
export const COLUMN_LIMITS: Record<ColumnKey, { min: number; max: number }> = {
  id: { min: 64, max: 640 },
  meta: { min: 48, max: 480 },
};

/** How far one press of an arrow key moves the edge of a column. */
export const COLUMN_STEP = 16;

export const defaultColumns = (): ListColumns => ({ id: null, meta: null });

export function clampWidth(key: ColumnKey, px: number): number {
  const { min, max } = COLUMN_LIMITS[key];
  return Math.round(Math.min(max, Math.max(min, px)));
}

/** The columns with one width set (clamped), or set back to the default with `null`. */
export function withWidth(columns: ListColumns, key: ColumnKey, px: number | null): ListColumns {
  return { ...columns, [key]: px === null ? null : clampWidth(key, px) };
}

export function serializeColumns(columns: ListColumns): string {
  return JSON.stringify(columns);
}

/** The remembered widths; a damaged memory, or a width that is no number, gives the default for that column. */
export function parseColumns(text: string | null): ListColumns {
  const out = defaultColumns();
  let raw: unknown;
  try {
    raw = text ? JSON.parse(text) : null;
  } catch {
    return out;
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return out;
  for (const key of COLUMN_KEYS) {
    const v = (raw as Record<string, unknown>)[key];
    if (typeof v === 'number' && Number.isFinite(v)) out[key] = clampWidth(key, v);
  }
  return out;
}

/** The CSS variables a row reads its columns from; a default column sets none. */
export function columnStyle(columns: ListColumns): string {
  return COLUMN_KEYS.filter((key) => columns[key] !== null)
    .map((key) => `--col-${key}: ${columns[key]}px`)
    .join('; ');
}

/**
 * The width a column gets when its edge is dragged by `dx` pixels from where it was (`start`). The edge of the id is
 * on its right, so a drag to the right widens it; the edge of the marks is on their left, so a drag to the right
 * narrows them.
 */
export function draggedWidth(key: ColumnKey, start: number, dx: number): number {
  return clampWidth(key, key === 'id' ? start + dx : start - dx);
}
