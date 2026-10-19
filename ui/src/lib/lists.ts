// Named lists: a name for a filter and an order, so that nobody sets the same filter twice ("small and worth it,
// best return first"). They live in this browser only (the page's memory, like the filter itself) and belong to
// the vault they were made in: the areas, tags and plans of a filter mean nothing in another one.

import { parseFilter, serializeFilter, type Filter } from './filter';
import { parseSort, type SortWord } from './sort';

/** The longest name; shorter keeps the menu readable. */
export const MAX_NAME = 40;
/** The most lists of one vault. */
export const MAX_LISTS = 50;

export interface NamedList {
  name: string;
  /** The filter as `serializeFilter` writes it (without the search words, without a vault). */
  filter: string;
  sort: SortWord;
}

/** The memory of all vaults: the lists by the name of the vault (`''` for a hub with one vault and no name). */
export type ListMemory = Record<string, NamedList[]>;

/** A name as it is kept: spaces trimmed and collapsed. Null when it is empty, too long, or holds a control character. */
export function cleanName(text: string): string | null {
  const name = text.replace(/\s+/g, ' ').trim();
  // eslint-disable-next-line no-control-regex
  if (name === '' || name.length > MAX_NAME || /[\u0000-\u001f\u007f]/.test(name)) return null;
  return name;
}

const same = (a: string, b: string): boolean => a.toLocaleLowerCase() === b.toLocaleLowerCase();

/** The key of a vault in the memory. */
export function vaultKey(vault: string | null | undefined): string {
  return typeof vault === 'string' ? vault : '';
}

/** What was remembered, read back: damaged parts go, the rest stays. */
export function parseListMemory(text: string | null): ListMemory {
  let raw: unknown;
  try {
    raw = text ? JSON.parse(text) : null;
  } catch {
    return {};
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return {};
  const out: ListMemory = {};
  for (const [vault, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!Array.isArray(value)) continue;
    const lists: NamedList[] = [];
    for (const item of value) {
      if (typeof item !== 'object' || item === null) continue;
      const o = item as Record<string, unknown>;
      const name = typeof o.name === 'string' ? cleanName(o.name) : null;
      if (name === null || typeof o.filter !== 'string' || lists.some((l) => same(l.name, name))) continue;
      lists.push({ name, filter: serializeFilter(parseFilter(o.filter)), sort: parseSort(o.sort) });
      if (lists.length >= MAX_LISTS) break;
    }
    if (lists.length > 0) out[vault] = lists;
  }
  return out;
}

export function serializeListMemory(memory: ListMemory): string {
  return JSON.stringify(memory);
}

/**
 * The filter in the one form it is kept in: written, read back and written again. The choices of a field come in the
 * order the person made them, and reading puts them in the order of the fields, so the same filter has two spellings
 * until it has been through here.
 */
function canonical(filter: Filter): string {
  return serializeFilter(parseFilter(serializeFilter(filter)));
}

/** A list for the filter and the order shown now. */
export function makeList(name: string, filter: Filter, sort: SortWord): NamedList {
  return { name, filter: canonical(filter), sort };
}

/** The lists with `list` in them: one of the same name (whatever the case) is replaced, else it is added. Null when full. */
export function withList(lists: readonly NamedList[], list: NamedList): NamedList[] | null {
  const at = lists.findIndex((l) => same(l.name, list.name));
  if (at >= 0) return lists.map((l, i) => (i === at ? list : l));
  return lists.length >= MAX_LISTS ? null : [...lists, list];
}

export function withoutList(lists: readonly NamedList[], name: string): NamedList[] {
  return lists.filter((l) => !same(l.name, name));
}

/** The list that is exactly the filter and the order shown now, if there is one. */
export function activeList(lists: readonly NamedList[], filter: Filter, sort: SortWord): NamedList | undefined {
  const now = canonical(filter);
  return lists.find((l) => l.sort === sort && l.filter === now);
}
