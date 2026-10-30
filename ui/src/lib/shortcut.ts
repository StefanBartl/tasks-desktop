// A shortcut to the page of the web variant (one file opened from disk). A page cannot write to the desktop or the
// Start menu, and Chrome saves a downloaded `.lnk` or `.url` as `.download` (it never hands out a file the shell runs
// by its name). So the page gives the line for Windows' own "New > Shortcut": the address for the default browser, or
// Chrome with `--app=<address>` for a window of its own. The start script of tasks-web (`start-tasks.cmd /shortcut`)
// makes the same link and finds Chrome itself.

/** Where Chrome's installer puts it for all users; a Chrome installed for one user lives under AppData instead. */
export const CHROME_PATH = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

/** The address the shortcut opens: the page itself, without what follows `#` (a task, a view). */
export function pageAddress(href: string): string {
  const at = href.indexOf('#');
  return at === -1 ? href : href.slice(0, at);
}

/** The target of a shortcut that opens `address` in a window of Chrome of its own (a quote kept out of the argument). */
export function chromeTarget(address: string): string {
  return `"${CHROME_PATH}" --app=${address.replaceAll('"', '%22').replaceAll(' ', '%20')}`;
}
