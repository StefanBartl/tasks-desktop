// The vault the page works on: the folder the person chose, its copy in the engine's VM, and what the page knows about
// the files on disk (the baseline). This is where a write (`ops`) happens, start to end:
//
//   the engine changes the VM's copy  ->  the changes are written to the folder, unless the folder moved on since it was
//   read (then nothing is written)  ->  the VM and the baseline take the written state over, or the folder is read again.
//
// Everything that reads the folder or changes the VM runs one at a time (`exclusive`): a re-read from the watcher must
// never replace the VM between the engine's change and its write-back, and a read must never see half of a write.
// Whenever a write does not end as `written`, the folder is read again and the VM replaced by what is on disk, so the
// page never keeps a state that is not in the folder. If even that read fails, the session is `stale` and the next
// write reads first.
//
// The watcher compares the folder with what the page knows. What the page knows is the scan taken BEFORE the folder was
// read (a change that lands while it is read still differs from it), moved on after a write only for the files the write
// touched: a foreign change to any other file stays a difference, and the watcher reads again.
//
// The engine cannot see a file the reader skipped (over the size cap, unreadable, a name that is not plain). A write
// then would rebuild the generated index without it and could pick the name of the skipped file for a new one, so while
// anything is skipped the session does not write.

import type { CallResult } from './engine.ts';
import type { MountedVault } from './entry.ts';
import type { OpsOutcome } from './hub.ts';
import {
  readVaultFolder,
  signatureOf,
  stampText,
  vaultStamps,
  type LoadLimits,
  type Skipped,
  type VaultChanges,
  type VaultStamps,
} from './vault-files.ts';
import { makeBaseline, writeBack, type Baseline, type Hash, type WritableDirHandle } from './write-back.ts';

/** What the session needs of the worker's client. */
export interface SessionClient {
  mount(root: string, files: Map<string, Uint8Array>): Promise<number>;
  call(method: string, request: string | null, opts: { root: string; today?: string }): Promise<CallResult>;
  pendingFiles(): Promise<{ changes: VaultChanges; files: Map<string, Uint8Array> }>;
  accept(changes: VaultChanges): Promise<void>;
}

export interface SessionDeps {
  client: SessionClient;
  /** The folder the person chose, with the permission to write. */
  handle: WritableDirHandle;
  /** Where the vault lies in the VM. */
  root: string;
  /** Today's date (YYYY-MM-DD) in the person's time zone: the engine dates its changes with it. */
  today(): string;
  hash?: Hash;
  limits?: Partial<LoadLimits>;
  /**
   * Told what the page knows of the folder after a write, and after the session read the folder again by itself (a write
   * that did not go through): the watcher must not report the page's own work as a change from outside, and must report
   * everything else.
   */
  onSignature?(signature: string): void;
}

