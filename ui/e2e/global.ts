import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { startHub, type Running } from './hub';

export const STATE = join(tmpdir(), 'tasks-desktop-e2e-state.json');

let running: (Running & { root: string }) | null = null;

export default async function setup(): Promise<() => Promise<void>> {
  running = await startHub();
  writeFileSync(STATE, JSON.stringify({ config: running.config, vault: running.vault }));
  return async () => {
    running?.stop();
  };
}
