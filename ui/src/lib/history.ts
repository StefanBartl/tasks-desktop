// Back and Forward in the browser: the view and the open task are the places of the page, and each place the
// person reaches is an entry of the history of the tab (the kit's `installNav`). The state sits in
// `history.state`, never in the address.

import { installNav, type Nav, type NavHistory, type NavWindow } from 'appkit-ui/nav';
import type { View } from './app.svelte';

const VIEWS: readonly string[] = ['today', 'list', 'board', 'plan', 'inbox', 'cross', 'done'];

/** Where the person is: a view, and the task that is open in it (if any). */
export interface Place {
  view: View;
  selectedId: string | null;
}

export function isPlace(value: unknown): value is Place {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as { view?: unknown; selectedId?: unknown };
  return typeof v.view === 'string' && VIEWS.includes(v.view) && (v.selectedId === null || typeof v.selectedId === 'string');
}

/** What the history needs of the app. */
export interface HistoryApp {
  view: View;
  selectedId: string | null;
  tasks: readonly { id: string }[];
  setView(view: View): void;
  select(id: string | null): void;
}

export interface AppHistory {
  /** The app may have changed its place: record it. Called whenever the view or the selection changed. */
  sync(): void;
  stop(): void;
}

export function installAppHistory(
  app: HistoryApp,
  win: NavWindow & { history: NavHistory },
): AppHistory {
  let last: Place | null = null;
  const nav: Nav<Place> = installNav<Place>({
    history: win.history,
    window: win,
    isState: isPlace,
    restore(place) {
      app.setView(place.view);
      // A task that is gone cannot be opened: the place is the view alone, and takes the entry it came from.
      const open = place.selectedId !== null && app.tasks.some((t) => t.id === place.selectedId);
      app.select(open ? place.selectedId : null);
      last = { view: place.view, selectedId: open ? place.selectedId : null };
      if (!open && place.selectedId !== null) nav.record(last, { replace: true });
    },
  });
  return {
    sync() {
      const now: Place = { view: app.view, selectedId: app.selectedId };
      // The open task vanished by itself (finished, moved away): that place is left, not a new step.
      const vanished =
        last !== null &&
        last.selectedId !== null &&
        now.selectedId === null &&
        last.view === now.view &&
        !app.tasks.some((t) => t.id === last?.selectedId);
      nav.record(now, vanished ? { replace: true } : undefined);
      last = now;
    },
    stop: () => nav.stop(),
  };
}
