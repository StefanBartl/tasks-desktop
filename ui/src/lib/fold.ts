// How far a block of a view is folded: a stage of the plan, a column of the board. `open` shows all of it, `folded`
// only its head (it takes no height), `narrow` its head on its side (it takes no width either), so the blocks the
// person compares stand next to each other. A press on the block's button moves it one step on, round to open.

export type Fold = 'open' | 'folded' | 'narrow';
export const FOLDS: readonly Fold[] = ['open', 'folded', 'narrow'];

/** The views whose blocks fold. */
export type FoldView = 'plan' | 'board';
export const FOLD_VIEWS: readonly FoldView[] = ['plan', 'board'];

/** Per block (the number of a stage, the status of a column): how far it is folded. An open block is not kept. */
export type Folds = Record<string, Fold>;
export type FoldMemory = Record<FoldView, Folds>;

export const emptyFolds = (): FoldMemory => ({ plan: {}, board: {} });

export function nextFold(fold: Fold): Fold {
  return fold === 'open' ? 'folded' : fold === 'folded' ? 'narrow' : 'open';
}

/** The step before `fold`: a button that moves one step on from it reaches `fold`. */
export function previousFold(fold: Fold): Fold {
  return nextFold(nextFold(fold));
}

/**
 * The step the button for all blocks is shown at: the one before `nextAll`, so that its press (one step on) takes the
 * blocks to `nextAll`.
 */
export function allButtonFold(folds: Folds, keys: readonly string[]): Fold {
  return previousFold(nextAll(folds, keys));
}

export function foldOf(folds: Folds, key: string): Fold {
  return folds[key] ?? 'open';
}

/** The folds with one block set; an open block is taken out. */
export function withFold(folds: Folds, key: string, fold: Fold): Folds {
  const { [key]: _gone, ...rest } = folds;
  return fold === 'open' ? rest : { ...rest, [key]: fold };
}

/**
 * Where the button for all blocks takes them: one step on from where they all are, and to `folded` when they are not
 * all at the same step (the first press makes them alike).
 */
export function nextAll(folds: Folds, keys: readonly string[]): Fold {
  const now = new Set(keys.map((key) => foldOf(folds, key)));
  if (now.size !== 1) return 'folded';
  return nextFold([...now][0] ?? 'open');
}

/** Every one of `keys` at `fold`; the folds of other blocks are kept. */
export function withAll(folds: Folds, keys: readonly string[], fold: Fold): Folds {
  return keys.reduce((acc, key) => withFold(acc, key, fold), folds);
}

export function serializeFolds(memory: FoldMemory): string {
  return JSON.stringify(memory);
}

/** The remembered folds; what cannot be read (a damaged memory, an unknown step) is open. */
export function parseFolds(text: string | null): FoldMemory {
  const out = emptyFolds();
  let raw: unknown;
  try {
    raw = text ? JSON.parse(text) : null;
  } catch {
    return out;
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return out;
  for (const view of FOLD_VIEWS) {
    const folds = (raw as Record<string, unknown>)[view];
    if (typeof folds !== 'object' || folds === null || Array.isArray(folds)) continue;
    for (const [key, fold] of Object.entries(folds)) {
      if (fold === 'folded' || fold === 'narrow') out[view][key] = fold;
    }
  }
  return out;
}
