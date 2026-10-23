import { describe, expect, it } from 'vitest';
import {
  COLUMN_LIMITS,
  clampWidth,
  columnStyle,
  defaultColumns,
  draggedWidth,
  parseColumns,
  serializeColumns,
  withWidth,
} from './columns';

describe('the widths of the columns of the list', () => {
  it('start at the default, which sets no width', () => {
    expect(defaultColumns()).toEqual({ id: null, meta: null });
    expect(columnStyle(defaultColumns())).toBe('');
  });

  it('give the row a variable per column that has a width', () => {
    expect(columnStyle({ id: 200, meta: null })).toBe('--col-id: 200px');
    expect(columnStyle({ id: 200, meta: 96 })).toBe('--col-id: 200px; --col-meta: 96px');
  });

  it('stay between the narrowest and the widest', () => {
    expect(clampWidth('id', 1)).toBe(COLUMN_LIMITS.id.min);
    expect(clampWidth('meta', 99_999)).toBe(COLUMN_LIMITS.meta.max);
    expect(withWidth(defaultColumns(), 'id', 10).id).toBe(COLUMN_LIMITS.id.min);
    expect(withWidth({ id: 200, meta: 96 }, 'id', null)).toEqual({ id: null, meta: 96 });
  });

  it('follow a drag: the id widens to the right, the marks widen to the left', () => {
    expect(draggedWidth('id', 200, 40)).toBe(240);
    expect(draggedWidth('id', 200, -40)).toBe(160);
    expect(draggedWidth('meta', 120, -40)).toBe(160);
    expect(draggedWidth('meta', 120, 40)).toBe(80);
  });

  it('are remembered, and a damaged memory gives the default for what it cannot read', () => {
    expect(parseColumns(serializeColumns({ id: 210, meta: 90 }))).toEqual({ id: 210, meta: 90 });
    expect(parseColumns('not json')).toEqual(defaultColumns());
    expect(parseColumns(null)).toEqual(defaultColumns());
    expect(parseColumns(JSON.stringify({ id: 'wide', meta: 5 }))).toEqual({ id: null, meta: COLUMN_LIMITS.meta.min });
  });
});
