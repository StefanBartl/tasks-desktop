// The values the property form offers. The engine owns the ranges (`hello.enums`); the hub's hello does not pass them
// on, so they are named here once, typed against the contract, and the engine refuses anything else with a reason.

import type { Kind } from './contract';

export const KINDS = ['feature', 'task', 'bug', 'idea', 'research'] as const satisfies readonly Kind[];

/** Sizes the engine knows; a duration (`3d`) that a file already carries is offered as it is. */
export const EFFORT_SIZES = ['XS', 'S', 'M', 'L', 'XL'] as const;

export const VALUES = [1, 2, 3, 4, 5] as const;

/** The longest tag the form sends; the engine's own limit is the last word. */
const MAX_TAG = 64;

/**
 * Tags as typed: separated by commas, trimmed, no empty one, no duplicate, order kept.
 * An empty text is no tags.
 */
export function parseTags(text: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of text.split(',')) {
    const tag = part.trim().slice(0, MAX_TAG);
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
