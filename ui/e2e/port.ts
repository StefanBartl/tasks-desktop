// The port the hub of the browser tests listens on. The global setup takes a free one for each run (`ensureE2ePort`) and
// hands it to the workers in `TASKS_E2E_PORT`, so that runs on one machine (the self-hosted runner, a terminal, another
// session) never take the same port; a given `TASKS_E2E_PORT` is kept. 17698 is only what a process reads that was not
// started by the setup.

import { readdirSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const DEFAULT_E2E_PORT = 17698;

/** The port from the environment: a whole number from 1024 to 65535, else the default; a wrong value is an error. */
export function e2ePort(env: Record<string, string | undefined>): number {
  const raw = env['TASKS_E2E_PORT'];
  if (raw === undefined || raw === '') return DEFAULT_E2E_PORT;
  const port = Number(raw);
  if (!/^\d+$/.test(raw) || port < 1024 || port > 65535) {
    throw new Error(`TASKS_E2E_PORT must be a port from 1024 to 65535, got ${JSON.stringify(raw)}`);
  }
  return port;
}

/** A port nobody listens on now: the system's pick for port 0 on the loopback. */
export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      server.close(() => (port >= 1024 ? resolve(port) : reject(new Error(`no free port (got ${port})`))));
    });
  });
}

/**
 * The port of this run: `TASKS_E2E_PORT` when it is given (checked as `e2ePort` does), else a free one, written to
 * `env` so that the processes started after it (the workers) read the same.
 */
export async function ensureE2ePort(env: Record<string, string | undefined>): Promise<number> {
  const given = env['TASKS_E2E_PORT'];
  if (given !== undefined && given !== '') return e2ePort(env);
  const port = await freePort();
  env['TASKS_E2E_PORT'] = String(port);
  return port;
}

/** `ui/test-results/`, where the configs (in `ui/`) put the folders of the runs. */
export const RESULTS = fileURLToPath(new URL('../test-results/', import.meta.url));

/** Whether a process with this id runs: signal 0 tests it (ESRCH: gone; EPERM: there, but not ours to signal). */
export function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * Removes the folders `run-<n>` under `root` whose run has ended (no process `n` any more), never the one of `own` and
 * nothing else; returns the names it removed. A folder that cannot be removed now (a file still open) stays for the
 * next run instead of failing this one.
 */
export function pruneRuns(
  root: string,
  own: number,
  alive: (pid: number) => boolean = processAlive,
  rm: (path: string) => void = (path) => rmSync(path, { recursive: true, force: true }),
): string[] {
  let names: string[];
  try {
    names = readdirSync(root);
  } catch {
    return [];
  }
  const removed: string[] = [];
  for (const name of names) {
    const found = /^run-(\d+)$/.exec(name);
    if (!found) continue;
    const pid = Number(found[1]);
    if (pid === own || alive(pid)) continue;
    try {
      rm(join(root, name));
      removed.push(name);
    } catch {
      // EBUSY and the like: left for the next run.
    }
  }
  return removed;
}

/**
 * The folder of this run's results (traces of failed tests) under `test-results/`: a run clears its folder when it
 * starts, so two runs side by side must not share one. Named after the process that loads the config first (the
 * runner), which also removes the folders of runs that have ended; the workers it starts inherit the name from the
 * environment and remove nothing.
 */
export function runOutputDir(
  env: Record<string, string | undefined>,
  pid: number,
  root: string = RESULTS,
  alive: (pid: number) => boolean = processAlive,
): string {
  if (env['TASKS_E2E_RUN'] === undefined) {
    env['TASKS_E2E_RUN'] = String(pid);
    pruneRuns(root, pid, alive);
  }
  return `test-results/run-${env['TASKS_E2E_RUN']}`;
}

/**
 * Where `--last-failed` finds the last run: Playwright keeps it in the outputDir, which is a new one for every run, so
 * the file is put at one place per suite (`name`) instead. A path given in the environment is kept.
 */
export function lastRunFile(env: Record<string, string | undefined>, name: string, root: string = RESULTS): string {
  env['PLAYWRIGHT_LAST_RUN_OUTPUT_FILE'] ??= join(root, `.last-run-${name}.json`);
  return env['PLAYWRIGHT_LAST_RUN_OUTPUT_FILE'];
}
