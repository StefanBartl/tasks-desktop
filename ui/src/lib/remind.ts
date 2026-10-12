// Reminders: a task may carry a date on which to look at it again. The engine
// stores the date; whether it is due is for the reader to say (a digest does
// not change with the day), so it is said here, from the day of the person.

import type { Snapshot, TaskEntry } from './contract';

/** A finished task with a reminder, as the snapshot lists it. */
export type DoneReminder = NonNullable<Snapshot['reminders']>[number];

/** One line of the card: an open task, or a finished one (it is not in the list of tasks). */
export interface DueItem {
  id: string;
  title: string;
  remind: string;
  etag?: string;
  finished: boolean;
}

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

/**
 * What is due: the open tasks and the finished ones, the oldest date first. A
 * finished task is not in the list of tasks, and a reminder is most often set
 * when a task is finished, so the snapshot lists those on their own.
 */
export function dueItems(
  tasks: readonly TaskEntry[],
  finished: readonly DoneReminder[] | undefined,
  today: string,
): DueItem[] {
  const open: DueItem[] = dueTasks(tasks, today).map((t) => ({
    id: t.id,
    title: t.title,
    remind: t.remind ?? '',
    ...(t.etag ? { etag: t.etag } : {}),
    finished: false,
  }));
  const done: DueItem[] = (finished ?? [])
    .filter((r) => isDue(r.remind, today))
    .map((r) => ({
      id: r.id,
      title: r.title,
      remind: r.remind,
      ...(r.etag ? { etag: r.etag } : {}),
      finished: true,
    }));
  return [...open, ...done]
    .map((item, index) => ({ item, index }))
    .sort((a, b) => a.item.remind.localeCompare(b.item.remind) || a.index - b.index)
    .map(({ item }) => item);
}

/** What the page offers: the words the engine reads (`+3d`, `+2w`). */
export const REMIND_CHOICES = ['+0d', '+3d', '+7d', '+14d', '+30d'] as const;
