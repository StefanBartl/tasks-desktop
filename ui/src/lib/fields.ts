// The values the property form offers. The engine owns the ranges (`hello.enums`) and the hub passes them on
// (`GET /api/tasks/enums`); `rangesOf` reads them. The lists below are only what the form offers until the hub has
// answered, or when it cannot (an old hub or engine): the engine refuses anything else with a reason.

import type { Kind } from './contract';

export const KINDS = ['feature', 'task', 'bug', 'idea', 'research'] as const satisfies readonly Kind[];

/** Sizes the engine knows; a duration (`3d`) that a file already carries is offered as it is. */
export const EFFORT_SIZES = ['XS', 'S', 'M', 'L', 'XL'] as const;

export const VALUES = [1, 2, 3, 4, 5] as const;

/** The ranges the form offers. */
export interface Ranges {
  kinds: readonly string[];
  /** The sizes (`XS` ... `XL`); a duration (`3d`) is free text and not a size. */
  efforts: readonly string[];
  values: readonly number[];
}

export const DEFAULT_RANGES: Ranges = { kinds: KINDS, efforts: EFFORT_SIZES, values: VALUES };

const MOST = 50;

function words(list: unknown, keep: (word: string) => boolean = () => true): string[] | null {
  if (!Array.isArray(list) || list.length > MOST) return null;
  if (!list.every((w) => typeof w === 'string' && w !== '' && w.length <= 40)) return null;
  const out = (list as string[]).filter(keep);
  return out.length > 0 ? out : null;
}

function numbers(list: unknown): number[] | null {
  if (!Array.isArray(list) || list.length === 0 || list.length > MOST) return null;
  return list.every((n) => Number.isInteger(n) && n >= 0 && n < 1000) ? (list as number[]) : null;
}

/**
 * The ranges of the engine's `hello.enums`. A field that is missing or not what it should be keeps the default (the
 * answer of a hub is data, and a form with an empty list would offer nothing); the placeholder `<n>d` of the effort
 * is not a size.
 */
export function rangesOf(enums: unknown): Ranges {
  const given = enums !== null && typeof enums === 'object' ? (enums as Record<string, unknown>) : {};
  return {
    kinds: words(given['kind']) ?? DEFAULT_RANGES.kinds,
    efforts: words(given['effort'], (w) => !w.includes('<')) ?? DEFAULT_RANGES.efforts,
    values: numbers(given['value']) ?? DEFAULT_RANGES.values,
  };
}

/**
 * Tags as typed: separated by commas, trimmed, no empty one, no duplicate, order kept.
 * An empty text is no tags.
 */
export function parseTags(text: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of text.split(',')) {
    const tag = part.trim();
    if (tag === '' || seen.has(tag)) continue;
    seen.add(tag);
    out.push(tag);
  }
  return out;
}

/** A list the same way (ids, references): comma separated, trimmed, no duplicate. */
export const parseList = parseTags;

/**
 * Can this list be edited as one line of comma separated words? Only when typing the line back gives the same list:
 * not when an entry holds a comma (a reference may; it would be cut in two), has blanks around it, is empty or
 * repeats an earlier one (the line would be cleaned up, and the file changed in what the person did not touch).
 */
export function listEditable(list: readonly string[] | undefined): boolean {
  const entries = list ?? [];
  return !tagsChanged(entries, tagsText(entries)) && entries.every((entry) => !entry.includes(','));
}

/** Tags the way the field shows them. */
export function tagsText(tags: readonly string[] | undefined): string {
  return (tags ?? []).join(', ');
}

/** Whether typing `text` would change the tags that are there (the form writes nothing when it would not). */
export function tagsChanged(current: readonly string[] | undefined, text: string): boolean {
  const next = parseTags(text);
  const now = current ?? [];
  return next.length !== now.length || next.some((tag, i) => tag !== now[i]);
}

/** What the engine refuses inside a tag (it would break the list in the file), control characters (a tab is fine) and the C1 range. */
// eslint-disable-next-line no-control-regex
const BAD_TAG = /[,[\]"'#\u0000-\u0008\u000a-\u001f\u007f-\u009f\u2028\u2029]/;

/** The first tag that the engine would refuse, or null. */
export function badTag(tags: readonly string[]): string | null {
  return tags.find((tag) => BAD_TAG.test(tag)) ?? null;
}
