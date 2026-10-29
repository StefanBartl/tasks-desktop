// The page of the web variant: one HTML file opened from disk, the engine in a worker, the vault a folder the person
// chose. No server and no pairing; the hub is `web/hub.ts`, which answers the routes of the Rust hub in the page.
//
// Order of events: the way in (WebEntry) is drawn at once while the engine starts in the background; the folder is read
// into the engine when it is chosen; then the app takes the place of the way in.

import { mount, unmount } from 'svelte';
import './app.css';
import App from './App.svelte';
import { Hub } from './lib/api';
import { App as AppState, type Env } from './lib/app.svelte';
import { indexedDbStore } from './lib/cache';
import { copyText, printSheet, saveText } from './lib/exportDom';
import { detectLang, translate } from './lib/i18n';
import { trackHistory } from './lib/trackHistory.svelte';
import { routedTask } from './lib/route';
import { followTaskRoute } from './lib/followRoute.svelte';
import { installTooltips } from 'appkit-ui/tooltip';
import { createBrowserHub, WorkerClient, type PortLike } from './web/client';
import { pageCache } from './web/page-cache';
import { forgetList } from './web/scoped-cache';
import { loadParts, startBlobWorker, type Parts } from './web/embedded';
import { Entry } from './web/entry';
import { idbKeyValue, RecentFolders, type PickerWindow } from './web/folder';
import { guardUnload, localDay, VaultSession } from './web/vault-session';
import type { WebHub } from './web/hub';
import WebEntry from './web/WebEntry.svelte';
import { watchVault, type Watcher } from './web/watch';

/** Where the vault lies in the engine's file system. */
const ROOT = '/vault';
/** The code the page trades for its session: the web hub takes any (there is no server to pair with). */
const CODE = 'web';

const target = document.getElementById('app') as HTMLElement;
const lang = detectLang(navigator.languages);
// A window a task was detached into names the task in the fragment (route.ts). It stays in the address while the window
// shows that task alone: there is no code to hide here, and a reload of that window opens the task again (once the
// folder is open). It leaves the address when the window lets go of the task (followRoute.svelte.ts).
const routed = routedTask(window.location.hash);

// What the page keeps in the browser is decided by the data classes of the folder (`areas.json`, web/classes.ts, wired in
// web/page-cache.ts). The app is made only after the folder and its classes were read (Entry.open, then `begin`), so
// there is no moment in which it keeps a list under classes it does not know; a folder the browser could not remember
// has no name to keep a list under and keeps none.
function memoryStorage(): Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> {
  const map = new Map<string, string>();
  return {
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => void map.set(key, String(value)),
    removeItem: (key) => void map.delete(key),
  };
}
/** The tab's session storage: it holds a word, not a secret (there is no server), and a tab that is reloaded keeps it. */
function tabStorage(): Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> {
  try {
    return window.sessionStorage;
  } catch {
    // Blocked by the browser: the page works, it just does not remember the tab's session across a reload.
    return memoryStorage();
  }
}

// The engine starts while the person is still choosing a folder.
const started: Promise<{ client: WorkerClient; parts: Parts }> = (async () => {
  const parts = await loadParts((id) => document.getElementById(id)?.textContent ?? null);
  const worker = startBlobWorker(parts.worker, { Blob, URL, Worker });
  const client = new WorkerClient(worker as unknown as PortLike);
  await client.init({ wasm: parts.wasm, bundle: parts.bundle, shim: parts.shim });
  return { client, parts };
})();
// A failed start is told where the person looks; this keeps it from being an unhandled rejection too.
started.catch(() => {});

// The vault the person opened: the folder, its copy in the engine and what the page knows of the files on disk.
let vault: VaultSession | null = null;
// The signature of the folder as the page knows it (taken before it was read): where the look at the folder starts.
let signature = '';
// The look at the folder (watch.ts). The session tells it the state of the folder after a write of its own, so that
// the page's own files are not taken for a change from outside.
let watcher: Watcher | null = null;
// The hub of the page, once the app runs: the session tells it when the data classes changed.
let hub: WebHub | null = null;

