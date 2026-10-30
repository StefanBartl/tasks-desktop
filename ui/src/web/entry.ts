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
import { inputFolderSupport, pickFolderByInput, type InputDocument } from './folder-input.ts';
import { readVaultFolder, VaultLimitError, type DirHandleLike, type Skipped } from './vault-files.ts';

export type Access = 'granted' | 'prompt' | 'denied' | 'gone';

export interface RecentView {
  id: string;
  name: string;
  access: Access;
}

/** Why the last attempt did not lead into a vault. `detail` is a short plain line of the browser or the reader. */
export interface Notice {
  code: 'cancelled' | 'empty' | 'no_paths' | 'blocked' | 'failed' | 'denied' | 'gone' | 'limit';
  detail?: string;
}

export type EntryState =
  | { step: 'starting' }
  | { step: 'unsupported'; reason: 'missing' | 'insecure' }
  /** `readOnly`: this browser has no folder picker (Firefox, Safari), the folder is read through an input and not written. */
  | { step: 'choose'; recent: RecentView[]; notice: Notice | null; readOnly: boolean }
  | { step: 'opening'; name: string }
  /**
   * `folder` is the id the folders used before give this one (`null`: the browser could not keep it): what the page keeps
   * for this folder alone, its list cache, is named by it. The engine's `vault.id` is the name of the mount point and is
   * the same for every folder, so it cannot tell two folders apart.
   */
  | { step: 'open'; name: string; files: number; skipped: Skipped[]; folder: string | null; readOnly: boolean };

export interface MountedVault {
  files: number;
  skipped: Skipped[];
}

export interface EntryDeps {
  win: PickerWindow;
  recent: RecentFolders;
  /**
   * Read the folder and put it into the engine; the page passes `mountFolder` over its worker client. `readOnly`: the
   * folder came through an input, it has no handle to write to.
   */
  open(handle: DirHandleLike, readOnly: boolean): Promise<MountedVault>;
  now(): number;
  /**
   * A folder used before was forgotten: the page drops what it kept for it besides the handle (its list cache). It is a
   * convenience like the list of folders: a failure must not keep the folder in the list.
   */
  forgotten?(id: string): Promise<void>;
}

/** Read a folder and mount it at `root` of the engine's file system. */
export async function mountFolder(
  client: { mount(root: string, files: Map<string, Uint8Array>): Promise<number> },
  root: string,
  handle: DirHandleLike,
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
  // Whether the folder is chosen through an input (no picker in this browser); decided by `start`.
  private readOnly = false;
  // A dialog of the input is open: a second click must not open another one (and read a second vault).
  private picking = false;

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
    // No picker, but an input that takes a folder: the vault can be read, not written (stage 1 of the other browsers).
    if (support === 'missing' && inputFolderSupport(this.deps.win.document)) {
      this.readOnly = true;
      this.set({ step: 'choose', recent: [], notice, readOnly: true });
      return;
    }
    this.readOnly = false;
    if (support !== 'ok') {
      this.set({ step: 'unsupported', reason: support });
      return;
    }
    const recent: RecentView[] = [];
    for (const entry of await this.deps.recent.list()) {
      recent.push({ id: entry.id, name: entry.name, access: await permissionOf(entry.handle) });
    }
    this.set({ step: 'choose', recent, notice, readOnly: false });
  }

  /** From the click on "Choose folder". */
  async pick(): Promise<void> {
    if (this.readOnly) {
      if (this.picking) return;
      this.picking = true;
      try {
        return await this.pickByInput();
      } finally {
        this.picking = false;
      }
    }
    const result = await pickFolder(this.deps.win);
    if (result.kind === 'cancelled') return this.start({ code: 'cancelled' });
    if (result.kind === 'blocked') return this.start({ code: 'blocked', detail: result.message });
    if (result.kind === 'failed') return this.start({ code: 'failed', detail: result.message });
    await this.enter(result.handle, false);
  }

  private async pickByInput(): Promise<void> {
    // Still inside the click: nothing that waits comes before the input is opened.
    const result = await pickFolderByInput(this.deps.win.document as InputDocument);
    if (result.kind === 'cancelled') return this.start({ code: 'cancelled' });
    if (result.kind === 'empty') return this.start({ code: 'empty' });
    if (result.kind === 'no_paths') return this.start({ code: 'no_paths' });
    if (result.kind === 'failed') return this.start({ code: 'failed', detail: result.message });
    await this.enter(result.folder, true);
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
    await this.enter(entry.handle, false);
  }

  async forget(id: string): Promise<void> {
    await this.deps.recent.forget(id);
    try {
      await this.deps.forgotten?.(id);
    } catch {
      // the folder is out of the list; what the page kept for it is a miss at worst
    }
    await this.start();
  }

  private async enter(handle: DirHandleLike, readOnly: boolean): Promise<void> {
    this.set({ step: 'opening', name: handle.name });
    try {
      const mounted = await this.deps.open(handle, readOnly);
      // The list of folders used before is a convenience: a browser that cannot keep it (a private window, a full
      // quota, a handle that does not clone) must not keep the person out of a vault that was read. A folder read
      // through an input has no handle to keep: it is asked for again on every visit and keeps no list of its own.
      let folder: string | null = null;
      if (!readOnly) {
        try {
          folder = (await this.deps.recent.remember(handle as DirHandle, this.deps.now())).id;
        } catch {
          // the next start simply does not list this folder
        }
      }
      this.set({ step: 'open', name: handle.name, files: mounted.files, skipped: mounted.skipped, folder, readOnly });
    } catch (error) {
      const name = typeof error === 'object' && error !== null ? (error as { name?: unknown }).name : undefined;
      if (error instanceof VaultLimitError) return this.start({ code: 'limit', detail: error.message });
      if (name === 'NotFoundError') return this.start({ code: 'gone' });
      if (name === 'NotAllowedError' || name === 'SecurityError') return this.start({ code: 'denied' });
      return this.start({ code: 'failed', detail: oneLine(error) });
    }
  }
}
