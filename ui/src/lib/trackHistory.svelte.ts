import type { NavHistory, NavWindow } from 'appkit-ui/nav';
import type { App } from './app.svelte';
import { installAppHistory } from './history';

/** Make every change of the view or of the open task an entry of the history of the tab. */
export function trackHistory(app: App, win: NavWindow & { history: NavHistory }): () => void {
  const history = installAppHistory(app, win);
  const stopEffect = $effect.root(() => {
    $effect(() => {
      // Only the place is watched; reading the list for it (a vanished task) happens untracked.
      void app.view;
      void app.selectedId;
      void app.peeking;
      history.sync();
    });
  });
  return () => {
    stopEffect();
    history.stop();
  };
}