const entry = new Entry({
  win: window as unknown as PickerWindow,
  recent: new RecentFolders(idbKeyValue(window.indexedDB)),
  open: async (handle) => {
    const { client } = await started;
    const opened = new VaultSession({
      client,
      handle,
      root: ROOT,
      today: () => localDay(new Date()),
      onSignature: (known) => watcher?.accept(known),
      // The decisions of `areas.json` changed (or it could not be read): the app asks for the areas again.
      onClasses: () => hub?.notify({ classes: true }),
    });
    const mounted = await opened.load();
    signature = opened.knownSignature();
    vault = opened;
    return mounted;
  },
  now: () => Date.now(),
  // A folder that is forgotten takes its list with it (a list is kept per folder, by the id of the folder).
  forgotten: (id) => forgetList(indexedDbStore(window.indexedDB), id),
});
// A write is several calls on several files; closing the page in the middle of one cannot be taken back.
guardUnload(window, () => vault?.isWriting ?? false);

const entryUi = mount(WebEntry, { target, props: { entry, lang } });

let began = false;
entry.subscribe((state) => {
  if (state.step === 'open' && !began) {
    began = true;
    void begin(state.folder);
  }
});
void entry.start();

async function begin(folder: string | null): Promise<void> {
  const { client, parts } = await started;
  const session = vault as VaultSession;
  const lock = parts.bundle.engine;

  const web = createBrowserHub(client, {
    root: ROOT,
    // The class of each area, from the `areas.json` of the folder as the session read it last.
    classes: (area) => session.classOf(area),
    version: __WEB_VERSION__,
    build: __WEB_BUILD__,
    pinned: { engine: lock.commit, lib: lock.lib_commit },
    // The app asks to read again when the window gets the focus back: the same look as the timer's.
    rescan: async () => {
      await watcher?.check();
    },
    // Changes go through the engine into the folder (nothing is written when the folder moved on since it was read),
    // and a read waits for a write that is under way.
    ops: (request) => session.ops(request),
    idle: () => session.idle(),
  });
  hub = web;
  watcher = watchVault(signature, {
    signature: () => session.signature(),
    onChange: async () => {
      await session.reload();
      web.notify();
    },
    onError: () => {},
    setTimer: (fn, ms) => window.setInterval(fn, ms),
    clearTimer: (timer) => window.clearInterval(timer as number),
    onFocus: (listener) => {
      const visible = () => {
        if (document.visibilityState === 'visible') listener();
      };
      window.addEventListener('focus', listener);
      document.addEventListener('visibilitychange', visible);
      return () => {
        window.removeEventListener('focus', listener);
        document.removeEventListener('visibilitychange', visible);
      };
    },
  });

  const fetchFn = web.fetch;
  const env: Env = {
    hub: new Hub(fetchFn),
    // The list of this folder, in IndexedDB, while its areas are released.
    cache: pageCache(indexedDbStore(window.indexedDB), folder, (area) => session.classOf(area)),
    session: tabStorage(),
    prefs: window.localStorage,
    preferredLanguages: navigator.languages,
    now: () => Date.now(),
    fetchFn,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    reload: () => window.location.reload(),
    // The same file in a new window, at the task. The new window has its own engine: it asks for the folder again (a
    // folder used before is one click) and then shows the task.
    openWindow: (route) => window.open(`${window.location.pathname}${window.location.search}${route}`, '_blank') !== null,
    // Known here, not asked of the hub: nothing that needs the machine is shown, not even until an answer comes.
    mode: 'web',
    out: {
      save: (name, text, type) => saveText(document, name, text, type),
      copy: (text) => copyText(navigator.clipboard, text),
      print: (sheet) => printSheet(document, window, sheet),
    },
  };
  const state = new AppState(env);
  if (routed !== null) state.openRoute(routed);
  installTooltips(document, window, { regionLabel: () => translate(state.lang, 'hint.region') });
  void unmount(entryUi);
  target.replaceChildren();
  mount(App, { target, props: { app: state, code: CODE } });
  trackHistory(state, window);
  followTaskRoute(state, window);
}
