// The port the hub of the browser tests listens on. 17698 by default; `TASKS_E2E_PORT` moves it, so that a run of the CI
// on the author's machine (the self-hosted runner) and a run in a terminal there do not take the same port.

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
