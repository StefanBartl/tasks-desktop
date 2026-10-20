// The graph of one task in the plan view: which task, which way, what the engine says, and why it does not. A part of
// the state of the page of its own (the page, `App`, holds it and passes the few things it needs through `GraphHost`).

import { ApiError } from '../api';
import type { PlanFor } from '../contract';
import { translate, type Lang } from '../i18n';

/** What the graph needs of the page around it. */
export interface GraphHost {
  ready(): boolean;
  can(capability: string): boolean;
  lang(): Lang;
  /** The rev of the snapshot the page holds now. */
  rev(): string | undefined;
  showPlan(): void;
  planFor(id: string, direction: 'needs' | 'unlocks'): Promise<PlanFor>;
}

export class GraphState {
  /** Which task and which way; `null` while no graph is open. */
  graph = $state.raw<{ id: string; direction: 'needs' | 'unlocks' } | null>(null);
  doc = $state.raw<PlanFor | null>(null);
  problem = $state<string | null>(null);
  /** The panel takes the focus once, when the graph is opened (not when it is drawn again after a change of view). */
  wantsFocus = false;
  /** The rev of the snapshot the graph on the screen was asked for. */
  private rev: string | undefined;
  private seq = 0;

  constructor(private readonly host: GraphHost) {}

  /** Show what `id` needs (or what waits for it) in the plan view. */
  open(id: string, direction: 'needs' | 'unlocks' = 'needs'): void {
    if (!this.host.ready() || !this.host.can('plan_for')) return;
    this.graph = { id, direction };
    this.doc = null;
    this.problem = null;
    this.wantsFocus = true;
    this.host.showPlan();
    void this.ask();
  }

  close(): void {
    this.seq += 1;
    this.graph = null;
    this.doc = null;
    this.problem = null;
  }

  /** What was asked is not valid any more (the page stops, or the session is lost): an answer on its way is dropped. */
  invalidate(): void {
    this.seq += 1;
  }

  /** Ask again for the graph that is open, after the vault changed (the old one stays until the new one is there). */
  reload(): void {
    if (this.graph && this.doc !== null && this.host.rev() !== this.rev) void this.ask();
  }

  private async ask(): Promise<void> {
    const graph = this.graph;
    if (!graph) return;
    this.seq += 1;
    const seq = this.seq;
    this.rev = this.host.rev();
    try {
      const doc = await this.host.planFor(graph.id, graph.direction);
      if (seq !== this.seq || !this.graph) return;
      this.doc = doc;
      this.problem = null;
    } catch (error) {
      if (seq !== this.seq || !this.graph) return;
      // The engine's words, as they are (a task that is finished meanwhile is "no such open task"); the list that was
      // there is not left standing under them.
      this.doc = null;
      this.problem = error instanceof ApiError ? error.message : translate(this.host.lang(), 'graph.failed');
    }
  }
}
