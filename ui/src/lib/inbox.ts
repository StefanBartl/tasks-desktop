// The inbox: open tasks that are not sorted yet (no priority, no effort, no actor written), and the single keys that
// sort them. The page decides nothing about the values: it sends what the key names and the engine judges.

import type { TaskEntry } from './contract';

/** What a task in the inbox still lacks. */
export type Missing = 'prio' | 'effort' | 'actor';

export function missingOf(task: TaskEntry): Missing[] {
  const out: Missing[] = [];
  if (task.prio === undefined) out.push('prio');
  if (!task.effort) out.push('effort');
  // `actor` is derived when the file does not say: only a written one counts as sorted.
  if (task.actor_written !== true) out.push('actor');
  return out;
}

/** The tasks that lack something, in the order they came in (the engine's plan order). */
export function inboxOf(tasks: readonly TaskEntry[]): TaskEntry[] {
  return tasks.filter((t) => missingOf(t).length > 0);
}

/** One key, one field and the value it writes. */
export interface TriageKey {
  field: Missing;
  value: string | number;
}

/**
 * The keys: 1 2 3 for the priority; a s d f for the effort XS S M L and Shift with f for XL (the sizes grow to the
 * right); m p i for the actor me, pair and cdx (an agent). Case is read from the Shift key, not from the letter: a
 * CapsLock does not make a plain f an XL.
 */
export function triageKey(key: string, shift: boolean): TriageKey | null {
  if (key === '1' || key === '2' || key === '3') return { field: 'prio', value: Number(key) };
  const letter = key.toLowerCase();
  if (letter === 'f') return { field: 'effort', value: shift ? 'XL' : 'L' };
  if (shift) return null;
  switch (letter) {
    case 'a':
      return { field: 'effort', value: 'XS' };
    case 's':
      return { field: 'effort', value: 'S' };
    case 'd':
      return { field: 'effort', value: 'M' };
    case 'm':
      return { field: 'actor', value: 'me' };
    case 'p':
      return { field: 'actor', value: 'pair' };
    case 'i':
      return { field: 'actor', value: 'cdx' };
    default:
      return null;
  }
}
