// The saved views and the groupings they are drawn with: what the vault holds (`tasks.views`), which one is open, and the
// fields of the engine (`tasks.groupings`) for the state of the list that is shown. A part of the state of the page of its
// own (the page, `App`, holds it and passes the few things it needs through `ViewsHost`). Every change goes through the
// one write of the page; this only says which operation it is.

import { ApiError, type Op } from '../api';
import type { Groupings, Result, View, Views } from '../contract';
import { createOp, deleteOp, emptySelect, saveOp, toggledGroup, type ViewForm } from '../views';

/** The id of the view being tried (opened from a context menu and not saved yet): no file has it. */
export const DRAFT_ID = '';

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
  /** The page shows the vault read only: a fold of a group stays in the page, the view's file is not written. */
  readOnly?(): boolean;
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
  /**
   * A view being tried: opened from a context menu, not saved. It is shown until a saved one is chosen; a change of it
   * stays in the page (no file is written for a look), and saving it makes it a view of the vault.
   */
  draft = $state.raw<View | null>(null);
  /** The tab takes the focus once, onto the view that was opened from a menu (the menu and its element are gone). */
  wantsFocus = $state(false);
  private seq = 0;
  /** Counts the times what was read was forgotten: an answer to a question asked before is dropped. */
  private generation = 0;
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
    if (this.draft) return this.draft;
    const list = this.list;
    return list.find((v) => v.id === this.openId) ?? list[0] ?? null;
  }

  /** The groupings of the state of the list that is shown, or null (an older state is never drawn as the current one). */
  get groupingsNow(): Groupings | null {
    const rev = this.host.rev();
    return this.groupings !== null && rev !== undefined && this.groupings.rev === rev ? this.groupings : null;
  }

  /**
   * The groupings the tab draws with: those of the state shown, or - while the ones of a newer state are asked for -
   * the last ones of this vault, so the groups do not vanish (and take the focus with them) after every change.
   */
  get groupingsShown(): Groupings | null {
    return this.groupingsNow ?? this.groupings;
  }

  choose(id: string): void {
    this.draft = null;
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
    const generation = this.generation;
    try {
      const doc = await this.host.groupings();
      if (generation !== this.generation) return;
      // An answer for a state that has gone by meanwhile is not kept; the next read asks again. Unless none is held yet:
      // it is what `groupingsShown` draws with until the newer one comes (the board asks only when it is opened, and its
      // bar would else stay without fields after a change of the vault during the question); `groupingsNow` stays null.
      if (this.host.rev() === doc.rev || this.groupings === null) {
        this.groupings = doc;
        this.groupingsFailed = false;
      }
    } catch {
      if (generation === this.generation) this.groupingsFailed = true;
    } finally {
      if (this.groupingsAsked === rev) this.groupingsAsked = null;
    }
  }

  /** The session is gone: the answers on their way are dropped, and what was read (it is read again after pairing). */
  forget(): void {
    this.seq += 1;
    this.generation += 1;
    this.doc = null;
    this.failed = false;
    this.groupings = null;
    this.groupingsFailed = false;
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

  /** Show `form` as a view being tried (nothing is written). */
  try(form: ViewForm): void {
    this.draft = {
      id: DRAFT_ID,
      area: '',
      title: form.title,
      display: form.display,
      group_by: form.group_by,
      ...(form.group_by2 !== undefined ? { group_by2: form.group_by2 } : {}),
      collapsed: [...(form.collapsed ?? [])],
      select: { ...emptySelect(), ...form.select },
      etag: '',
    };
  }

  /** Change `view` to `form` (on the version that was read); the view being tried changes in the page only. */
  async save(view: View, form: ViewForm): Promise<boolean> {
    if (view.id === DRAFT_ID) {
      this.try(form);
      return true;
    }
    const result = await this.host.write([saveOp(view, form)]);
    return result?.results[0]?.ok === true;
  }

  /** The folds of the page for views it may not write (read only), by the id of the view. */
  folds = $state<Record<string, string[]>>({});

  /** The groups of `view` that are folded: those of its file, or of the page where it may not write the file. */
  collapsedOf(view: View): string[] {
    return this.folds[view.id] ?? view.collapsed ?? [];
  }

  /**
   * Fold the group `value` of `view`, or open it: the view keeps its folds in its file. Read only, the fold is the
   * page's (it is only a way to look, not a change of the vault) and goes with a reload.
   */
  toggle(view: View, form: ViewForm, value: string): Promise<boolean> {
    if (view.id !== DRAFT_ID && this.host.readOnly?.()) {
      this.folds = { ...this.folds, [view.id]: toggledGroup(this.collapsedOf(view), value) };
      return Promise.resolve(true);
    }
    return this.save(view, { ...form, collapsed: toggledGroup(form.collapsed ?? [], value) });
  }

  async remove(view: View): Promise<boolean> {
    // The view being tried has no file: it is put away.
    if (view.id === DRAFT_ID) {
      this.draft = null;
      return true;
    }
    const result = await this.host.write([deleteOp(view)]);
    return result?.results[0]?.ok === true;
  }
}
