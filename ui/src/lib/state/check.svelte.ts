// The check of the vault as a job, and its findings judged against the tasks as they are now. A part of the state of
// the page of its own (`App` holds it and passes the few things it needs through `CheckHost`). The check runs in the hub;
// this asks for the state of the job, keeps the ground its findings are judged on, and watches for the next run.

import { ApiError, type CheckJobState } from '../api';
import { findingsByTask, groundOf, judgeFindings, type Finding, type Ground, type Judged } from '../check';
import type { TaskEntry } from '../contract';
import { translate, type Lang } from '../i18n';

/** The pause between two looks for a check the hub started by itself, and how many looks. */
const CHECK_WAIT_MS = 15_000;
const CHECK_WAITS = 12;

/** What the check needs of the page around it. */
export interface CheckHost {
  ready(): boolean;
  can(capability: string): boolean;
  lang(): Lang;
  /** The rev of the snapshot the page holds now. */
  rev(): string | undefined;
  tasks(): readonly TaskEntry[];
  checkStart(request: { stale?: 'refs' }): Promise<CheckJobState>;
  checkState(): Promise<CheckJobState>;
}

export class CheckState {
  /** The check dialog and the job behind it: what the hub says of it, and why it cannot say. */
  checking = $state(false);
  job = $state.raw<CheckJobState | null>(null);
  problem = $state<string | null>(null);
  /**
   * The ground of the check that is done: the versions of the tasks as they were when it was made, taken from the
   * snapshot of the same `rev` (the job's id says which check). Without it the check was made for a state the page
   * never saw whole (the vault changed while it ran), and its findings are not shown.
   */
  private ground = $state.raw<{ id: number; ground: Ground } | null>(null);
  /** The judged findings for one job, ground and list: judged once, not once for every row that asks. */
  private memo: { job: CheckJobState; ground: Ground; tasks: readonly TaskEntry[]; judged: Judged; byTask: Map<string, Finding[]> } | null = null;
  private held = new Map<string, Ground>();
  /** How often the page looked for a check the hub started by itself since the list last changed. */
  private waits = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  /** The newest start or ask of the job: an older answer does not replace it. */
  private seq = 0;

  constructor(private readonly host: CheckHost) {}

  /**
   * Take what the hub says of the job. A check that is done for the state the page shows gets its ground: the
   * versions of the tasks now, which are the versions it read (same `rev`). A done check whose `rev` the page does
   * not hold yet is grounded when the list that matches it is read (`groundNow`, from the page's read).
   */
  private adopt(job: CheckJobState): void {
    if (job.state === 'running') this.waits = 0;
    this.job = job;
    this.groundNow();
  }

  /** Give a check that is done its ground, when the page holds (or held) the list it was made for. */
  groundNow(): void {
    const job = this.job;
    // Also a check that is done: the hub may run the next one by itself, and the page never sees it run.
    this.hold(job !== null);
    if (job?.state !== 'done' || this.ground?.id === job.id) return;
    // The page may have read a newer list before it saw the job done: the ground of the rev the check read was held
    // while the job ran.
    const ground = job.result.rev === this.host.rev() ? groundOf(this.host.tasks() as TaskEntry[]) : this.held.get(job.result.rev);
    if (ground === undefined) return;
    this.ground = { id: job.id, ground };
    this.held.clear();
  }

  /** While a job runs, keep the versions of the list the page holds: the check may be made for any of them. */
  private hold(running: boolean): void {
    const rev = this.host.rev();
    if (!running || rev === undefined || this.held.has(rev)) return;
    if (this.held.size >= 8) this.held.clear();
    this.held.set(rev, groundOf(this.host.tasks() as TaskEntry[]));
  }

  /** The findings judged against the tasks as they are now (see `lib/check.ts`); nothing for a check without ground. */
  private judged(): { judged: Judged; byTask: Map<string, Finding[]> } {
    const job = this.job;
    const grounded = this.ground;
    if (job?.state !== 'done' || grounded?.id !== job.id) return { judged: { valid: [], stale: [], changed: 0 }, byTask: new Map() };
    const tasks = this.host.tasks();
    const memo = this.memo;
    if (memo && memo.job === job && memo.ground === grounded.ground && memo.tasks === tasks) return memo;
    const judged = judgeFindings(job.result.findings, grounded.ground, tasks as TaskEntry[]);
    const next = { job, ground: grounded.ground, tasks, judged, byTask: findingsByTask(judged.valid) };
    this.memo = next;
    return next;
  }

