// A task in a window of its own: the float of a task can be detached into a new window of the same page, which opens
// at that task. The page has no routes in its address (the places of the tab live in `history.state`); the new window
// is told the task in the fragment, `#task=<id>`, which the page takes out of the address at once (as the pairing
// code: the fragment never reaches a server). The web variant keeps it while the window shows the task alone
// (followRoute.svelte.ts).

/** The longest id the fragment is taken for (an id is an area and a name; nothing real is near this). */
const MAX_ID = 300;

/** The fragment that opens the task `id`. */
export function taskRoute(id: string): string {
  return `#task=${encodeURIComponent(id)}`;
}

/**
 * The fragment `hash` with its task part set to `id`, or taken out for null; the other parts of the fragment stay.
 * Empty when nothing is left.
 */
export function withTaskRoute(hash: string, id: string | null): string {
  const text = hash.startsWith('#') ? hash.slice(1) : hash;
  const rest = text.split('&').filter((part) => part !== '' && part.split('=')[0] !== 'task');
  const parts = id === null ? rest : [taskRoute(id).slice(1), ...rest];
  return parts.length === 0 ? '' : `#${parts.join('&')}`;
}

/** The task a fragment names, or null (another fragment, a broken one, or an id that cannot be one). */
export function routedTask(hash: string): string | null {
  const text = hash.startsWith('#') ? hash.slice(1) : hash;
  for (const part of text.split('&')) {
    const at = part.indexOf('=');
    if (at < 0 || part.slice(0, at) !== 'task') continue;
    let id: string;
    try {
      id = decodeURIComponent(part.slice(at + 1));
    } catch {
      return null;
    }
    id = id.trim();
    // An id is one line of printable text.
    if (id === '' || id.length > MAX_ID || /[\u0000-\u001f\u007f]/.test(id)) return null;
    return id;
  }
  return null;
}

// A view in a new tab: a middle click (Ctrl+click, Ctrl+Enter) on a view of the menu opens the same page in a new
// window at that view, `#view=<name>`. It is read once at the start, as the view the page was left on is, and is not
// kept: a reload, and the other tabs, open on the view of their own.

/** The views a fragment may name (the `View` of app.svelte.ts). */
const VIEWS = ['today', 'list', 'board', 'plan', 'inbox', 'abnahme', 'cross', 'done', 'views'] as const;
export type RoutedView = (typeof VIEWS)[number];

/** The fragment that opens the view `view`. */
export function viewRoute(view: RoutedView): string {
  return `#view=${view}`;
}

/** The view a fragment names, or null (none, or a name that is no view). */
export function routedView(hash: string): RoutedView | null {
  const text = hash.startsWith('#') ? hash.slice(1) : hash;
  for (const part of text.split('&')) {
    const at = part.indexOf('=');
    if (at < 0 || part.slice(0, at) !== 'view') continue;
    const name = part.slice(at + 1);
    return (VIEWS as readonly string[]).includes(name) ? (name as RoutedView) : null;
  }
  return null;
}

/** The fragment `hash` without its view part; the other parts stay. Empty when nothing is left. */
export function withoutViewRoute(hash: string): string {
  const text = hash.startsWith('#') ? hash.slice(1) : hash;
  const rest = text.split('&').filter((part) => part !== '' && part.split('=')[0] !== 'view');
  return rest.length === 0 ? '' : `#${rest.join('&')}`;
}
