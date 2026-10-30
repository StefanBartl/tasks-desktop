// A real hub for the browser tests: the binary of this repository, the real
// engine, a copy of the synthetic fixture vault with hostile tasks added.
// Nothing of a real vault is ever used (concept 5.7).

import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { removeTree, tempDir, tempRoot } from '../web/tmp.mjs';
import { e2ePort } from './port.ts';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '..', '..');
export const PORT = e2ePort(process.env);
export const ORIGIN = `http://127.0.0.1:${PORT}`;

/**
 * The root of the temp folders of one run of these tests: the folder of the hub, the file the workers read their state
 * from. `global.ts` removes it when the run is over (`cleanUp`), and the end of the process does it if that never ran.
 */
export const RUN_ROOT_NAME = 'tasks-desktop-e2e';

const exe = join(repo, 'target', 'debug', process.platform === 'win32' ? 'tasks-hub.exe' : 'tasks-hub');

/** Titles and bodies an attacker could write into a vault. */
export const HOSTILE: { slug: string; title: string; body: string; front?: string[] }[] = [
  {
    slug: 'xss-title-img',
    title: '"><img src=x onerror=window.__xss=1>',
    body: 'plain body',
  },
  {
    slug: 'xss-title-svg',
    title: '<svg onload=window.__xss=2>',
    body: 'plain body',
  },
  {
    slug: 'xss-body-html',
    title: 'Body with raw html',
    body: [
      '<script>window.__xss=3</script>',
      '',
      '<img src=x onerror="window.__xss=4">',
      '',
      '<iframe src="javascript:window.__xss=5"></iframe>',
      '',
      '<a href="javascript:window.__xss=6">raw anchor</a>',
      '',
      '<details open ontoggle="window.__xss=7">d</details>',
    ].join('\n'),
  },
  {
    slug: 'xss-body-links',
    title: 'Body with links',
    body: [
      '[js](javascript:window.__xss=8)',
      '',
      '[data](data:text/html,<script>window.__xss=9</script>)',
      '',
      '[mixed](JaVaScRiPt:window.__xss=10)',
      '',
      '[entity](java&#115;cript:window.__xss=11)',
      '',
      '<javascript:window.__xss=12>',
      '',
      '![img](https://tracker.invalid/pixel.png)',
      '',
      '[ok](https://example.org/page)',
    ].join('\n'),
  },
  {
    slug: 'xss-body-more',
    title: '</title><script>window.__xss=13</script>{{7*7}} ${7*7}',
    body: [
      '[a](<javascript:window.__xss=14>)',
      '',
      '[b](&#x6A;avascript:window.__xss=15)',
      '',
      '[c](jav&#x09;ascript:window.__xss=16)',
      '',
      '![ref image][r]',
      '',
      '[r]: javascript:window.__xss=17',
      '',
      '<!-- <script>window.__xss=18</script> -->',
      '',
      '<style>body{display:none}</style>',
      '',
      '<form action="https://tracker.invalid/f"><input name=x></form>',
      '',
      '<https://example.org/auto>',
    ].join('\n'),
  },
  {
    slug: 'xss-frontmatter',
    title: 'Markup in the fields around the title',
    body: 'fields',
    front: [
      'plan: "<img src=x onerror=window.__xss=19>"',
      'phase: "<svg onload=window.__xss=20>"',
      'blocked_by: ["<img src=x onerror=window.__xss=21>", "lib.nvim/alpha"]',
      'after: ["<script>window.__xss=22</script>"]',
      'tags: ["<img src=x onerror=window.__xss=23>"]',
      'refs: ["javascript:window.__xss=24", "<img src=x onerror=window.__xss=25>"]',
    ],
  },
  {
    slug: 'wide-content',
    title: 'Long lines and a wide table',
    body: [
      '```',
      'x'.repeat(400),
      '```',
      '',
      '| ' + Array.from({ length: 30 }, (_, i) => `column-${i}`).join(' | ') + ' |',
      '| ' + Array.from({ length: 30 }, () => '---').join(' | ') + ' |',
      '| ' + Array.from({ length: 30 }, (_, i) => `value-${i}`).join(' | ') + ' |',
      '',
      'y'.repeat(600),
    ].join('\n'),
  },
  {
    slug: 'bidi-title',
    title: 'Invoice \u202Etxt.exe\u202C \u200Bready',
    body: 'a\u202Ereversed',
  },
];

