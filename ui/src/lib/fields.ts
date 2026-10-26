// The values the property form offers. The engine owns the ranges (`hello.enums`) and the hub passes them on
// (`GET /api/tasks/enums`); `rangesOf` reads them. The lists below are only what the form offers until the hub has
// answered, or when it cannot (an old hub or engine): the engine refuses anything else with a reason.

import type { Kind } from './contract';

export const KINDS = ['feature', 'task', 'bug', 'idea', 'research'] as const satisfies readonly Kind[];

/** Sizes the engine knows; a duration (`3d`) that a file already carries is offered as it is. */
export const EFFORT_SIZES = ['XS', 'S', 'M', 'L', 'XL'] as const;

export const VALUES = [1, 2, 3, 4, 5] as const;

/** The open statuses in the order the engine names them (the board has its own columns). */
export const STATUSES = ['doing', 'decision', 'blocked', 'open', 'parked'] as const;
export const PRIOS = [1, 2, 3] as const;
export const ACTORS = ['me', 'cdx', 'pair'] as const;
export const CATEGORIES = ['bug', 'security', 'performance', 'docs', 'ruleset'] as const;
export const SEVERITIES = ['low', 'medium', 'high', 'critical'] as const;

/** The ranges the forms and filters offer. */
export interface Ranges {
  kinds: readonly string[];
  /** The sizes (`XS` ... `XL`); a duration (`3d`) is free text and not a size. */
  efforts: readonly string[];
  values: readonly number[];
  statuses: readonly string[];
  prios: readonly number[];
  actors: readonly string[];
  categories: readonly string[];
  severities: readonly string[];
}

export const DEFAULT_RANGES: Ranges = {
  kinds: KINDS,
  efforts: EFFORT_SIZES,
  values: VALUES,
  statuses: STATUSES,
  prios: PRIOS,
  actors: ACTORS,
  categories: CATEGORIES,
  severities: SEVERITIES,
};

const MOST = 50;

function words(list: unknown, keep: (word: string) => boolean = () => true): string[] | null {
  if (!Array.isArray(list) || list.length > MOST) return null;
  if (!list.every((w) => typeof w === 'string' && w !== '' && w.length <= 40)) return null;
  // Each once: a word named twice would be two choices of one value (and two keys of one row).
  const out = [...new Set((list as string[]).filter(keep))];
  return out.length > 0 ? out : null;
}

function numbers(list: unknown): number[] | null {
  if (!Array.isArray(list) || list.length === 0 || list.length > MOST) return null;
  return list.every((n) => Number.isInteger(n) && n >= 0 && n < 1000) ? [...new Set(list as number[])] : null;
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
    statuses: words(given['status']) ?? DEFAULT_RANGES.statuses,
    prios: numbers(given['prio']) ?? DEFAULT_RANGES.prios,
    actors: words(given['actor']) ?? DEFAULT_RANGES.actors,
    categories: words(given['category']) ?? DEFAULT_RANGES.categories,
    severities: words(given['severity']) ?? DEFAULT_RANGES.severities,
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

/** The free-text sections of a new task, as the capture form holds them. */
export interface BodySections {
  context: string;
  acceptance: string;
  notes: string;
}

const SECTION_DEFS = {
  de: [
    ['context', '## Kontext', '<!-- Warum, woher kam das. -->'],
    ['acceptance', '## Akzeptanz', '<!-- was am Ende wahr sein muss, als Checkliste -->'],
    ['notes', '## Notizen', '<!-- Entscheidungen, Sackgassen, Verweise. -->'],
  ],
  en: [
    ['context', '## Context', '<!-- Why, where this came from. -->'],
    ['acceptance', '## Acceptance', '<!-- what must be true at the end, as a checklist -->'],
    ['notes', '## Notes', '<!-- Decisions, dead ends, references. -->'],
  ],
} as const;

/**
 * The body of a new task from the three sections, as `:Tasks new` writes it (`mutate.body_sections` of tasks.nvim: the
 * same headings and the same hint comment for an empty section; a line of the acceptance without a checkbox becomes
 * `- [ ] line`). Empty when nothing was typed: the engine then writes the sections of its template itself.
 */
export function bodyFromSections(sections: BodySections, lang: 'de' | 'en'): string {
  if ([sections.context, sections.acceptance, sections.notes].every((text) => text.trim() === '')) return '';
  const out: string[] = [];
  for (const [key, heading, hint] of SECTION_DEFS[lang]) {
    let text = sections[key].trim().replace(/\r\n?/g, '\n');
    if (text !== '' && key === 'acceptance') {
      text = text
        .split('\n')
        .map((line) => (line.trim() === '' || /^\s*[-*]\s/.test(line) ? line : `- [ ] ${line.trim()}`))
        .join('\n');
    }
    out.push(heading, '', text !== '' ? text : hint, '');
  }
  return out.join('\n');
}

/**
 * Whether `text` is a web address the `links` field may hold: `http://` or `https://`, a host, no blank or control
 * character (the engine's `model.is_web_link`). Only such an entry is drawn as a link: `javascript:` is never one.
 */
export function isWebLink(text: string): boolean {
  return /^https?:\/\/[^\s/?#]/i.test(text) && !/[\s\p{Cc}]/u.test(text);
}

/** The first entry that is no web address, or null. */
export function badLink(list: readonly string[]): string | null {
  return list.find((entry) => !isWebLink(entry)) ?? null;
}
