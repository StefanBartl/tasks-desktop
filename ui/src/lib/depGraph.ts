// The plan as a dependency graph: tasks in rows (the engine's stage, read only), arrows for `blocked_by` (hard)
// and `after` (soft) between them. The rows and the edges come straight from the snapshot already loaded for the
// stage view; nothing here asks the engine again. The order of tasks inside a row is display only (no field holds
// it): a barycenter sweep settles it so that fewer arrows cross, not so that any later run keeps it.

import type { TaskEntry } from './contract';

export interface GraphEdge {
  from: string;
  to: string;
  kind: 'blocked_by' | 'after';
}

export interface GraphRow {
  /** The engine's stage; `null` is the row for the tasks a cycle holds (always last, as in `stagesOf`). */
  row: number | null;
  ids: string[];
}

export interface Graph {
  rows: GraphRow[];
  edges: GraphEdge[];
}

/**
 * The tasks of one plan (`null`: every task shown) as rows by stage, with the edges between them, ordered inside
 * each row to keep crossing arrows apart.
 */
export function layoutGraph(tasks: readonly TaskEntry[], planId: string | null): Graph {
  const members = planId === null ? tasks : tasks.filter((t) => t.plan === planId);
  const ids = new Set(members.map((t) => t.id));
  const edges: GraphEdge[] = [];
  for (const t of members) {
    for (const from of t.blocked_by) if (from !== t.id && ids.has(from)) edges.push({ from, to: t.id, kind: 'blocked_by' });
    for (const from of t.after) if (from !== t.id && ids.has(from)) edges.push({ from, to: t.id, kind: 'after' });
  }
  const byRow = new Map<number | null, string[]>();
  for (const t of members) {
    const row = t.readiness?.stage ?? null;
    const list = byRow.get(row);
    if (list) list.push(t.id);
    else byRow.set(row, [t.id]);
  }
  const rows: GraphRow[] = [...byRow.entries()]
    .sort(([a], [b]) => (a === null ? 1 : b === null ? -1 : a - b))
    .map(([row, list]) => ({ row, ids: list }));
  orderRows(rows, edges);
  return { rows, edges };
}

/** Barycenter sweeps: each pass places a task at the average position of its neighbours in the row before (or
 * after, on the way back), ties broken by the position it already has, so a row with nothing pointing into it
 * keeps its original (stable) order. */
function orderRows(rows: GraphRow[], edges: readonly GraphEdge[]): void {
  const positions = new Map<string, number>();
  for (const row of rows) row.ids.forEach((id, i) => positions.set(id, i));
  const predOf = new Map<string, string[]>();
  const succOf = new Map<string, string[]>();
  for (const e of edges) {
    const preds = predOf.get(e.to);
    if (preds) preds.push(e.from);
    else predOf.set(e.to, [e.from]);
    const succs = succOf.get(e.from);
    if (succs) succs.push(e.to);
    else succOf.set(e.from, [e.to]);
  }
  const SWEEPS = 4;
  for (let sweep = 0; sweep < SWEEPS; sweep++) {
    const down = sweep % 2 === 0;
    const order = down ? rows : [...rows].reverse();
    const neighboursOf = down ? predOf : succOf;
    for (const row of order) {
      const withBary = row.ids.map((id) => {
        const neighbourPositions = (neighboursOf.get(id) ?? [])
          .map((n) => positions.get(n))
          .filter((p): p is number => p !== undefined);
        const fallback = positions.get(id) ?? 0;
        const bary = neighbourPositions.length > 0 ? neighbourPositions.reduce((a, b) => a + b, 0) / neighbourPositions.length : fallback;
        return { id, bary, fallback };
      });
      withBary.sort((a, b) => a.bary - b.bary || a.fallback - b.fallback);
      row.ids = withBary.map((w) => w.id);
      row.ids.forEach((id, i) => positions.set(id, i));
    }
  }
}

/**
 * How many arrows cross between two neighbouring rows, counting each pair once: the metric the ordering above is
 * meant to bring down. An arrow that skips a row (stage 0 straight to stage 2) is drawn but not counted here, same
 * as a classic layered-graph crossing count.
 */
export function countCrossings(rows: readonly GraphRow[], edges: readonly GraphEdge[]): number {
  const rowIndexOf = new Map<string, number>();
  const posOf = new Map<string, number>();
  rows.forEach((row, ri) => row.ids.forEach((id, pi) => {
    rowIndexOf.set(id, ri);
    posOf.set(id, pi);
  }));
  let total = 0;
  for (let ri = 0; ri < rows.length - 1; ri++) {
    const between = edges.filter((e) => rowIndexOf.get(e.from) === ri && rowIndexOf.get(e.to) === ri + 1);
    for (let i = 0; i < between.length; i++) {
      for (let j = i + 1; j < between.length; j++) {
        const a = between[i]!;
        const b = between[j]!;
        if (a.from === b.from || a.to === b.to) continue;
        const pa1 = posOf.get(a.from)!;
        const pa2 = posOf.get(a.to)!;
        const pb1 = posOf.get(b.from)!;
        const pb2 = posOf.get(b.to)!;
        if ((pa1 - pb1) * (pa2 - pb2) < 0) total++;
      }
    }
  }
  return total;
}
