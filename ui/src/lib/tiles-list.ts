// The blocks of the Today view: all of them (what can be put away), and the ones that can be put in another order.

export const TILES = ['next', 'waiting', 'remind', 'cdx', 'counts', 'daily'] as const;
export type Tile = (typeof TILES)[number];
/** The blocks of the column that can be put in another order (the counts have a column of their own). */
export const ORDERED_TILES = ['next', 'waiting', 'remind', 'cdx'] as const satisfies readonly Tile[];
export type OrderedTile = (typeof ORDERED_TILES)[number];
