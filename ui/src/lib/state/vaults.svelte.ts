// The vaults the hub can read: the list, the dialog that manages them, and the steps it takes (choose, add, remove) with the
// word each one says. A part of the state of the page of its own. What a choice of another vault does to the rest of the
// page (the cache, the filter, loading again) is the page's; it passes that to `select`.

import { ApiError, type VaultList } from '../api';

/** What the vaults need of the page around it. */
export interface VaultsHost {
  ready(): boolean;
  vaults(): Promise<VaultList>;
  selectVault(name: string): Promise<void>;
  addVault(name: string, path: string): Promise<void>;
  removeVault(name: string): Promise<void>;
  /** A word to the person: a success (`ok`) or a refusal with the hub's message. */
  say(kind: 'ok' | 'error', key: 'vaults.added' | 'vaults.removed' | 'vaults.failed', params?: Record<string, string>): void;
}

/** How a read of the list ended: the list is there, the hub has no list (a hub with one vault), or it did not answer. */
export type VaultsRead = 'ok' | 'none' | 'failed';

export class VaultsState {
  /** The vaults the hub offers (`null`: none known, or the hub has no list). */
  list = $state.raw<VaultList | null>(null);
  /** The dialog that manages them is open. */
  managing = $state(false);
  /** A step is on its way: no second one beside it. */
  busy = $state(false);
  /** The list could not be read (not: the hub has none); the page says so where it needs the name. */
  failed = $state(false);

  constructor(private readonly host: VaultsHost) {}

  open(): void {
    if (this.host.ready() && this.list) this.managing = true;
  }

  close(): void {
    this.managing = false;
  }

  /** Read the list. */
  async read(): Promise<VaultsRead> {
    try {
      this.list = await this.host.vaults();
      this.failed = false;
      return 'ok';
    } catch (error) {
      this.list = null;
      const none = error instanceof ApiError && error.status === 404;
      // Any other answer (a hub that errs, a network that fails) leaves the vault unknown; the next read of the list asks
      // again, and the page says so where it needs the name (the lists).
      this.failed = !none;
      return none ? 'none' : 'failed';
    }
  }

  /** One step at a time; a refusal of the hub is said with its words. */
  private async step(work: () => Promise<void>, ok?: 'vaults.added' | 'vaults.removed'): Promise<boolean> {
    if (this.busy) return false;
    this.busy = true;
    try {
      await work();
      if (ok) this.host.say('ok', ok);
      return true;
    } catch (error) {
      this.host.say('error', 'vaults.failed', { message: error instanceof ApiError ? error.message : '' });
      return false;
    } finally {
      this.busy = false;
    }
  }

  /** Choose another vault; `before` is what the page does before the hub's answer is taken (the cache, the filter). */
  select(name: string, before: () => Promise<void>): Promise<boolean> {
    return this.step(async () => {
      await this.host.selectVault(name);
      await before();
    });
  }

  add(name: string, path: string): Promise<boolean> {
    return this.step(async () => {
      await this.host.addVault(name.trim(), path.trim());
      this.list = await this.host.vaults();
    }, 'vaults.added');
  }

  async remove(name: string): Promise<void> {
    await this.step(async () => {
      await this.host.removeVault(name);
      this.list = await this.host.vaults();
    }, 'vaults.removed');
  }
}
