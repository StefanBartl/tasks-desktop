// The plan, read from the snapshot: stages (what can be worked on in parallel
// once what comes before is done), the critical path and where the plan
// holds something the person should know about. The engine did all the
// reckoning; this only groups what it says.

import type { Snapshot, TaskEntry } from './contract';

export interface Stage {
  /** The stage number (1 is first); `null` for the tasks that sit in a cycle. */
  stage: number | null;
  tasks: TaskEntry[];
}

/**
 * The tasks grouped by stage, in the engine's plan order inside a stage. A
 * task without a stage (it is in a cycle) is its own group, last. `plan`
 * (an id) narrows to the members of one plan.
 */
export function stagesOf(tasks: readonly TaskEntry[], plan: string | null = null): Stage[] {
  const byStage = new Map<number | null, TaskEntry[]>();
  for (const task of tasks) {
    if (plan !== null && task.plan !== plan) continue;
    const key = task.readiness?.stage ?? null;
    const list = byStage.get(key);
    if (list) list.push(task);
    else byStage.set(key, [task]);
  }
  return [...byStage.entries()]
    .sort(([a], [b]) => (a === null ? 1 : b === null ? -1 : a - b))
    .map(([stage, list]) => ({ stage, tasks: list }));
}

/** The ids of the critical path, for marking. */
export function criticalIds(plan: Snapshot['plan'] | undefined): Set<string> {
  return new Set(plan?.critical_path.path ?? []);
}

/** The phases a plan names, in its own order, with how many of the shown tasks are in each. */
export function phaseCounts(
  tasks: readonly TaskEntry[],
  plan: Snapshot['plans'][number] | undefined,
): { phase: string; n: number }[] {
  if (!plan) return [];
  const counts = new Map<string, number>();
  for (const t of tasks) {
    if (t.plan === plan.id && t.phase) counts.set(t.phase, (counts.get(t.phase) ?? 0) + 1);
  }
  const named = plan.phase_order.map((phase) => ({ phase, n: counts.get(phase) ?? 0 }));
  const unnamed = [...counts.entries()]
    .filter(([phase]) => !plan.phase_order.includes(phase))
    .map(([phase, n]) => ({ phase, n }));
  return [...named, ...unnamed];
}
