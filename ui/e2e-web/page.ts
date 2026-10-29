// What the tests of the web variant share: the built file, the fixture vault as a fake folder, and the watch on what the
// page must never do (a request, a violation of its policy).

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { existsSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { Page } from '@playwright/test';

const here = dirname(fileURLToPath(import.meta.url));
export const FILE = resolve(here, '..', 'dist-web', 'tasks.html');
export const FIXTURE = resolve(here, '..', '..', 'e2e', 'fixture', 'vault');

export function pageUrl(): string {
  if (!existsSync(FILE)) throw new Error(`${FILE} is not there: run "pnpm web:build" first`);
  return pathToFileURL(FILE).href;
}

/** The fixture vault: path relative to its root -> text. */
export function vaultFiles(): Record<string, string> {
  const files: Record<string, string> = {};
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else files[relative(FIXTURE, path).replaceAll('\\', '/')] = readFileSync(path, 'utf8');
    }
  };
  walk(FIXTURE);
  return files;
}

/** Everything the page did that it must not have: a request outside the page, a violation of its own policy. */
export interface Watch {
  requests: string[];
  violations: string[];
  errors: string[];
}

export async function watchPage(page: Page): Promise<Watch> {
  const seen: Watch = { requests: [], violations: [], errors: [] };
  page.on('request', (request) => {
    const url = request.url();
    // The page itself, the worker's script (a blob) and data: are not the network.
    if (url === pageUrl() || url.startsWith('blob:') || url.startsWith('data:')) return;
    seen.requests.push(`${request.method()} ${url}`);
  });
  page.on('pageerror', (error) => seen.errors.push(String(error)));
  page.on('console', (message) => {
    if (message.type() === 'error') seen.errors.push(message.text());
  });
  await page.addInitScript(() => {
    (window as unknown as { __violations: string[] }).__violations = [];
    document.addEventListener('securitypolicyviolation', (event) => {
      (window as unknown as { __violations: string[] }).__violations.push(`${event.violatedDirective} ${event.blockedURI}`);
    });
  });
  return seen;
}

export async function violations(page: Page): Promise<string[]> {
  return page.evaluate(() => (window as unknown as { __violations: string[] }).__violations);
}

/**
 * A `showDirectoryPicker` that hands out the fixture vault as a folder. The permission is `granted` and the folder
 * reads like the real ones: `values()` yields file and folder handles, `getFile()` gives size, time and bytes.
 */
export async function fakePicker(page: Page, files: Record<string, string>): Promise<void> {
  await page.addInitScript((tree: Record<string, string>) => {
    const enc = new TextEncoder();
    type Entry =
      | { kind: 'file'; name: string; text: string; time: number }
      | { kind: 'directory'; name: string; children: Map<string, Entry> };
    const root: Entry = { kind: 'directory', name: 'fixture-vault', children: new Map() };
    for (const [path, text] of Object.entries(tree)) {
      const parts = path.split('/');
      let at = root as Extract<Entry, { kind: 'directory' }>;
      for (const part of parts.slice(0, -1)) {
        let next = at.children.get(part);
        if (!next) {
          next = { kind: 'directory', name: part, children: new Map() };
          at.children.set(part, next);
        }
        at = next as Extract<Entry, { kind: 'directory' }>;
      }
      at.children.set(parts[parts.length - 1] as string, { kind: 'file', name: parts[parts.length - 1] as string, text, time: 1_700_000_000_000 });
    }
    // The test changes a file in the folder, as an editor would: the text and the time move on.
    (window as unknown as { __setFile: (path: string, text: string) => void }).__setFile = (path, text) => {
      const parts = path.split('/');
      let at = root as Extract<Entry, { kind: 'directory' }>;
      for (const part of parts.slice(0, -1)) at = at.children.get(part) as Extract<Entry, { kind: 'directory' }>;
      const old = at.children.get(parts[parts.length - 1] as string) as Extract<Entry, { kind: 'file' }>;
      at.children.set(old.name, { kind: 'file', name: old.name, text, time: old.time + 5000 });
    };
    const handle = (entry: Entry): unknown =>
      entry.kind === 'file'
        ? {
            kind: 'file',
            name: entry.name,
            getFile: async () => ({ size: enc.encode(entry.text).byteLength, lastModified: entry.time, arrayBuffer: async () => enc.encode(entry.text).buffer }),
          }
        : {
            kind: 'directory',
            name: entry.name,
            queryPermission: async () => 'granted',
            requestPermission: async () => 'granted',
            async *values() {
              for (const child of entry.children.values()) yield handle(child);
            },
          };
    (window as unknown as { showDirectoryPicker: unknown }).showDirectoryPicker = async () => handle(root);
  }, files);
}
