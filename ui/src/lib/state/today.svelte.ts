// How the start page is laid out, and what the person chose there: the blocks put away, their order, the number of the
// overview that is open and the view chosen for each, and the choice of the tile Today (the period and the evaluations).
// A part of the state of the page of its own; everything here is kept in the profile of this browser.

import { defaultView, nextView, parseViews, type CountKey, type CountView } from '../counts';
import { DEFAULT_PREFS as DEFAULT_DAILY, parseDailyPrefs, type DailyPrefs } from '../daily';
import { translate, type Lang } from '../i18n';
import { moved, parseOrder } from '../tiles';
import { ORDERED_TILES, TILES, type OrderedTile, type Tile } from '../tiles-list';

/** What the layout needs of the page around it. */
export interface TodayHost {
  lang(): Lang;
  /** Per-browser storage; every failure of it is a miss. */
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

const TILE_LABELS = { next: 'today.next', waiting: 'today.waiting', remind: 'remind.title', cdx: 'today.cdx' } as const;

/** The remembered hidden blocks; anything that is not a known block is dropped. */
export function parseTiles(text: string | null): Tile[] {
  if (!text) return [];
  try {
    const value: unknown = JSON.parse(text);
    if (!Array.isArray(value)) return [];
    return TILES.filter((t) => value.includes(t));
  } catch {
    return [];
  }
}

export class TodayState {
  /** Blocks of the Today view the person put away. */
  hidden = $state<Tile[]>([]);
  order = $state<OrderedTile[]>([...ORDERED_TILES]);
  /** What a move of a block says to a screen reader. */
  note = $state('');
  /** The number of the overview whose tasks are shown (none: closed). */
  countOpen = $state<CountKey | null>(null);
  /** The view chosen for each number; what is not here has the default. */
  countViews = $state<Partial<Record<CountKey, CountView>>>({});
  /** The choice of the tile Today (the period and the evaluations). */
  daily = $state.raw<DailyPrefs>({ ...DEFAULT_DAILY, metrics: [...DEFAULT_DAILY.metrics] });

  constructor(private readonly host: TodayHost) {
    this.hidden = parseTiles(host.getItem('tasks-desktop.tiles-hidden'));
    this.order = parseOrder(host.getItem('tasks-desktop.tiles-order'), ORDERED_TILES);
    this.countViews = parseViews(host.getItem('tasks-desktop.count-views'));
    this.daily = parseDailyPrefs(host.getItem('tasks-desktop.daily'));
  }

  setDaily(prefs: DailyPrefs): void {
    this.daily = prefs;
    this.host.setItem('tasks-desktop.daily', JSON.stringify(prefs));
  }

  hide(tile: Tile): void {
    if (this.hidden.includes(tile)) return;
    this.hidden = [...this.hidden, tile];
    this.saveHidden();
  }

  showAll(): void {
    this.hidden = [];
    this.saveHidden();
  }

  private saveHidden(): void {
    this.host.setItem('tasks-desktop.tiles-hidden', JSON.stringify(this.hidden));
  }

  /** The view a number shows its tasks in. */
  countView(key: CountKey): CountView {
    return this.countViews[key] ?? defaultView(key);
  }

  /** Open the tasks behind a number, or close them when they are open. */
  toggleCount(key: CountKey): void {
    this.countOpen = this.countOpen === key ? null : key;
  }

  closeCount(): void {
    this.countOpen = null;
  }

  setCountView(key: CountKey, view: CountView): void {
    this.countViews = { ...this.countViews, [key]: view };
    this.host.setItem('tasks-desktop.count-views', JSON.stringify(this.countViews));
  }

  /**
   * The key `v` on a number: a number that is closed opens in the view it has (the first press shows what the number
   * holds, it does not skip a view); one that is open goes on to its next view.
   */
  cycleCountView(key: CountKey): void {
    if (this.countOpen !== key) {
      this.countOpen = key;
      return;
    }
    this.setCountView(key, nextView(key, this.countView(key)));
  }

  /** Put the block `tile` before (or after) `target`; `visible` are the blocks on the page, for the number said aloud. */
  move(tile: OrderedTile, target: OrderedTile, after: boolean, visible: readonly OrderedTile[]): void {
    const order = moved(this.order, tile, target, after);
    if (order.every((t, i) => t === this.order[i])) return;
    this.order = order;
    this.saveOrder();
    const now = order.filter((t) => visible.includes(t));
    this.note = translate(this.host.lang(), 'today.moved', {
      tile: translate(this.host.lang(), TILE_LABELS[tile]),
      n: now.indexOf(tile) + 1,
      total: now.length,
    });
  }

  /** The blocks are not in the standard order (what "reset the order" would change). */
  get orderChanged(): boolean {
    return this.order.some((tile, i) => tile !== ORDERED_TILES[i]);
  }

  resetOrder(): void {
    this.order = [...ORDERED_TILES];
    this.saveOrder();
    this.note = translate(this.host.lang(), 'today.order_reset');
  }

  private saveOrder(): void {
    this.host.setItem('tasks-desktop.tiles-order', JSON.stringify(this.order));
  }
}
