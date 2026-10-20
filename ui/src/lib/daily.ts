// The small summary of the day on the start page: how many tasks were made today, how many were changed today, and
// (from the Backlogs, by the engine) how many were finished today. A day is a calendar day, `YYYY-MM-DD`, as the
// files write them (`created`, `updated`).

import type { TaskEntry } from './contract';

export interface DailyFigures {
  /** Tasks whose `created` is the day. */
  created: number;
  /** Tasks changed on the day that were made on an earlier day (a new task is not also "changed"). */
  changed: number;
}

export function dailyFigures(tasks: readonly Pick<TaskEntry, 'created' | 'updated'>[], day: string): DailyFigures {
  let created = 0;
  let changed = 0;
  for (const task of tasks) {
    const made = task.created as unknown as string | undefined;
    const touched = task.updated as unknown as string | undefined;
    if (made === day) created += 1;
    else if (touched === day) changed += 1;
  }
  return { created, changed };
}
