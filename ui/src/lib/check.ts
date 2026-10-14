// The findings of the check, judged one by one. The engine's `tasks.check` document carries the `rev` of the open
// tasks, like every document; the page does not throw the whole document away when one task changes, it judges each
// finding against the task it is about. The ground for that is the version (`etag`) of every task as it was when the
// check was made: taken from the snapshot of the same `rev` at the moment the job is seen done.

import type { Check, TaskEntry } from './contract';

export type Finding = Check['findings'][number];

/** The versions of the tasks a check was made against: the ground every finding is judged on. */
export type Ground = ReadonlyMap<string, string>;

export function groundOf(tasks: readonly TaskEntry[]): Ground {
  return new Map(tasks.map((t) => [t.id, t.etag ?? '']));
}

/** What the findings are worth now. */
export interface Judged {
  /** Findings that hold: about a task that is as it was, or about no listed task at all (a file, an unlisted task). */
  valid: Finding[];
  /** Findings about a task that changed since the check: possibly resolved, shown but not counted on. */
  stale: Finding[];
  /** How many tasks with findings changed or went away since the check. */
  changed: number;
}

/**
 * Judge the findings against the tasks as they are now. A finding about a task the check knew: it holds while the
 * task has the same version, is stale when the version changed, and is dropped when the task is gone (finished,
 * moved). A finding about something the snapshot does not list (the index, the Backlog, a plan file, an unlisted
 * task) has no version to judge by: it stands as a finding of the time the check was made.
 */
export function judgeFindings(findings: readonly Finding[], ground: Ground, tasks: readonly TaskEntry[]): Judged {
  const now = groundOf(tasks);
  const valid: Finding[] = [];
  const stale: Finding[] = [];
  const changed = new Set<string>();
  for (const f of findings) {
    if (f.id === undefined || !ground.has(f.id)) {
      valid.push(f);
      continue;
    }
    const version = now.get(f.id);
    if (version === undefined) {
      changed.add(f.id);
    } else if (version === ground.get(f.id)) {
      valid.push(f);
    } else {
      stale.push(f);
      changed.add(f.id);
    }
  }
  return { valid, stale, changed: changed.size };
}

/** The findings that hold, by the task each is about (a finding without a task is not in it). */
export function findingsByTask(valid: readonly Finding[]): Map<string, Finding[]> {
  const out = new Map<string, Finding[]>();
  for (const f of valid) {
    if (f.id === undefined) continue;
    const list = out.get(f.id);
    if (list) list.push(f);
    else out.set(f.id, [f]);
  }
  return out;
}

/** The time of a check for the person, in their language; nothing for a time the document does not say well. */
export function timeOf(generatedAt: string, lang: string): string | null {
  const date = new Date(generatedAt);
  if (Number.isNaN(date.getTime())) return null;
  try {
    return new Intl.DateTimeFormat(lang, { hour: '2-digit', minute: '2-digit' }).format(date);
  } catch {
    return null;
  }
}
