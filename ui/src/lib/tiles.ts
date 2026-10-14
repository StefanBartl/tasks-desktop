// The order of the blocks of the overview. The order holds every block, also a hidden one, so that a block that is
// shown again is back where it was.

/** The remembered order: unknown or repeated entries are dropped, a block that is missing goes to the end. */
export function parseOrder<T extends string>(text: string | null, all: readonly T[]): T[] {
  let given: unknown;
  try {
    given = text ? JSON.parse(text) : [];
  } catch {
    given = [];
  }
  const known = Array.isArray(given) ? given.filter((t): t is T => all.includes(t as T)) : [];
  const unique = known.filter((t, i) => known.indexOf(t) === i);
  return [...unique, ...all.filter((t) => !unique.includes(t))];
}

/** `tile` taken out and put before (or after) `target`; an unknown tile or target changes nothing. */
export function moved<T extends string>(order: readonly T[], tile: T, target: T, after: boolean): T[] {
  if (tile === target || !order.includes(tile) || !order.includes(target)) return [...order];
  const rest = order.filter((t) => t !== tile);
  const at = rest.indexOf(target) + (after ? 1 : 0);
  return [...rest.slice(0, at), tile, ...rest.slice(at)];
}
