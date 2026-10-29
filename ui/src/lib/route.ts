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
