// The pairing code travels in the URL fragment: it never goes to a server
// or a referrer. It is taken out of the address bar at once (concept 5.6).

export interface LocationLike {
  hash: string;
  pathname: string;
  search: string;
}

export interface HistoryLike {
  replaceState(data: unknown, unused: string, url?: string | URL | null): void;
}

const CODE = /^[0-9a-f]{32,128}$/;

/** The pairing code in the fragment, if there is one. Removes the fragment. */
export function takePairingCode(location: LocationLike, history: HistoryLike): string | null {
  const hash = location.hash.startsWith('#') ? location.hash.slice(1) : location.hash;
  if (hash === '') return null;
  let code: string | null = null;
  for (const part of hash.split('&')) {
    const [key, value] = part.split('=');
    if (key === 'pair' && value && CODE.test(value)) code = value;
  }
  // Whatever the fragment held, it is not left in the history.
  history.replaceState(null, '', location.pathname + location.search);
  return code;
}
