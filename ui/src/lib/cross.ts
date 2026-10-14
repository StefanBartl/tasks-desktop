// Which tasks connect areas (repos). Read from what the tasks of the snapshot say: a task that waits for
// (`blocked_by`) or comes after (`after`) a task of another area is a link between the two areas. Nothing
// here decides anything about a task; it only groups what is written (links to a finished task or to an id
// that is not in the list are left out: they are not open work).

import type { TaskEntry } from './contract';

export type EdgeKind = 'blocked_by' | 'after';

export interface CrossEdge {
  /** The task that waits for or comes after the other one. */
  from: string;
  /** The task it waits for or comes after. */
  to: string;
  kind: EdgeKind;
  fromArea: string;
  toArea: string;
}

/** The area an id belongs to: the part before the first slash. */
export function areaOfId(id: string): string {
  return id.split('/')[0] ?? '';
}

/** Every link between two open tasks of different areas. */
export function crossEdges(tasks: readonly TaskEntry[]): CrossEdge[] {
  const open = new Set(tasks.map((t) => t.id));
  const out: CrossEdge[] = [];
  for (const task of tasks) {
    for (const kind of ['blocked_by', 'after'] as const) {
      for (const to of task[kind]) {
        const toArea = areaOfId(to);
        if (open.has(to) && toArea !== task.area) {
          out.push({ from: task.id, to, kind, fromArea: task.area, toArea });
        }
      }
    }
  }
  return out;
}

/** For every task: its own area and the areas of the tasks it is linked with, in either direction. */
export function touchedAreas(tasks: readonly TaskEntry[]): Map<string, Set<string>> {
  const touched = new Map<string, Set<string>>(tasks.map((t) => [t.id, new Set([t.area])]));
  for (const edge of crossEdges(tasks)) {
    touched.get(edge.from)?.add(edge.toArea);
    touched.get(edge.to)?.add(edge.fromArea);
  }
  return touched;
}

/**
 * Whether a task connects areas: it touches two or more. With areas chosen, only the chosen ones count, so a
 * task that links a chosen area with one that is not chosen is not a link between the chosen ones.
 */
export function connectsAreas(touched: ReadonlySet<string> | undefined, chosen: readonly string[]): boolean {
  if (!touched) return false;
  const counted = chosen.length > 0 ? [...touched].filter((a) => chosen.includes(a)) : [...touched];
  return counted.length >= 2;
}

export interface Pair {
  a: string;
  b: string;
  edges: CrossEdge[];
}

/**
 * The links grouped by the two areas they connect (the order of the two does not matter), the busiest pair
 * first. With areas chosen, only links between two chosen areas are kept.
 */
export function pairsOf(edges: readonly CrossEdge[], chosen: readonly string[] = []): Pair[] {
  const groups = new Map<string, Pair>();
  for (const edge of edges) {
    if (chosen.length > 0 && !(chosen.includes(edge.fromArea) && chosen.includes(edge.toArea))) continue;
    const [a, b] = edge.fromArea < edge.toArea ? [edge.fromArea, edge.toArea] : [edge.toArea, edge.fromArea];
    const key = `${a}\u0000${b}`;
    const pair = groups.get(key) ?? { a, b, edges: [] };
    pair.edges.push(edge);
    groups.set(key, pair);
  }
  return [...groups.values()].sort(
    (x, y) => y.edges.length - x.edges.length || x.a.localeCompare(y.a) || x.b.localeCompare(y.b),
  );
}
