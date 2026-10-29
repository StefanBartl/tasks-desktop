// The detail of a task, its float and the quick capture, rendered on the server side of Svelte over a page that was not
// started: what they offer that needs the machine (the file in the editor, a screenshot to attach, a window of its
// own), and how the fields of the detail are laid out. The clicks, the editing and the places on the screen are looked
// at in the browser tests (e2e/floats.spec.ts).
import { render } from 'svelte/server';
import { describe, expect, it } from 'vitest';
import type { Hub } from '../lib/api';
import { App, type Env } from '../lib/app.svelte';
import { task } from '../lib/fixtures';
import Capture from './Capture.svelte';
import Detail from './Detail.svelte';
import TaskDialog from './TaskDialog.svelte';

/** A page that was not started; `web` makes it the web variant, as `main.web.ts` does. */
function page(web: boolean, capabilities: string[] | null = null, more: Partial<Env> = {}): App {
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
    ...more,
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
const float = (app: App) => strip(render(TaskDialog, { props: { app } }).body);

describe('the fields of the detail', () => {
  it('give the title a line of its own, and the summary several lines', () => {
    const app = page(false);
    app.tasks = [task('pub/a', { summary: 'A summary' })];
    const out = detail(app);
    expect(out).toMatch(/<label class="line[^"]*"><span[^>]*>Title<\/span>\s*<input/);
    expect(out).toMatch(/<label class="line[^"]*"><span[^>]*>Summary<\/span>\s*<textarea class="summary[^"]*" rows="3"/);
    expect(out).toContain('>A summary</textarea>');
    // The choices from a few values share lines among themselves, not with the title.
    expect(out).toMatch(/<div class="picks[^"]*"><label/);
  });

  it('give the plan and the phase, free text often of a long name, a line each, not a cell among the choices', () => {
    const app = page(false);
    app.tasks = [task('pub/a', { plan: 'a-plan', phase: 'a-phase' })];
    const out = detail(app);
    const picks = out.slice(out.indexOf('<div class="picks'), out.indexOf('</div>', out.indexOf('<div class="picks')));
    expect(picks).not.toContain('>Plan</span>');
    expect(picks).not.toContain('>Phase</span>');
    expect(out).toMatch(/<label class="line[^"]*"><span[^>]*>Plan<\/span>\s*<input type="text" value="a-plan"/);
    expect(out).toMatch(/<label class="line[^"]*"><span[^>]*>Phase<\/span>\s*<input type="text" value="a-phase"/);
  });

  it('end with the large Done button, after everything else of the card', () => {
    const out = detail(page(false));
    expect(out).toMatch(/<div class="finish-row[^"]*"><button type="button" class="finish[^"]*"[^>]*><span class="finish-icon[^"]*" aria-hidden="true">✓<\/span> Done<\/button>/);
    expect(out).not.toContain('Finish ...');
    expect(out.indexOf('class="finish-row')).toBeGreaterThan(out.indexOf('pub/ROADMAP/tasks/a.md'));
  });

  it('call it Erledigt in German', () => {
    const app = page(false);
    app.setLang('de');
    const out = detail(app);
    expect(out).toContain('✓</span> Erledigt</button>');
    expect(out).not.toContain('Erledigen');
  });
});

describe('the float of a task', () => {
  function peeking(view: 'list' | 'plan', more: Partial<Env> = {}): App {
    const app = page(false, null, more);
    app.view = view;
    app.peeking = true;
    return app;
  }

  it('has a handle to move it and offers "Show in the list" only over the other views', () => {
    const overList = float(peeking('list'));
    expect(overList).toContain('aria-label="Move or resize the window"');
    expect(overList).toContain('data-float-move');
    expect(overList).toContain('data-float-handle');
    expect(overList).not.toContain('Show in the list');
    expect(float(peeking('plan'))).toContain('Show in the list');
  });

  it('offers to detach the task where the page can open a window', () => {
    expect(float(peeking('list', { openWindow: () => true }))).toContain('aria-label="Open in a window of its own"');
    expect(float(peeking('list'))).not.toContain('Open in a window of its own');
  });
});

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