/** The date of `now` in the local time zone, `YYYY-MM-DD`. */
export function localDay(now: Date): string {
  const two = (n: number) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${two(now.getMonth() + 1)}-${two(now.getDate())}`;
}

/** The part of the `beforeunload` event the guard uses. */
export interface UnloadEvent {
  preventDefault(): void;
  returnValue: unknown;
}

/**
 * Ask the browser to confirm before the page is closed or left while `busy()` is true. A write is several calls on
 * several files; a page that goes away in the middle of one cannot take it back.
 */
export function guardUnload(
  win: { addEventListener(type: 'beforeunload', listener: (event: UnloadEvent) => void): void },
  busy: () => boolean,
): void {
  win.addEventListener('beforeunload', (event) => {
    if (!busy()) return;
    event.preventDefault();
    // Some browsers still want a value to show the prompt.
    event.returnValue = '';
  });
}

function describe(error: unknown): string {
  const text = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  // eslint-disable-next-line no-control-regex
  return text.replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ').trim().slice(0, 160);
}

const nothing = () => {};

export class VaultSession {
  // Plain fields, no parameter properties: Node runs this file by stripping the types, without a build.
  private readonly deps: SessionDeps;
  private baseline: Baseline = new Map();
  // Sizes and times of the folder as the page knows them (null: the scan before the last read failed).
  private seen: VaultStamps | null = null;
  private skipped: Skipped[] = [];
  private stale = true;
  private tail: Promise<void> = Promise.resolve();
  private busy = 0;
  private writing = 0;

  constructor(deps: SessionDeps) {
    this.deps = deps;
  }

  /** The files of the folder as the page knows them (a copy; for tests and the status line). */
  known(): Baseline {
    return new Map(this.baseline);
  }

  /** True when the page's copy may not be what is on disk (a re-read failed): the next write reads first. */
  get isStale(): boolean {
    return this.stale;
  }

  /** True while a request of `ops` is waiting or being written: closing the page now could leave the folder half changed. */
  get isWriting(): boolean {
    return this.writing > 0;
  }

  /** The files the last read left out (too large, unreadable, a name that is not plain). Writes are off while any. */
  skippedFiles(): Skipped[] {
    return [...this.skipped];
  }

  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.tail.then(fn);
    this.busy += 1;
    this.tail = run.then(nothing, nothing).then(() => {
      this.busy -= 1;
    });
    return run;
  }

  /** Resolves when nothing is being written or read again; reads of the engine wait for it. */
  async idle(): Promise<void> {
    while (this.busy > 0) await this.tail;
  }

  /** The signature of the folder now (sizes and times, no content), for the watcher. */
  async signature(): Promise<string> {
    return signatureOf(await vaultStamps(this.deps.handle, this.deps.limits));
  }

  /**
   * The signature of the folder as the page knows it: where the watcher starts. Taken before the folder was read, so a
   * change that came in while it was read is not lost. Empty when that scan failed (the watcher then reads again).
   */
  knownSignature(): string {
    return this.seen ? signatureOf(this.seen) : '';
  }

  /** Read the folder and replace the VM's copy with it. */
  load(): Promise<MountedVault> {
    return this.exclusive(() => this.read());
  }

  /** Read the folder again (the watcher saw a change from outside). */
  async reload(): Promise<void> {
    await this.exclusive(async () => {
      await this.read();
    });
  }

  private async read(): Promise<MountedVault> {
    try {
      // Before the read, not after: what changes while the folder is read must differ from what the watcher compares to.
      const before = await vaultStamps(this.deps.handle, this.deps.limits).catch(() => null);
      const vault = await readVaultFolder(this.deps.handle, this.deps.limits);
      const baseline = await makeBaseline(vault, this.deps.hash);
      const files = await this.deps.client.mount(this.deps.root, vault.files);
      this.baseline = baseline;
      this.seen = before;
      this.skipped = vault.skipped;
      this.stale = false;
      return { files, skipped: vault.skipped };
    } catch (error) {
      this.stale = true;
      throw error;
    }
  }

  /** Read again after a write that did not end as written; a failure is only remembered (`stale`). */
  private async recover(): Promise<string | null> {
    try {
      await this.read();
      // The watcher compares against this: the folder was just read, so what it held then is not news.
      if (this.seen) this.deps.onSignature?.(signatureOf(this.seen));
      return null;
    } catch (error) {
      return describe(error);
    }
  }

  /**
   * The files a write touched are what the baseline says now (just read back); every other file stays as the page saw it,
   * so a foreign change to one of those still differs from what the watcher compares to.
   */
  private moveOn(changes: VaultChanges): void {
    if (!this.seen) return;
    for (const path of changes.removed) this.seen.delete(path);
    for (const path of [...changes.added, ...changes.modified]) {
      const entry = this.baseline.get(path);
      if (entry) this.seen.set(path, stampText(entry.size, entry.lastModified));
      else this.seen.delete(path);
    }
    this.deps.onSignature?.(signatureOf(this.seen));
  }

  /**
   * One request of `ops` (already judged by the hub): the engine changes the VM, the changes go to the folder. A dry run
   * and a request that changed nothing never touch the folder.
   */
  async ops(request: string): Promise<OpsOutcome> {
    this.writing += 1;
    try {
      return await this.exclusive(() => this.write(request));
    } finally {
      this.writing -= 1;
    }
  }

  private async write(request: string): Promise<OpsOutcome> {
    const { client, root } = this.deps;
    if (this.stale) {
      try {
        await this.read();
      } catch (error) {
        return { kind: 'failed', code: 'io', message: `the folder could not be read: ${describe(error)}` };
      }
    }
    const dry = (JSON.parse(request) as { dry_run?: unknown }).dry_run === true;
    if (!dry && this.skipped.length > 0) {
      const shown = this.skipped.slice(0, 3).map((s) => `${describe(s.path)} (${s.reason})`);
      const more = this.skipped.length > shown.length ? ` and ${this.skipped.length - shown.length} more` : '';
      return {
        kind: 'failed',
        code: 'forbidden',
        message: `nothing was written: the page could not read ${shown.join(', ')}${more}, so it does not see the whole vault; change tasks in Neovim or the app`,
      };
    }

    let result: CallResult;
    try {
      result = await client.call('ops', request, { root, today: this.deps.today() });
    } catch (error) {
      // The engine may have changed the VM before it failed: the VM is replaced by the folder.
      await this.recover();
      return { kind: 'failed', code: 'io', message: `the engine could not carry out the request: ${describe(error)}` };
    }

    let pending: { changes: VaultChanges; files: Map<string, Uint8Array> };
    try {
      pending = await client.pendingFiles();
    } catch (error) {
      await this.recover();
      return { kind: 'failed', code: 'io', message: `the changes could not be read: ${describe(error)}` };
    }
    const { changes, files } = pending;
    const empty = !changes.added.length && !changes.modified.length && !changes.removed.length;

    if (result.code !== null) {
      // The engine refused the request as a whole. What it may have done in the VM before it refused is not the folder.
      if (!empty) await this.recover();
      return { kind: 'refused', result };
    }
    if (empty) return { kind: 'done', text: result.text };
    if (dry) {
      await this.recover();
      return { kind: 'failed', code: 'internal', message: 'a dry run changed the vault in memory; nothing was written' };
    }

    const outcome = await writeBack({ root: this.deps.handle, baseline: this.baseline, changes, files, hash: this.deps.hash });
    if (outcome.status === 'written') {
      try {
        await client.accept(changes);
      } catch (error) {
        // The folder has the state; the VM is not told so. Read again rather than keep a VM that disagrees.
        this.stale = true;
        const why = await this.recover();
        if (why) return { kind: 'failed', code: 'io', message: `written, but the page could not read the folder again: ${why}` };
      }
      this.moveOn(changes);
      return { kind: 'done', text: result.text };
    }

    // Nothing, or not everything, was written: the VM holds a state the folder does not. The folder wins.
    const why = await this.recover();
    const readNote = why ? `; the folder could not be read again (${why}), read it by hand` : '';
    switch (outcome.status) {
      case 'conflict':
        return { kind: 'conflict', message: outcome.message + readNote };
      case 'refused':
        return { kind: 'failed', code: outcome.internal ? 'internal' : 'forbidden', message: outcome.message + readNote };
      case 'failed':
        return {
          kind: 'failed',
          code: outcome.undone ? 'io' : 'rollback_incomplete',
          message: outcome.message + readNote,
        };
    }
  }
}