  /** The findings that hold: of tasks as they were when the check was made, and of what is no listed task. */
  get findings(): Finding[] {
    return this.judged().judged.valid;
  }

  /** The findings of tasks that changed since the check: possibly resolved, shown as such. */
  get stale(): Finding[] {
    return this.judged().judged.stale;
  }

  /** How many tasks with findings changed or went away since the check. */
  get changed(): number {
    return this.judged().judged.changed;
  }

  /** The findings that hold about the task `id`. */
  findingsFor(id: string): Finding[] {
    return this.judged().byTask.get(id) ?? [];
  }

  /** Whether the check that is done was made for a state the page never held (the vault changed while it ran). */
  get outdated(): boolean {
    const job = this.job;
    return job?.state === 'done' && this.ground?.id !== job.id;
  }

  /** Open the check dialog on what the hub knows of the job. */
  async open(): Promise<void> {
    if (!this.host.ready() || !this.host.can('check')) return;
    this.checking = true;
    await this.poll();
  }

  close(): void {
    this.checking = false;
  }

  /** Start the check; it runs in the hub and the page goes on. */
  async run(refs: boolean): Promise<void> {
    this.problem = null;
    this.seq += 1;
    const seq = this.seq;
    // The check reads the list the page holds now (or a later one): its ground is kept for when the job is done.
    this.hold(true);
    try {
      const job = await this.host.checkStart(refs ? { stale: 'refs' } : {});
      if (seq !== this.seq) return;
      this.adopt(job);
    } catch (error) {
      if (seq !== this.seq) return;
      this.problem = error instanceof ApiError ? error.message : translate(this.host.lang(), 'check.failed');
      return;
    }
    this.watch();
  }

  /** Ask for the state of the job, and again a second later while it runs. */
  private async poll(): Promise<void> {
    clearTimeout(this.timer);
    this.seq += 1;
    const seq = this.seq;
    try {
      const job = await this.host.checkState();
      if (seq !== this.seq) return;
      this.adopt(job);
      this.problem = null;
    } catch (error) {
      if (seq !== this.seq) return;
      this.problem = error instanceof ApiError ? error.message : translate(this.host.lang(), 'check.failed');
      // A job that was running may well still run: one failed question ends neither it nor the asking. The next
      // try is a little later (the hub may be busy), and the run button is not held back by the old state.
      if (this.job?.state === 'running' && this.host.ready()) {
        this.timer = setTimeout(() => void this.poll(), 3000);
      }
      return;
    }
    this.watch();
  }

  /** A newer list was read: a check that waited for it is grounded, and the looking for a next run starts anew. */
  listChanged(): void {
    this.groundNow();
    this.waits = 0;
    this.watch();
  }

  /** Look again for the job when it runs, or when the vault changed since it was done (the hub may run it again). */
  watch(): void {
    clearTimeout(this.timer);
    if (!this.host.ready()) return;
    const job = this.job;
    if (job?.state === 'running') {
      this.timer = setTimeout(() => void this.poll(), 1000);
    } else if (job?.state === 'done' && job.result.rev !== this.host.rev() && this.waits < CHECK_WAITS) {
      // The vault changed since the check. The hub runs it again by itself after a quiet time (and a gap since the last
      // one), so the page looks now and then for a job it did not start; it gives up after a while, since the hub may
      // not run it (no client at the time, a check with refs, a vault that never rests).
      this.waits += 1;
      this.timer = setTimeout(() => void this.poll(), CHECK_WAIT_MS);
    }
  }

  /** What was asked is not valid any more (the page stops): an answer on its way is dropped, the timer is cleared. */
  invalidate(): void {
    this.seq += 1;
    clearTimeout(this.timer);
  }

  /** The session is gone: the job and its ground are forgotten. */
  forget(): void {
    this.invalidate();
    this.job = null;
    this.ground = null;
    this.held.clear();
  }
}
