// The unsaved changes of the detail's fields (the option "save fields with a button"): what a field holds, whether a
// value is the one the file has, and the task as the detail shows it (the file's values with the draft over them).

/** A value of a field as the page writes it; `null` takes the key away. */
export type FieldValue = string | number | string[] | null;

/**
 * Whether `next` is what the file has for the key (`current`): a key the file lacks is `null`, and so is an empty
 * list (the list fields of a task are `[]` when the file has none); a list is equal by items.
 */
export function sameField(next: FieldValue | undefined, current: unknown): boolean {
  const none = (v: unknown) => v === undefined || v === null || (Array.isArray(v) && v.length === 0);
  const a = none(next) ? null : next;
  const b = none(current) ? null : current;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((item, i) => item === b[i]);
  }
  return a === b;
}

/** The task as the detail shows it: the draft over the file's values (a key the draft takes away is not there). */
export function shownTask<T extends object>(task: T, draft: Readonly<Record<string, FieldValue>>): T {
  const out = { ...task } as Record<string, unknown>;
  for (const [key, value] of Object.entries(draft)) {
    if (value === null) delete out[key];
    else out[key] = value;
  }
  return out as T;
}
