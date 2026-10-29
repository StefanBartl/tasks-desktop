import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { cleanUp, tempRoot } from '../web/tmp.mjs';
// With the extension: web/e2e-cleanup.test.mjs loads this file with Node, which resolves nothing without it.
import { RUN_ROOT_NAME, sessionToken, startHub, type Running } from './hub.ts';

// One file for one run, in the temp root of the run: the workers inherit its name from the environment, set in
// `setup` before they are started. A worker that finds nothing here was not started by this setup.
export const STATE = process.env['TASKS_DESKTOP_E2E_STATE'] ?? '';

let running: (Running & { root: string }) | null = null;

/** What `setup` does with the outside world; the tests of web/ replace it. */
export interface Steps {
  start: () => Promise<Running & { root: string }>;
  token: (config: string) => Promise<string>;
}

const REAL: Steps = { start: () => startHub(), token: sessionToken };

/** Starts the hub and writes the state file; returns the teardown. A setup that fails cleans up after itself. */
export async function runSetup(steps: Steps = REAL): Promise<() => Promise<void>> {
  const state = join(tempRoot(RUN_ROOT_NAME), 'state.json');
  process.env['TASKS_DESKTOP_E2E_STATE'] = state;
  try {
    running = await steps.start();
    const token = await steps.token(running.config);
    writeFileSync(state, JSON.stringify({ config: running.config, vault: running.vault, token }));
  } catch (error) {
    // Playwright does not call the teardown of a setup that failed.
    await teardown().catch((again: unknown) => console.error(String(again)));
    throw error;
  }
  return teardown;
}

export default async function setup(): Promise<() => Promise<void>> {
  return runSetup();
}

/** The hub ends, its folder and the state file go. A folder that cannot be removed fails the run. */
export async function teardown(): Promise<void> {
  const hub = running;
  running = null;
  try {
    await hub?.stop();
  } finally {
    cleanUp({ retries: 30, delay: 200 });
  }
}
