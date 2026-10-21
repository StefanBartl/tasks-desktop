// The entries of the context menu "open as a view": the same selection (an area, a plan, a group of a view) shown as
// columns or as a list, or grouped by another field. Which fields there are is the engine's (`tasks.groupings`); this
// only lays them out as entries and hands the chosen view on.

import type { MenuItem } from 'appkit-ui/menu';
import type { GroupField, ViewSelect } from './contract';
import { emptySelect, type ViewForm } from './views';

export interface ViewMenuWords {
  /** The heading of the entries that open the selection as it is. */
  open: string;
  columns: string;
  list: string;
  /** The heading of the entries that group the selection by a field. */
  groupBy: string;
  field: (field: GroupField) => string;
}

/** The field a view of the menu is grouped by unless the person chose one: status where the engine has it. */
function firstField(fields: readonly GroupField[]): GroupField | undefined {
  return fields.includes('status') ? 'status' : fields[0];
}

/**
 * The entries for `select`, named `title`: open it as columns or as a list (by the first field), or as columns grouped
 * by each field the engine names. Without a field there is nothing to group by, and no entry.
 */
export function viewMenuItems(
  title: string,
  select: ViewSelect,
  fields: readonly GroupField[],
  words: ViewMenuWords,
  open: (form: ViewForm) => void,
): MenuItem[] {
  const first = firstField(fields);
  if (first === undefined) return [];
  const form = (display: ViewForm['display'], group_by: GroupField): ViewForm => ({
    title,
    display,
    group_by,
    collapsed: [],
    select: { ...emptySelect(), ...select },
  });
  return [
    { kind: 'section', label: words.open },
    { kind: 'action', label: words.columns, onselect: () => open(form('columns', first)) },
    { kind: 'action', label: words.list, onselect: () => open(form('list', first)) },
    { kind: 'section', label: words.groupBy },
    ...fields.map((field): MenuItem => ({ kind: 'action', label: words.field(field), onselect: () => open(form('columns', field)) })),
  ];
}

/**
 * The selection of a group of a view: the selection of the view, narrowed to the value of the group - where a view can
 * hold that narrowing (status, who, kind, tags, plan, area). Null for a field it cannot (priority, effort, value,
 * phase, readiness) and for the group of the tasks that have none.
 */
export function selectOfGroup(select: ViewSelect, field: GroupField, value: string): ViewSelect | null {
  if (value === '') return null;
  const key = SELECT_OF_FIELD[field];
  if (key === undefined) return null;
  return { ...select, [key]: [value] };
}

/** The list of a selection that narrows by the value of a field. */
const SELECT_OF_FIELD: Partial<Record<GroupField, 'statuses' | 'actors' | 'kinds' | 'tags' | 'plans' | 'areas'>> = {
  status: 'statuses',
  actor: 'actors',
  kind: 'kinds',
  tags: 'tags',
  plan: 'plans',
  area: 'areas',
};
