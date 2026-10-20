// The Info dialog (APP-09): what this build is and which engine answers, and the report of a problem. A part of the
// state of the page of its own.

import type { About } from '../about';

export type AboutDialog =
  | { state: 'closed' }
  | { state: 'loading'; focus: 'info' | 'report' }
  | { state: 'ok'; doc: About; focus: 'info' | 'report' }
  | { state: 'failed'; message: string };

/** What the dialog needs of the page around it. */
export interface AboutHost {
  /**
   * The Info dialog is for a running page and for the page whose engine is not there: that is when a report is needed
   * most, and the hub answers `about` without an engine. It needs a session, so the phases before pairing are out.
   */
  available(): boolean;
  about(): Promise<About>;
}

export class AboutState {
  dialog = $state.raw<AboutDialog>({ state: 'closed' });
  private seq = 0;

  constructor(private readonly host: AboutHost) {}

  get available(): boolean {
    return this.host.available();
  }

  /** Open it; `focus` says what the person came for, so that the keyboard lands there. */
  open(focus: 'info' | 'report' = 'info'): void {
    if (!this.available) return;
    this.seq += 1;
    this.dialog = { state: 'loading', focus };
    void this.load(focus, this.seq);
  }

  close(): void {
    // An answer that is still on its way belongs to this opening, not to the next one.
    this.seq += 1;
    this.dialog = { state: 'closed' };
  }

  private async load(focus: 'info' | 'report', seq: number): Promise<void> {
    try {
      const doc = await this.host.about();
      if (seq === this.seq) this.dialog = { state: 'ok', doc, focus };
    } catch (error) {
      if (seq === this.seq) {
        this.dialog = { state: 'failed', message: error instanceof Error ? error.message : String(error) };
      }
    }
  }
}
