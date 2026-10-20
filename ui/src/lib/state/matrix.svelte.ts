// The estimate matrix: the ids it holds, what the person chose in its cells (the draft), and what the engine says the
// draft adds up to. A part of the state of the page of its own (`App` holds it and passes the few things it needs through
// `MatrixHost`). Opening it (which tasks: the marked ones, else the shown ones) and writing it (a batch through the one
// door of the engine) stay with the page, which knows the marks, the list and how a write is made.

import { ApiError } from '../api';
import type { Estimate, TaskEntry } from '../contract';
import { assumeOf, changesOf, pruneDraft, withCell, type Draft } from '../estimate';
import { translate, type Lang } from '../i18n';

/** What the matrix needs of the page around it. */
export interface MatrixHost {
  lang(): Lang;
  tasks(): readonly TaskEntry[];
  estimate(request: { ids: string[]; assume?: { id: string; effort?: string; value?: number }[] }, signal: AbortSignal): Promise<Estimate>;
}

export class MatrixState {
  /** The ids it holds (`null`: closed). */
  matrix = $state.raw<{ ids: string[] } | null>(null);
  /** What was chosen in it. */
  draft = $state.raw<Draft>({});
  /** What the engine says the draft adds up to. */
  figures = $state.raw<Estimate | null>(null);
  /** Why the figures are not there (the engine's words), or null. */
  problem = $state<string | null>(null);
  /** The figures shown are for an older draft than the table: a question is due or under way. */
  pending = $state(false);
  private seq = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private abort: AbortController | undefined;

  constructor(private readonly host: MatrixHost) {}

  /** Open it on these tasks, with nothing chosen yet. */
  start(ids: string[]): void {
    this.matrix = { ids };
    this.draft = {};
    this.figures = null;
    this.problem = null;
    void this.ask();
  }

  close(): void {
    clearTimeout(this.timer);
    this.abort?.abort();
    this.seq += 1;
    this.pending = false;
    this.matrix = null;
    this.draft = {};
    this.figures = null;
    this.problem = null;
  }

  /** What was asked is not valid any more (the page stops): an answer on its way is dropped, the timer is cleared. */
  invalidate(): void {
    this.seq += 1;
    clearTimeout(this.timer);
  }

  /** The tasks of the matrix that are still there, in the order they were asked for. */
  get rows(): TaskEntry[] {
    const ids = this.matrix?.ids ?? [];
    const byId = new Map(this.host.tasks().map((t) => [t.id, t] as const));
    return ids.flatMap((id) => {
      const task = byId.get(id);
      return task ? [task] : [];
    });
  }

  /** How many tasks the draft would change (a cell equal to its file changes nothing). */
  get changes(): number {
    return changesOf(this.rows, this.draft).length;
  }

  /** Choose a cell (or put it back with `undefined`); the figures are asked for again a moment later. */
  setCell(id: string, field: 'effort' | 'value', value: string | number | undefined): void {
    if (!this.matrix) return;
    const task = this.host.tasks().find((t) => t.id === id);
    this.draft = withCell(this.draft, id, field, value, task?.etag);
    // What was asked for the older draft is no answer to this one: it is dropped at once, not when the next
    // question starts, and the figures say they are being reckoned.
    this.abort?.abort();
    this.seq += 1;
    this.pending = true;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.ask(), 250);
  }

  async ask(): Promise<void> {
    if (!this.matrix) return;
    // The tasks that are there now: one that was finished or moved meanwhile would make the engine refuse every
    // question from here on (`no open task`), so it leaves the question and the draft.
    const ids = this.rows.map((t) => t.id);
    this.draft = pruneDraft(this.draft, ids);
    this.abort?.abort();
    const abort = new AbortController();
    this.abort = abort;
    this.seq += 1;
    const seq = this.seq;
    if (ids.length === 0) {
      this.figures = null;
      this.pending = false;
      return;
    }
    const assume = assumeOf(this.draft, ids);
    try {
      const figures = await this.host.estimate({ ids, ...(assume.length > 0 ? { assume } : {}) }, abort.signal);
      // An older answer does not replace a newer question's.
      if (seq !== this.seq || !this.matrix) return;
      this.figures = figures;
      this.problem = null;
      this.pending = false;
    } catch (error) {
      if (seq !== this.seq || !this.matrix || abort.signal.aborted) return;
      this.pending = false;
      // The engine's words, as they are: the page does not interpret them.
      this.problem = error instanceof ApiError ? error.message : translate(this.host.lang(), 'matrix.failed');
    }
  }
}