/** Is the binary the one of the current build of the interface? */
export async function assertFreshBinary(): Promise<void> {
  const dist = join(repo, 'ui', 'dist', 'index.html');
  if (!existsSync(dist)) throw new Error('ui/dist is not built: run `pnpm build` and `cargo build`');
  const served = await (await fetch(`${ORIGIN}/`)).text();
  if (served.trim() !== readFileSync(dist, 'utf8').trim()) {
    throw new Error('the hub binary holds an older interface: run `cargo build` after `pnpm build`');
  }
}

export interface Running {
  child: ChildProcess;
  config: string;
  vault: string;
  /** Ends the hub and removes its folder. Rejects when the folder cannot be removed: a leftover is an error. */
  stop(): Promise<void>;
}

function frontmatterTitle(title: string): string {
  // A YAML double-quoted string.
  return `"${title.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

export function prepareVault(): { root: string; vault: string; config: string } {
  const root = tempDir('hub', tempRoot(RUN_ROOT_NAME));
  const vault = join(root, 'vault');
  cpSync(join(repo, 'e2e', 'fixture', 'vault'), vault, { recursive: true });
  const tasks = join(vault, 'lib.nvim', 'ROADMAP', 'tasks');
  for (const h of HOSTILE) {
    writeFileSync(
      join(tasks, `${h.slug}.md`),
      [
        '---',
        `title: ${frontmatterTitle(h.title)}`,
        'status: open',
        'kind: task',
        'prio: 2',
        'effort: S',
        'created: 2026-01-01',
        'updated: 2026-01-01',
        ...(h.front ?? []),
        '---',
        '',
        h.body,
        '',
      ].join('\n'),
    );
  }
  const config = join(root, 'config');
  mkdirSync(config);
  writeFileSync(
    join(config, 'config.json'),
    JSON.stringify({
      vault,
      extra_areas: ['ALL', 'nvim-config', 'docmap-desktop', 'migrate.nvim'],
    }),
  );
  writeFileSync(
    join(config, 'areas.json'),
    JSON.stringify({
      schema: 1,
      areas: {
        'lib.nvim': { class: 'internal' },
        'cascade.nvim': { class: 'public' },
        ALL: { class: 'internal' },
        'migrate.nvim': { class: 'internal' },
        'nvim-config': { class: 'internal' },
      },
    }),
  );
  return { root, vault, config };
}

/** The folder the folder dialog returns in a test. */
export function pickedFolder(config: string): string {
  return join(config, '..', 'picked-vault');
}

export function env(config: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    TASKS_DESKTOP_CONFIG_DIR: config,
    // The editor is not started in a test: the file it would open is written here.
    TASKS_DESKTOP_EDITOR_LOG: join(config, '..', 'editor.log'),
    // The folder dialog is not shown in a test: the folder it "returns" is this one (see `pickedFolder`).
    TASKS_DESKTOP_PICK_RESULT: pickedFolder(config),
    TASKS_DESKTOP_PORT: String(PORT),
  };
}

/**
 * End the hub and remove its folder. The hub is waited for first: on Windows a folder with a running process in it
 * (its watcher, the engine it started) cannot be removed. What is still busy after that is tried again for a few
 * seconds, and then it is an error, never a silent leftover.
 */
async function endHub(child: ChildProcess, root: string): Promise<void> {
  if (child.exitCode === null && child.signalCode === null) {
    const gone = new Promise<void>((done) => child.once('exit', () => done()));
    child.kill();
    let giveUp: NodeJS.Timeout | undefined;
    await Promise.race([gone, new Promise((done) => (giveUp = setTimeout(done, 10_000)))]);
    clearTimeout(giveUp);
  }
  removeTree(root, { retries: 30, delay: 200 });
}

/** For the tests of web/ (e2e-cleanup.test.mjs): another program for the hub, and how long to wait for it. */
export interface StartOptions {
  /** the program, and the arguments that go before `serve` */
  exe?: string;
  args?: string[];
  /** ms the hub has to be ready in */
  readyTimeout?: number;
}

/** Is something answering on the port of the hub? */
export async function portTaken(): Promise<boolean> {
  return fetch(`${ORIGIN}/api/tasks/hello`).then(
    () => true,
    () => false,
  );
}

export async function startHub(options: StartOptions = {}): Promise<Running & { root: string }> {
  // Something already answers on the port: those tests would run against
  // another hub and another vault.
  if (await portTaken()) throw new Error(`port ${PORT} is in use: stop the hub that runs there`);
  const { root, vault, config } = prepareVault();
  const child = spawn(options.exe ?? exe, [...(options.args ?? []), 'serve'], { env: env(config), stdio: 'ignore' });
  const running = { child, config, vault, root, stop: () => endHub(child, root) };
  try {
    await waitUntilReady(config, options.readyTimeout ?? 20_000);
  } catch (error) {
    // The first error is the one to report; a folder that cannot be removed on top of it is told as well.
    await running.stop().catch((again: unknown) => console.error(String(again)));
    throw error;
  }
  return running;
}

async function waitUntilReady(config: string, timeout: number): Promise<void> {
  const deadline = Date.now() + timeout;
  for (;;) {
    try {
      const r = await fetch(`${ORIGIN}/api/tasks/hello`);
      if (r.ok) {
        const doc = (await r.json()) as { engine: { ready: boolean } };
        if (doc.engine.ready) break;
        throw new Error('the engine is not ready: set TASKS_ENGINE_DIR and LIB_NVIM_DIR');
      }
    } catch (error) {
      if (Date.now() > deadline || (error instanceof Error && error.message.includes('engine'))) throw error;
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  // The port answers before `hub.json` is written, and `tasks-hub open` (the
  // pairing of the tests) needs that file.
  while (!existsSync(join(config, 'hub.json'))) {
    if (Date.now() > deadline) throw new Error('the hub answers but wrote no hub.json');
    await new Promise((r) => setTimeout(r, 100));
  }
  await assertFreshBinary();
}

/**
 * A session token, got the way the page gets one. The hub allows ten
 * exchanges a minute (that is the point of the limit), so the tests share one
 * session and only the pairing tests go through a link.
 */
export async function sessionToken(config: string): Promise<string> {
  const code = pairingLink(config).split('#pair=')[1] ?? '';
  const response = await fetch(`${ORIGIN}/auth/exchange`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: ORIGIN },
    body: JSON.stringify({ code }),
  });
  if (!response.ok) throw new Error(`exchange refused: ${response.status}`);
  return ((await response.json()) as { token: string }).token;
}

/** A pairing link, as `tasks-hub open` prints it. */
export function pairingLink(config: string): string {
  const out = execFileSync(exe, ['open'], { env: env(config), encoding: 'utf8' });
  const link = out.trim().split(/\r?\n/)[0] ?? '';
  if (!link.startsWith(`${ORIGIN}/#pair=`)) throw new Error(`unexpected link: ${link}`);
  return link;
}

/**
 * Remove a file the hub may still hold for a moment (its watcher or the engine reading it). On Windows that fails with
 * EBUSY or EPERM; `removeTree` tries again (the `maxRetries` of `fs.rmSync` retries nothing on this Node) and then fails.
 */
export function removeFile(file: string): void {
  removeTree(file, { retries: 10, delay: 100 });
}
