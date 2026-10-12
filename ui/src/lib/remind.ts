// Reminders: a task may carry a date on which to look at it again. The engine
// stores the date; whether it is due is for the reader to say (a digest does
// not change with the day), so it is said here, from the day of the person.

import type { TaskEntry } from './contract';

/** Today as `YYYY-MM-DD` in the local time of the reader (the engine's `today` is local too). */
export function localToday(now: Date = new Date()): string {
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${now.getFullYear()}-${month}-${day}`;
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** A reminder that is due: its date is today or earlier. A word that is no date is never due. */
export function isDue(remind: string | undefined, today: string): boolean {
  return remind !== undefined && DATE.test(remind) && remind <= today;
}

/** The tasks whose reminder is due, the oldest date first (the engine's order inside a day). */
export function dueTasks(tasks: readonly TaskEntry[], today: string): TaskEntry[] {
  return tasks
    .map((task, index) => ({ task, index }))
    .filter(({ task }) => isDue(task.remind, today))
    .sort((a, b) => {
      const byDate = (a.task.remind ?? '').localeCompare(b.task.remind ?? '');
      return byDate !== 0 ? byDate : a.index - b.index;
    })
    .map(({ task }) => task);
}

/** What the page offers: the words the engine reads (`+3d`, `+2w`). */
export const REMIND_CHOICES = ['+0d', '+3d', '+7d', '+14d', '+30d'] as const;
