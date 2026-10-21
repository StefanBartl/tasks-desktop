// The saved views and the groupings they are drawn with: what the vault holds (`tasks.views`), which one is open, and the
// fields of the engine (`tasks.groupings`) for the state of the list that is shown. A part of the state of the page of its
// own (the page, `App`, holds it and passes the few things it needs through `ViewsHost`). Every change goes through the
// one write of the page; this only says which operation it is.

import { ApiError, type Op } from '../api';
import type { Groupings, Result, View, Views } from '../contract';
import { createOp, deleteOp, saveOp, toggledGroup, type ViewForm } from '../views';

/** What the views need of the page around them. */
export interface ViewsHost {
  can(capability: string): boolean;
  /** The rev of the snapshot the page holds now. */
  rev(): string | undefined;
  views(): Promise<Views>;
  groupings(): Promise<Groupings>;
  write(ops: Op[]): Promise<Result | null>;
  /** The view that was open last, as the browser keeps it (null: none, or one that may not be kept). */
  remembered(): string | null;
  remember(id: string | null): void;
}

export class ViewsState {
  /** The views of the vault as last read, or null before the first answer. */
  doc = $state.raw<Views | null>(null);
  /** The last read of the views failed (the page says so instead of "no views"). */
  failed = $state(false);
  /** The groupings as last read; shown only for the state of the list they were read of (`groupingsNow`). */
  groupings = $state.raw<Groupings | null>(null);
  groupingsFailed = $state(false);
  /** The id of the view that is open (null: the first one). */
  openId = $state<string | null>(null);
  private seq = 0;
  /** The rev the groupings are being asked for. */
  private groupingsAsked: string | null = null;

  constructor(private readonly host: ViewsHost) {
    this.openId = host.remembered();
  }

  get list(): View[] {
    return this.doc?.views ?? [];
  }

  /** The view that is shown: the one chosen, or the first when that one is gone (or none was chosen). */
  get open(): View | null {
    const list = this.list;
    return list.find((v) => v.id === this.openId) ?? list[0] ?? null;
  }

  /** The groupings of the state of the list that is shown, or null (an older state is never drawn as the current one). */
  get groupingsNow(): Groupings | null {
    const rev = this.host.rev();
    return this.groupings !== null && rev !== undefined && this.groupings.rev === rev ? this.groupings : null;
  }

  choose(id: string): void {
    this.openId = id;
    this.host.remember(id);
  }

  /** Read the views of the vault. An answer to an older question is dropped (a newer one is on its way). */
  async load(): Promise<void> {
    if (!this.host.can('views')) return;
    this.seq += 1;
    const seq = this.seq;
    try {
      const doc = await this.host.views();
      if (seq !== this.seq) return;
      this.doc = doc;
      this.failed = false;
    } catch (error) {
      if (seq !== this.seq) return;
      // A session that is gone is the page's to tell (it pairs again); the views that were read stay meanwhile.
      if (error instanceof ApiError && error.status === 401) return;
      this.failed = true;
    }
  }

  /** The groupings for the state of the list that is shown, once per state. */
  async loadGroupings(): Promise<void> {
    const rev = this.host.rev();
    if (!this.host.can('groupings') || rev === undefined || this.groupings?.rev === rev) return;
    // One question per state: a read that arrives while the answer is on its way does not ask again.
    if (this.groupingsAsked === rev) return;
    this.groupingsAsked = rev;
    try {
      const doc = await this.host.groupings();
      // An answer for a state that has gone by meanwhile is not kept; the next read asks again.
      if (this.host.rev() === doc.rev) {
        this.groupings = doc;
        this.groupingsFailed = false;
      }
    } catch {
      this.groupingsFailed = true;
    } finally {
      if (this.groupingsAsked === rev) this.groupingsAsked = null;
    }
  }

  /** What was asked is not valid any more (another vault): the answers on their way are dropped, and what was read. */
  forget(): void {
    this.seq += 1;
    this.doc = null;
    this.groupings = null;
    this.groupingsAsked = null;
  }

  /** Make a view in `area`; it is the one shown once it is made. */
  async create(area: string, form: ViewForm): Promise<boolean> {
    const result = await this.host.write([createOp(area, form)]);
    const made = result?.results[0];
    if (!made?.ok || made.id === undefined) return false;
    this.choose(made.id);
    return true;
  }

  /** Change `view` to `form` (on the version that was read). */
  async save(view: View, form: ViewForm): Promise<boolean> {
    const result = await this.host.write([saveOp(view, form)]);
    return result?.results[0]?.ok === true;
  }

  /** Fold the group `value` of `view`, or open it: the view keeps its folds in its file. */
  toggle(view: View, form: ViewForm, value: string): Promise<boolean> {
    return this.save(view, { ...form, collapsed: toggledGroup(form.collapsed ?? [], value) });
  }

  async remove(view: View): Promise<boolean> {
    const result = await this.host.write([deleteOp(view)]);
    return result?.results[0]?.ok === true;
  }
}
