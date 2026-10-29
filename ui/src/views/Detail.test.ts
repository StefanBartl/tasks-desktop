// The detail of a task and the quick capture, rendered on the server side of Svelte over a page that was not started:
// what they offer that needs the machine (the file in the editor, a screenshot to attach). The clicks and the editing
// are looked at in the browser tests.
import { render } from 'svelte/server';
import { describe, expect, it } from 'vitest';
import type { Hub } from '../lib/api';
import { App, type Env } from '../lib/app.svelte';
import { task } from '../lib/fixtures';
import Capture from './Capture.svelte';
import Detail from './Detail.svelte';

/** A page that was not started; `web` makes it the web variant, as `main.web.ts` does. */
function page(web: boolean, capabilities: string[] | null = null): App {
  const none = { getItem: () => null, setItem: () => undefined, removeItem: () => undefined };
  const env: Env = {
    hub: {} as unknown as Hub,
    cache: { load: async () => null, save: async () => undefined, clear: async () => undefined },
    session: none,
    prefs: none,
    preferredLanguages: ['en'],
    now: () => 0,
    fetchFn: (async () => new Response('', { status: 503 })) as typeof fetch,
    sleep: async () => undefined,
    out: { save: () => true, copy: async () => true, print: () => true },
    ...(web ? { mode: 'web' as const } : {}),
  };
  const app = new App(env);
  app.tasks = [task('pub/a')];
  app.selectedId = 'pub/a';
  app.capabilities = capabilities;
  return app;
}
const strip = (body: string) => body.replace(/<!--.*?-->/g, '');
const detail = (app: App) => strip(render(Detail, { props: { app } }).body);
const capture = (app: App) => strip(render(Capture, { props: { app } }).body);

describe('the file of a task in the detail', () => {
  it('is offered to open in the editor where a hub runs', () => {
    const out = detail(page(false));
    expect(out).toContain('pub/ROADMAP/tasks/a.md');
    expect(out).toContain('Open in Neovim');
  });

  it('is shown but not offered to open in the web variant, which has no editor to start', () => {
    const out = detail(page(true));
    expect(out).toContain('pub/ROADMAP/tasks/a.md');
    expect(out).not.toContain('Neovim');
  });
});

describe('a screenshot to attach', () => {
  it('is offered in the detail and the capture where a hub runs and the engine can attach', () => {
    expect(detail(page(false, ['attach']))).toContain('Attach screenshot');
    expect(capture(page(false, ['attach']))).toContain('Attach a screenshot');
  });

  it('is not offered where the engine cannot attach', () => {
    expect(detail(page(false, []))).not.toContain('Attach screenshot');
    expect(capture(page(false, []))).not.toContain('Attach a screenshot');
  });

  it('is not offered in the web variant even when the engine says it can: there is no clipboard or screenshot folder of a machine to take it from', () => {
    expect(detail(page(true, ['attach']))).not.toContain('Attach screenshot');
    expect(capture(page(true, ['attach']))).not.toContain('Attach a screenshot');
    expect(page(true, ['attach']).canAttach).toBe(false);
  });
});
