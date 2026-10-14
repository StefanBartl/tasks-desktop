import { mount } from 'svelte';
import './app.css';
import App from './App.svelte';
import { Hub } from './lib/api';
import { App as AppState, type Env } from './lib/app.svelte';
import { indexedDbStore } from './lib/cache';
import { takePairingCode } from './lib/pair';
import { installTooltips } from './lib/tooltip';

// The code leaves the address bar before anything else happens.
const code = takePairingCode(window.location, window.history);

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
};

installTooltips(document, window);

const state = new AppState(env);
mount(App, { target: document.getElementById('app') as HTMLElement, props: { app: state, code } });

// A link from `tasks-hub open` pasted into a tab that is already open changes only the fragment: no reload.
window.addEventListener('hashchange', () => {
  const later = takePairingCode(window.location, window.history);
  if (later) state.offerCode(later);
});
