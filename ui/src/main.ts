import { mount } from 'svelte';
import './app.css';
import App from './App.svelte';
import { Hub } from './lib/api';
import { App as AppState, type Env } from './lib/app.svelte';
import { indexedDbStore } from './lib/cache';
import { copyText, saveText } from './lib/exportDom';
import { translate } from './lib/i18n';
import { trackHistory } from './lib/trackHistory.svelte';
import { takeInjected } from './lib/inject';
import { takePairingCode } from 'appkit-ui/pair';
import { installTooltips } from 'appkit-ui/tooltip';

// The native window has no address bar: its shell hands the code over as `window.__TASKS_PAIR`
// (an initialization script). The page takes it once and removes it.
const injected = takeInjected(window, '__TASKS_PAIR');

// The code leaves the address bar before anything else happens.
const code = takePairingCode(window.location, window.history, injected);

const fetchFn: typeof fetch = (input, init) => window.fetch(input, init);
const env: Env = {
  hub: new Hub(fetchFn),
  cache: indexedDbStore(window.indexedDB),
  session: window.sessionStorage,
  prefs: window.localStorage,
  preferredLanguages: navigator.languages,
  now: () => Date.now(),
  fetchFn,
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  reload: () => window.location.reload(),
  out: {
    save: (name, text, type) => saveText(document, name, text, type),
    copy: (text) => copyText(navigator.clipboard, text),
  },
};

const state = new AppState(env);
// The popup is the kit's; the name of its region is this page's word, in the page's language.
installTooltips(document, window, { regionLabel: () => translate(state.lang, 'hint.region') });
mount(App, { target: document.getElementById('app') as HTMLElement, props: { app: state, code } });

// Back and Forward of the browser walk through the views and the open tasks.
trackHistory(state, window);

// A link from `tasks-hub open` pasted into a tab that is already open changes only the fragment: no reload.
window.addEventListener('hashchange', () => {
  const later = takePairingCode(window.location, window.history);
  if (later) state.offerCode(later);
});
