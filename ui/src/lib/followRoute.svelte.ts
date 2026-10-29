import { withTaskRoute } from './route';

/** What the address follows of the app. */
export interface RouteApp {
  /** The window shows one task alone (route.ts). */
  readonly solo: boolean;
  readonly selectedId: string | null;
}

/** The parts of the window the address is changed through. */
export interface RouteWindow {
  location: Pick<Location, 'pathname' | 'search' | 'hash'>;
  history: Pick<History, 'state' | 'replaceState'>;
}

/**
 * The step of `followTaskRoute`: told the task the window shows alone (null: none), it sets the address. Until the
 * window has shown a task (the folder is being chosen, the list read), the fragment is left as it is: it is what the
 * window waits for.
 */
export function taskRouteFollower(win: RouteWindow): (alone: string | null) => void {
  let shown = false;
  return (alone) => {
    if (alone !== null) shown = true;
    if (!shown) return;
    const hash = withTaskRoute(win.location.hash, alone);
    if (hash === win.location.hash) return;
    // The place of the tab lives in `history.state` (history.ts): it stays, only the address changes.
    win.history.replaceState(win.history.state, '', `${win.location.pathname}${win.location.search}${hash}`);
  };
}

/**
 * The web variant keeps `#task=<id>` in the address of a window of one task, so that a reload opens the task again.
 * Once the window lets go of it (Escape, a view chosen, the task gone), the fragment leaves the address: a reload then
 * shows the views. A task taken to another area keeps its window under its new id.
 */
export function followTaskRoute(app: RouteApp, win: RouteWindow): () => void {
  const follow = taskRouteFollower(win);
  return $effect.root(() => {
    $effect(() => follow(app.solo ? app.selectedId : null));
  });
}
