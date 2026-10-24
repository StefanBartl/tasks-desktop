// Saved views: a way to look at the tasks (which ones, grouped by which field, drawn how), kept in the vault as a file
// of its own so it is the same on every machine (`tasks.views`, `view_save`, `view_delete`). The engine judges a view
// and its version; this file only turns a view into what the page needs (its selection as a filter of the list) and the
// person's changes into the operations the engine takes.

import type { Op } from './api';
import type { GroupField, View, ViewSelect } from './contract';
import { emptyFilter, type Filter } from './filter';

/** What a `view_save` carries: the view without what its file adds (the id, the version, the dates). */
export interface ViewForm {
  title: string;
  display: View['display'];
  group_by: GroupField;
  group_by2?: GroupField;
  collapsed?: string[];
  select?: ViewSelect;
}

/** How a view can be drawn, in the order the page offers them. */
export const DISPLAYS: readonly View['display'][] = ['columns', 'list', 'matrix'];

/** The longest title the engine takes, in characters. */
export const TITLE_MAX = 300;

/** A selection that narrows nothing: every open task. */
export function emptySelect(): ViewSelect {
  return { areas: [], statuses: [], actors: [], kinds: [], tags: [], plans: [] };
}

/** The lists of a selection, in the order the form shows them; the text search is the last. */
export type SelectKey = 'areas' | 'statuses' | 'actors' | 'kinds' | 'tags' | 'plans' | 'query';

/**
 * What a selection holds, as the parts that narrow something: a list that is empty narrows nothing and is left out, a
 * text that is blank too. No part at all means every open task.
 */
export function selectParts(select: ViewSelect): { key: SelectKey; values: string[] }[] {
  const lists = ['areas', 'statuses', 'actors', 'kinds', 'tags', 'plans'] as const;
  const parts: { key: SelectKey; values: string[] }[] = [];
  for (const key of lists) if (select[key].length > 0) parts.push({ key, values: [...select[key]] });
  const query = select.query?.trim();
  if (query) parts.push({ key: 'query', values: [query] });
  return parts;
}

/** The title as the engine takes it (one line, trimmed, at most `TITLE_MAX` characters), or null when it is empty. */
export function cleanTitle(title: string): string | null {
  const line = title.replace(/\s*[\r\n\t]+\s*/g, ' ').trim();
  if (line === '') return null;
  return [...line].slice(0, TITLE_MAX).join('');
}

/** The view as a `view_save` carries it back. */
export function formOf(view: View): ViewForm {
  return {
    title: view.title,
    display: view.display,
    group_by: view.group_by,
    ...(view.group_by2 !== undefined ? { group_by2: view.group_by2 } : {}),
    collapsed: [...view.collapsed],
    select: { ...view.select },
  };
}

/**
 * The selection of a view as a filter of the list, so the tasks it shows are found the way the list finds them (no second
 * rule): areas, statuses and actors as they are, kinds, tags and plans as the fields of the filter, the words of the query.
 */
export function filterOfSelect(select: ViewSelect): Filter {
  const fields: Filter['fields'] = {};
  if (select.kinds.length > 0) fields.kind = [...select.kinds];
  if (select.tags.length > 0) fields.tag = [...select.tags];
  if (select.plans.length > 0) fields.plan = [...select.plans];
  return {
    ...emptyFilter,
    areas: [...select.areas],
    statuses: [...select.statuses],
    actors: [...select.actors],
    query: select.query ?? '',
    fields,
  };
}

/**
 * The part of a filter a view can keep. "Not written" (`none`) has no word in a view and is left out, as is what a view
 * does not hold (ranges, dates, reminders, the other fields): `dropped` says whether anything was.
 */
export function selectOfFilter(filter: Filter): { select: ViewSelect; dropped: boolean } {
  let dropped = false;
  const keep = (list: readonly string[] | undefined): string[] => {
    const out = (list ?? []).filter((v) => v !== 'none');
    if (out.length !== (list ?? []).length) dropped = true;
    return out;
  };
  const select: ViewSelect = {
    areas: keep(filter.areas),
    statuses: keep(filter.statuses),
    actors: keep(filter.actors),
    kinds: keep(filter.fields.kind),
    tags: keep(filter.fields.tag),
    plans: keep(filter.fields.plan),
  };
  const query = filter.query.trim();
  if (query !== '') select.query = query;
  const kept = new Set(['kind', 'tag', 'plan']);
  for (const [key, values] of Object.entries(filter.fields)) {
    if (!kept.has(key) && (values?.length ?? 0) > 0) dropped = true;
  }
  // A view selects a task by any of its tags; "all of these tags" has no place in it.
  if (filter.matchAll.includes('tag') && select.tags.length > 1) dropped = true;
  if (
    Object.keys(filter.ranges).length > 0 ||
    Object.keys(filter.dates).length > 0 ||
    filter.updated !== '' ||
    filter.reminder !== '' ||
    filter.cross ||
    filter.quickWin
  ) {
    dropped = true;
  }
  return { select, dropped };
}

/** A new view in `area` (the engine names the file after the title). */
export function createOp(area: string, form: ViewForm): Op {
  return { op: 'view_save', area, view: form };
}

/** `view` changed to `form`, on the version that was read. */
export function saveOp(view: View, form: ViewForm): Op {
  return { op: 'view_save', id: view.id, view: form, if_match: view.etag };
}

/** `view` deleted, on the version that was read. */
export function deleteOp(view: View): Op {
  return { op: 'view_delete', id: view.id, if_match: view.etag };
}

/** The group `value` folded when it is open and open when it is folded. */
export function toggledGroup(collapsed: readonly string[], value: string): string[] {
  return collapsed.includes(value) ? collapsed.filter((v) => v !== value) : [...collapsed, value];
}
