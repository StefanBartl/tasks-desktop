import { describe, expect, it } from 'vitest';
import type { MenuItem } from 'appkit-ui/menu';
import type { GroupField } from './contract';
import { selectOfGroup, viewMenuItems } from './viewMenu';
import { emptySelect, type ViewForm } from './views';

const words = { open: 'Open', columns: 'Columns', list: 'List', groupBy: 'Group by', field: (f: GroupField) => `F:${f}` };
const labels = (items: MenuItem[]) => items.map((i) => (i.kind === 'section' || i.kind === 'action' ? `${i.kind}:${i.label}` : i.kind));

describe('the context menu "open as a view"', () => {
  it('opens the selection as columns or a list by status, or grouped by each field the engine names', () => {
    const opened: ViewForm[] = [];
    const items = viewMenuItems('pub', { areas: ['pub'] } as never, ['prio', 'status', 'tags'], words, (f) => opened.push(f));
    expect(labels(items)).toEqual(['section:Open', 'action:Columns', 'action:List', 'section:Group by', 'action:F:prio', 'action:F:status', 'action:F:tags']);
    for (const item of items) if (item.kind === 'action') item.onselect();
    expect(opened.map((f) => `${f.display}/${f.group_by}`)).toEqual(['columns/status', 'list/status', 'columns/prio', 'columns/status', 'columns/tags']);
    // Every one carries the selection, made whole, and the name.
    expect(opened[0]).toEqual({ title: 'pub', display: 'columns', group_by: 'status', collapsed: [], select: { ...emptySelect(), areas: ['pub'] } });
  });

  it('without status the first field of the engine, and without any field no entry at all', () => {
    const opened: ViewForm[] = [];
    const items = viewMenuItems('x', emptySelect(), ['kind', 'tags'], words, (f) => opened.push(f));
    const columns = items[1];
    if (columns?.kind === 'action') columns.onselect();
    expect(opened[0]?.group_by).toBe('kind');
    expect(viewMenuItems('x', emptySelect(), [], words, () => undefined)).toEqual([]);
  });

  it('narrows the selection of a view to a group where a view can hold that, and not elsewhere', () => {
    const base = { ...emptySelect(), areas: ['pub'] };
    expect(selectOfGroup(base, 'status', 'doing')).toEqual({ ...base, statuses: ['doing'] });
    expect(selectOfGroup(base, 'tags', 'ui')).toEqual({ ...base, tags: ['ui'] });
    expect(selectOfGroup(base, 'area', 'lib')).toEqual({ ...base, areas: ['lib'] });
    expect(selectOfGroup(base, 'actor', 'me')).toEqual({ ...base, actors: ['me'] });
    expect(selectOfGroup(base, 'prio', '1')).toBeNull();
    expect(selectOfGroup(base, 'state', 'ready')).toBeNull();
    // The group of the tasks that have none is no value to narrow by.
    expect(selectOfGroup(base, 'status', '')).toBeNull();
  });
});
