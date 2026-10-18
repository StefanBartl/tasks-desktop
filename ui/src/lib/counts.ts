// The numbers of the overview (ready, doing, blocked, estimated) and the tasks behind each. A number is a button: it
// opens the tasks it counts, in a view that suits how many there are. Plain functions; the page only draws them.
//
// The UI never sorts: every list keeps the engine's order. A group is a way to cut that order up, and the groups are
// named in the order their first task has.

import type { TaskEntry } from './contract';

export const COUNT_KEYS = ['ready', 'doing', 'blocked', 'estimated'] as const;
export type CountKey = (typeof COUNT_KEYS)[number];

export const COUNT_VIEWS = ['list', 'prio', 'area', 'plan', 'blocker'] as const;
export type CountView = (typeof COUNT_VIEWS)[number];

/** The views a number offers, the first is the default. Only "blocked" can be cut up by what it waits on. */
export function viewsOf(key: CountKey): readonly CountView[] {
  return key === 'blocked'
    ? ['list', 'blocker', 'prio', 'area', 'plan']
    : ['list', 'prio', 'area', 'plan'];
}

/** The default view of a number. */
export function defaultView(key: CountKey): CountView {
  return viewsOf(key)[0] as CountView;
}

/** The view after `view`, wrapping round (the key `v` on a number walks through them). */
export function nextView(key: CountKey, view: CountView): CountView {
  const views = viewsOf(key);
  const at = views.indexOf(view);
  return views[(at + 1) % views.length] as CountView;
}

/** Is `view` one this number offers? (A stored choice may be from an older version.) */
export function viewAllowed(key: CountKey, view: unknown): view is CountView {
  return typeof view === 'string' && (viewsOf(key) as readonly string[]).includes(view);
}

/** The tasks a number counts, in the engine's order. */
export function tasksOf(key: CountKey, tasks: readonly TaskEntry[]): TaskEntry[] {
  switch (key) {
    case 'ready':
      return tasks.filter((t) => t.readiness?.state === 'ready');
    case 'doing':
      return tasks.filter((t) => t.status === 'doing');
    case 'blocked':
      return tasks.filter((t) => t.status === 'blocked');
    case 'estimated':
      // What the engine counts as estimated: a task with a value.
      return tasks.filter((t) => t.value !== undefined);
  }
}

export interface Group {
  /** What the group is: an area, a plan, a priority, a blocker; empty for "none". */
  key: string;
  tasks: TaskEntry[];
}

/** The key of the group a task is in for `view`. */
function groupKey(view: CountView, task: TaskEntry): string {
  switch (view) {
    case 'area':
      return task.area;
    case 'plan':
      return task.plan ?? '';
    case 'prio':
      return task.prio === undefined ? '' : String(task.prio);
    case 'blocker':
      // The first blocker that is still open; a task that waits on a finished one only is "none".
      {
        const open = task.readiness?.open_blockers;
        return (open ? open[0] : task.blocked_by[0]) ?? '';
      }
    case 'list':
      return '';
  }
}

/**
 * The tasks cut up by `view`. `list` is one group with no key. Every task is in exactly one group, so the groups add up
 * to the number. Groups come in the order of their first task (priorities in numeric order, the one with none last).
 */
export function groupTasks(view: CountView, tasks: readonly TaskEntry[]): Group[] {
  if (view === 'list') return [{ key: '', tasks: [...tasks] }];
  const groups = new Map<string, TaskEntry[]>();
  for (const task of tasks) {
    const key = groupKey(view, task);
    const group = groups.get(key);
    if (group) group.push(task);
    else groups.set(key, [task]);
  }
  const out = [...groups].map(([key, list]) => ({ key, tasks: list }));
  if (view === 'prio') {
    // A priority is a number, not a name: 1 before 2 before none.
    out.sort((a, b) => (a.key === '' ? 9 : Number(a.key)) - (b.key === '' ? 9 : Number(b.key)));
  }
  return out;
}

/** How many tasks a view shows before the person asks for more. */
export const PAGE = 50;

/**
 * The sentence above the tasks of a number: all of them are shown, or the filter hides some, or the filter hides some
 * and the rest lies in areas that are not released (`unfiltered` is what the engine counts for the released areas).
 */
export function countKey(hidden: number, unfiltered: number, total: number): 'count.of' | 'count.of_filtered' | 'count.of_both' {
  if (hidden <= 0) return 'count.of';
  return unfiltered < total ? 'count.of_both' : 'count.of_filtered';
}

/** The stored choices read back: only a number and a view that exist. */
export function parseViews(text: string | null): Partial<Record<CountKey, CountView>> {
  if (!text) return {};
  try {
    const raw: unknown = JSON.parse(text);
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return {};
    const out: Partial<Record<CountKey, CountView>> = {};
    for (const key of COUNT_KEYS) {
      const view = (raw as Record<string, unknown>)[key];
      if (viewAllowed(key, view)) out[key] = view;
    }
    return out;
  } catch {
    return {};
  }
}
