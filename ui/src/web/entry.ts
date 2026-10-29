// The way in of the web variant: choose a folder or take one used before, get the permission back after a restart, read
// the vault into the engine's file system. A small state machine without a DOM; the page (WebEntry.svelte) draws its
// state and calls its methods from clicks.

import {
  grantAccess,
  permissionOf,
  pickFolder,
  pickerSupport,
  oneLine,
  type DirHandle,
  type PickerWindow,
  type RecentFolders,
} from './folder.ts';
import { readVaultFolder, VaultLimitError, type Skipped } from './vault-files.ts';

export type Access = 'granted' | 'prompt' | 'denied' | 'gone';

export interface RecentView {
  id: string;
  name: string;
  access: Access;
}

/** Why the last attempt did not lead into a vault. `detail` is a short plain line of the browser or the reader. */
export interface Notice {
  code: 'cancelled' | 'blocked' | 'failed' | 'denied' | 'gone' | 'limit';
  detail?: string;
}

export type EntryState =
  | { step: 'starting' }
  | { step: 'unsupported'; reason: 'missing' | 'insecure' }
  | { step: 'choose'; recent: RecentView[]; notice: Notice | null }
  | { step: 'opening'; name: string }
  | { step: 'open'; name: string; files: number; skipped: Skipped[] };

export interface MountedVault {
  files: number;
  skipped: Skipped[];
}

export interface EntryDeps {
  win: PickerWindow;
  recent: RecentFolders;
  /** Read the folder and put it into the engine; the page passes `mountFolder` over its worker client. */
  open(handle: DirHandle): Promise<MountedVault>;
  now(): number;
}

/** Read a folder and mount it at `root` of the engine's file system. */
export async function mountFolder(
  client: { mount(root: string, files: Map<string, Uint8Array>): Promise<number> },
  root: string,
  handle: DirHandle,
): Promise<MountedVault> {
  const vault = await readVaultFolder(handle);
  const files = await client.mount(root, vault.files);
  return { files, skipped: vault.skipped };
}

export class Entry {
  // Plain fields, no parameter properties: Node runs this file by stripping the types, without a build.
  private readonly deps: EntryDeps;
  private current: EntryState = { step: 'starting' };
  private readonly listeners = new Set<(state: EntryState) => void>();

  constructor(deps: EntryDeps) {
    this.deps = deps;
  }

  get state(): EntryState {
    return this.current;
  }

  subscribe(listener: (state: EntryState) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private set(state: EntryState): void {
    this.current = state;
    for (const listener of [...this.listeners]) listener(state);
  }

  /** The first look: can this page choose a folder, and which ones were used before. */
  async start(notice: Notice | null = null): Promise<void> {
    const support = pickerSupport(this.deps.win);
    if (support !== 'ok') {
      this.set({ step: 'unsupported', reason: support });
      return;
    }
    const recent: RecentView[] = [];
    for (const entry of await this.deps.recent.list()) {
      recent.push({ id: entry.id, name: entry.name, access: await permissionOf(entry.handle) });
    }
    this.set({ step: 'choose', recent, notice });
  }

  /** From the click on "Choose folder". */
  async pick(): Promise<void> {
    const result = await pickFolder(this.deps.win);
    if (result.kind === 'cancelled') return this.start({ code: 'cancelled' });
    if (result.kind === 'blocked') return this.start({ code: 'blocked', detail: result.message });
    if (result.kind === 'failed') return this.start({ code: 'failed', detail: result.message });
    await this.enter(result.handle);
  }

  /** From the click on a folder used before. Asks for the permission first when the browser dropped it. */
  async openRecent(id: string): Promise<void> {
    const entry = (await this.deps.recent.list()).find((e) => e.id === id);
    if (!entry) return this.start();
    // The click is the user gesture `requestPermission` needs: nothing that waits comes before it.
    let access = await permissionOf(entry.handle);
    if (access === 'prompt') access = await grantAccess(entry.handle);
    if (access === 'gone') return this.start({ code: 'gone' });
    if (access !== 'granted') return this.start({ code: 'denied' });
    await this.enter(entry.handle);
  }

  async forget(id: string): Promise<void> {
    await this.deps.recent.forget(id);
    await this.start();
  }

  private async enter(handle: DirHandle): Promise<void> {
    this.set({ step: 'opening', name: handle.name });
    try {
      const mounted = await this.deps.open(handle);
      await this.deps.recent.remember(handle, this.deps.now());
      this.set({ step: 'open', name: handle.name, files: mounted.files, skipped: mounted.skipped });
    } catch (error) {
      const name = typeof error === 'object' && error !== null ? (error as { name?: unknown }).name : undefined;
      if (error instanceof VaultLimitError) return this.start({ code: 'limit', detail: error.message });
      if (name === 'NotFoundError') return this.start({ code: 'gone' });
      if (name === 'NotAllowedError' || name === 'SecurityError') return this.start({ code: 'denied' });
      return this.start({ code: 'failed', detail: oneLine(error) });
    }
  }
}
