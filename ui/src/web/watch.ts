// The web variant has no server to tell the page that a file changed. The page looks itself: when the window gets the
// focus back and every 30 seconds it asks for the signature of the folder (sizes and times, no content) and, when it
// differs from the one it read, reads the vault again.

export interface WatchDeps {
  /** The signature of the folder now (`vaultSignature`). */
  signature(): Promise<string>;
  /** The folder is not what was read: read it again and tell the page. */
  onChange(): void | Promise<void>;
  /** A look failed (the folder is gone, the permission was taken back). The watcher goes on. */
  onError?(error: unknown): void;
  intervalMs?: number;
  setTimer(fn: () => void, ms: number): unknown;
  clearTimer(handle: unknown): void;
  /** Call `listener` when the window gets the focus back (or the tab becomes visible); returns the way to stop. */
  onFocus(listener: () => void): () => void;
}

export interface Watcher {
  /** Look now. Resolves true when the folder differs and `onChange` ran. */
  check(): Promise<boolean>;
  /** The vault was read again by someone else: this is the state to compare against from now on. */
  accept(signature: string): void;
  stop(): void;
}

export const WATCH_MS = 30_000;

/** Start watching. `known` is the signature of the folder as it was read. */
export function watchVault(known: string, deps: WatchDeps): Watcher {
  let last = known;
  let looking = false;
  let stopped = false;

  async function check(): Promise<boolean> {
    // One look at a time: a slow folder must not pile up looks, and a change must not be told twice.
    if (looking || stopped) return false;
    looking = true;
    try {
      const now = await deps.signature();
      if (stopped || now === last) return false;
      last = now;
      await deps.onChange();
      return true;
    } catch (error) {
      deps.onError?.(error);
      return false;
    } finally {
      looking = false;
    }
  }

  const timer = deps.setTimer(() => void check(), deps.intervalMs ?? WATCH_MS);
  const unfocus = deps.onFocus(() => void check());
  return {
    check,
    accept(signature) {
      last = signature;
    },
    stop() {
      stopped = true;
      deps.clearTimer(timer);
      unfocus();
    },
  };
}
