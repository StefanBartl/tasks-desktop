// The changes the engine refused because the file moved on: kept in one place for the conflict center. A part of the
// state of the page of its own. Trying a change again is a write, which the page does (`App.retryConflict`); this holds
// the list, whether the center is open and how it shows the list.

import { DEFAULT_CONFLICT_MODE, mergeConflicts, type ConflictMode } from 'appkit-ui/conflicts';
import type { Conflict } from '../conflicts';

export class ConflictsState {
  /** The refused changes, the newest first. */
  list = $state.raw<Conflict[]>([]);
  /** The conflict center is open. */
  open = $state(false);
  /** How the conflict center shows its list: every conflict (the default), or one at a time. */
  mode = $state<ConflictMode>(DEFAULT_CONFLICT_MODE);

  /** @param remember keeps the way the list is shown in the profile of this browser */
  constructor(private readonly remember: (mode: ConflictMode) => void) {}

  /** Keep these refusals; a newer one of the same change replaces the older. */
  add(refused: readonly Conflict[]): void {
    this.list = mergeConflicts(this.list, refused);
  }

  show(): void {
    if (this.list.length > 0) this.open = true;
  }

  hide(): void {
    this.open = false;
  }

  setMode(mode: ConflictMode): void {
    this.mode = mode;
    this.remember(mode);
  }

  /** The conflict of this key, if it is kept. */
  find(key: string): Conflict | undefined {
    return this.list.find((c) => c.key === key);
  }

  /** Let a refused change go; the center closes with the last one. */
  discard(key: string): void {
    this.list = this.list.filter((c) => c.key !== key);
    if (this.list.length === 0) this.open = false;
  }

  discardAll(): void {
    this.list = [];
    this.open = false;
  }
}
