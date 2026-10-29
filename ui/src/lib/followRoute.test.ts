import { describe, expect, it } from 'vitest';
import { taskRouteFollower, type RouteWindow } from './followRoute.svelte';

/** A window whose address only changes through `replaceState`, as the browser's. */
function windowAt(hash: string): RouteWindow & { replaced: { state: unknown; url: string }[] } {
  const location = { pathname: '/E:/x/tasks.html', search: '', hash };
  const replaced: { state: unknown; url: string }[] = [];
  return {
    location,
    history: {
      state: { view: 'list', selectedId: null },
      replaceState(state: unknown, _unused: string, url?: string | URL | null) {
        replaced.push({ state, url: String(url) });
        const at = String(url).indexOf('#');
        location.hash = at < 0 ? '' : String(url).slice(at);
      },
    },
    replaced,
  };
}

describe('the address of a window of one task (web variant)', () => {
  it('keeps the task while the window shows it alone, and lets go of it with the task', () => {
    const win = windowAt('#task=lib.nvim%2Fbeta');
    const follow = taskRouteFollower(win);
    // The folder is being chosen, the list read: the fragment is what the window waits for.
    follow(null);
    expect(win.location.hash).toBe('#task=lib.nvim%2Fbeta');
    follow('lib.nvim/beta');
    expect(win.replaced).toEqual([]);
    // Moved to another area: the window keeps it under its new id.
    follow('pub/beta');
    expect(win.location.hash).toBe('#task=pub%2Fbeta');
    // Escape, a view chosen: the window is a page of views, and a reload shows them. The place of the tab stays.
    follow(null);
    expect(win.location.hash).toBe('');
    expect(win.replaced.at(-1)).toEqual({ state: { view: 'list', selectedId: null }, url: '/E:/x/tasks.html' });
    follow(null);
    expect(win.replaced).toHaveLength(2);
  });

  it('leaves an address alone whose task was never shown', () => {
    const win = windowAt('#task=gone%2Fx');
    const follow = taskRouteFollower(win);
    follow(null);
    follow(null);
    expect(win.replaced).toEqual([]);
    expect(win.location.hash).toBe('#task=gone%2Fx');
  });
});
