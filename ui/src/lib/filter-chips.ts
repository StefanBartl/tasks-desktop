// The words of the filter: what a value is called and what the chip of a switched-on filter says.

import { areaLabel, DATE_KEYS, NONE, RANGE_KEYS, type ActiveFilter, type DateKey, type Filter, type FieldKey, type RangeKey } from './filter';
import { labelOf, translate, type Key, type Lang } from './i18n';
import { markHidden } from './text';

/** A value of a field as it is shown. For the state of the plan `none` is a task the plan has not placed; for the others it is "not written". */
export function valueLabel(lang: Lang, key: FieldKey, value: string): string {
  if (value === NONE) return translate(lang, key === 'state' ? 'filter.unplaced' : 'filter.none');
  if (key === 'prio') return `P${value}`;
  if (key === 'state') return labelOf(lang, 'state', value);
  return markHidden(value);
}

/** One end of a range as it is shown (a priority as `P2`). */
export const boundLabel = (key: RangeKey, label: string): string => (key === 'prio' ? `P${label}` : label);

export const isRangeKey = (v: string): v is RangeKey => (RANGE_KEYS as readonly string[]).includes(v);
export const isDateKey = (v: string): v is DateKey => (DATE_KEYS as readonly string[]).includes(v);

/** The chip of a switched-on filter. */
export function chipLabel(
  lang: Lang,
  filter: Filter,
  item: ActiveFilter,
  areas: { short: boolean; all: readonly string[] },
): string {
  const t = (key: Key, params: Record<string, string | number> = {}) => translate(lang, key, params);
  switch (item.kind) {
    case 'area':
      return `${t('nav.areas')}: ${areas.short ? areaLabel(item.value, areas.all) : item.value}`;
    case 'status':
      return `${t('list.filter.status')}: ${t(`status.${item.value}` as Key)}`;
    case 'actor':
      return `${t('list.filter.actor')}: ${t(`actor.${item.value}` as Key)}`;
    case 'updated':
      return `${t('filter.updated')}: ${t(`filter.updated.${item.value}` as Key)}`;
    case 'reminder':
      return `${t('filter.reminder')}: ${t(`filter.reminder.${item.value}` as Key)}`;
    case 'cross':
      return t('filter.cross.on');
    case 'quickWin':
      return t('filter.quick_win.on');
    case 'range': {
      const key = item.value as RangeKey;
      const r = filter.ranges[key];
      const field = t(`filter.field.${key}` as Key);
      const a = r?.min ? boundLabel(key, r.min.label) : '';
      const b = r?.max ? boundLabel(key, r.max.label) : '';
      return t(a && b ? 'filter.chip.span' : a ? 'filter.chip.min' : 'filter.chip.max', { field, a, b });
    }
    case 'date': {
      const key = item.value as DateKey;
      const d = filter.dates[key];
      const field = t(`filter.date.${key}` as Key);
      const a = d?.from ?? '';
      const b = d?.to ?? '';
      return t(a && b ? 'filter.chip.span' : a ? 'filter.chip.from' : 'filter.chip.until', { field, a, b });
    }
    default:
      return `${t(`filter.field.${item.kind}` as Key)}: ${valueLabel(lang, item.kind, item.value)}`;
  }
}
