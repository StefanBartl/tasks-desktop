// Area groups (tasks.nvim `<vault>/area-groups.json`): a filter name that stands for several areas. The engine resolves
// them (WEB-13); the page only puts the members it was told in the place of a chosen group name.

/** One group as the engine's snapshot names it (`area_groups`). */
export interface AreaGroupInfo {
  name: string;
  members: readonly string[];
  open: number;
  desc?: string;
}

/**
 * What a choice of only empty groups becomes: a name no area can have (a NUL never is part of an area name), so the
 * filter keeps no task. An empty list would mean "no area filter" and show every task.
 */
export const NO_AREA = '\u0000no-area';

/**
 * The areas a filter means: every chosen name that is a group (and no area of the vault: an area of the same name wins)
 * stands for its members, the rest stays. Each area once, in the order of the choice. The same array when nothing was a
 * group, so a caller can tell nothing changed; `[NO_AREA]` when the groups chosen have no member.
 */
export function expandAreas(chosen: readonly string[], groups: readonly AreaGroupInfo[], areas: readonly string[]): readonly string[] {
  if (chosen.length === 0 || groups.length === 0) return chosen;
  const isArea = new Set(areas);
  const byName = new Map(groups.map((g) => [g.name, g]));
  if (!chosen.some((name) => !isArea.has(name) && byName.has(name))) return chosen;
  const out: string[] = [];
  const seen = new Set<string>();
  for (const name of chosen) {
    const group = isArea.has(name) ? undefined : byName.get(name);
    for (const area of group ? group.members : [name]) {
      if (!seen.has(area)) {
        seen.add(area);
        out.push(area);
      }
    }
  }
  return out.length > 0 ? out : [NO_AREA];
}

/** Whether `name` is a group in force (no area of the vault has that name). */
export function isAreaGroup(name: string, groups: readonly AreaGroupInfo[], areas: readonly string[]): boolean {
  return !areas.includes(name) && groups.some((g) => g.name === name);
}
