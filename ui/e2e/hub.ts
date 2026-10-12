// A real hub for the browser tests: the binary of this repository, the real
// engine, a copy of the synthetic fixture vault with hostile tasks added.
// Nothing of a real vault is ever used (concept 5.7).

import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '..', '..');
export const PORT = 17698;
export const ORIGIN = `http://127.0.0.1:${PORT}`;

const exe = join(repo, 'target', 'debug', process.platform === 'win32' ? 'tasks-hub.exe' : 'tasks-hub');

/** Titles and bodies an attacker could write into a vault. */
export const HOSTILE: { slug: string; title: string; body: string }[] = [
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
    slug: 'bidi-title',
    title: 'Invoice ‮txt.exe‬ ​ready',
    body: 'a‮reversed',
  },
];

export interface Running {
  child: ChildProcess;
  config: string;
  vault: string;
  stop(): void;
}

function frontmatterTitle(title: string): string {
  // A YAML double-quoted string.
  return `"${title.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

export function prepareVault(): { root: string; vault: string; config: string } {
  const root = mkdtempSync(join(tmpdir(), 'tasks-desktop-e2e-'));
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

export function env(config: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    TASKS_DESKTOP_CONFIG_DIR: config,
    TASKS_DESKTOP_PORT: String(PORT),
  };
}

export async function startHub(): Promise<Running & { root: string }> {
  const { root, vault, config } = prepareVault();
  const child = spawn(exe, ['serve'], { env: env(config), stdio: 'ignore' });
  const deadline = Date.now() + 20_000;
  for (;;) {
    try {
      const r = await fetch(`${ORIGIN}/api/tasks/hello`);
      if (r.ok) {
        const doc = (await r.json()) as { engine: { ready: boolean } };
        if (doc.engine.ready) break;
        throw new Error('the engine is not ready: set TASKS_ENGINE_DIR and LIB_NVIM_DIR');
      }
    } catch (error) {
      if (Date.now() > deadline || (error instanceof Error && error.message.includes('engine'))) {
        child.kill();
        throw error;
      }
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  return {
    child,
    config,
    vault,
    root,
    stop() {
      child.kill();
      try {
        rmSync(root, { recursive: true, force: true });
      } catch {
        // a file the engine still holds; the temp folder is cleaned later
      }
    },
  };
}

/** A pairing link, as `tasks-hub open` prints it. */
export function pairingLink(config: string): string {
  const out = execFileSync(exe, ['open'], { env: env(config), encoding: 'utf8' });
  const link = out.trim().split(/\r?\n/)[0] ?? '';
  if (!link.startsWith(`${ORIGIN}/#pair=`)) throw new Error(`unexpected link: ${link}`);
  return link;
}
