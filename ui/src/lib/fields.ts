// The values the property form offers. The engine owns the ranges (`hello.enums`); the hub's hello does not pass them
// on, so they are named here once, typed against the contract, and the engine refuses anything else with a reason.

import type { Kind } from './contract';

export const KINDS = ['feature', 'task', 'bug', 'idea', 'research'] as const satisfies readonly Kind[];

/** Sizes the engine knows; a duration (`3d`) that a file already carries is offered as it is. */
export const EFFORT_SIZES = ['XS', 'S', 'M', 'L', 'XL'] as const;

export const VALUES = [1, 2, 3, 4, 5] as const;

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

/** What the engine refuses inside a tag (it would break the list in the file); it also refuses control characters. */
// eslint-disable-next-line no-control-regex
const BAD_TAG = /[,[\]"'#\u0000-\u001f\u007f\u0085\u2028\u2029]/;

/** The first tag that the engine would refuse, or null. */
export function badTag(tags: readonly string[]): string | null {
  return tags.find((tag) => BAD_TAG.test(tag)) ?? null;
}
