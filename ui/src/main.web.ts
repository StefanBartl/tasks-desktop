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
import type { ListStore } from './lib/cache';
import { copyText, printSheet, saveText } from './lib/exportDom';
import { detectLang, translate } from './lib/i18n';
import { trackHistory } from './lib/trackHistory.svelte';
import { installTooltips } from 'appkit-ui/tooltip';
import { createBrowserHub, WorkerClient, type PortLike } from './web/client';
import { loadParts, startBlobWorker, type Parts } from './web/embedded';
import { Entry, mountFolder } from './web/entry';
import { idbKeyValue, RecentFolders, type DirHandle, type PickerWindow } from './web/folder';
import { vaultSignature } from './web/vault-files';
import WebEntry from './web/WebEntry.svelte';
import { watchVault } from './web/watch';

/** Where the vault lies in the engine's file system. */
const ROOT = '/vault';
/** The code the page trades for its session: the web hub takes any (there is no server to pair with). */
const CODE = 'web';

const target = document.getElementById('app') as HTMLElement;
const lang = detectLang(navigator.languages);

// Nothing of the tasks is kept in the browser until the data classes are read (the cache of a class that is not
// public or internal must not exist): no list cache, and a session that lives in memory only.
const noCache: ListStore = { load: async () => null, save: async () => {}, clear: async () => {} };
function memoryStorage(): Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> {
  const map = new Map<string, string>();
  return {
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => void map.set(key, String(value)),
    removeItem: (key) => void map.delete(key),
  };
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

let chosen: DirHandle | null = null;
let signature = '';

const entry = new Entry({
  win: window as unknown as PickerWindow,
  recent: new RecentFolders(idbKeyValue(window.indexedDB)),
  open: async (handle) => {
    const { client } = await started;
    const mounted = await mountFolder(client, ROOT, handle);
    chosen = handle;
    signature = await vaultSignature(handle);
    return mounted;
  },
  now: () => Date.now(),
});
const entryUi = mount(WebEntry, { target, props: { entry, lang } });

let began = false;
entry.subscribe((state) => {
  if (state.step === 'open' && !began) {
    began = true;
    void begin();
  }
});
void entry.start();

async function begin(): Promise<void> {
  const { client, parts } = await started;
  const handle = chosen as DirHandle;
  const lock = parts.bundle.engine;

  const web = createBrowserHub(client, {
    root: ROOT,
    version: __WEB_VERSION__,
    build: __WEB_BUILD__,
    pinned: { engine: lock.commit, lib: lock.lib_commit },
    // The app asks to read again when the window gets the focus back: the same look as the timer's.
    rescan: async () => {
      await watcher.check();
    },
  });
  const watcher = watchVault(signature, {
    signature: () => vaultSignature(handle),
    onChange: async () => {
      await mountFolder(client, ROOT, handle);
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
    cache: noCache,
    session: memoryStorage(),
    prefs: window.localStorage,
    preferredLanguages: navigator.languages,
    now: () => Date.now(),
    fetchFn,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    reload: () => window.location.reload(),
    out: {
      save: (name, text, type) => saveText(document, name, text, type),
      copy: (text) => copyText(navigator.clipboard, text),
      print: (sheet) => printSheet(document, window, sheet),
    },
  };
  const state = new AppState(env);
  installTooltips(document, window, { regionLabel: () => translate(state.lang, 'hint.region') });
  void unmount(entryUi);
  target.replaceChildren();
  mount(App, { target, props: { app: state, code: CODE } });
  trackHistory(state, window);
}
