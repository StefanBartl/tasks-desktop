// The Info dialog, rendered on the server side of Svelte: what it says about the build and the engine, for the page
// of the hub and for the web variant. Opening, closing and copying are the state's (app.test.ts) and the browser's.
import { render } from 'svelte/server';
import { describe, expect, it } from 'vitest';
import type { About } from '../lib/about';
import AboutDialog from './AboutDialog.svelte';

const hub: About = {
  app: 'tasks-desktop',
  version: '0.4.1',
  build: null,
  os: 'windows',
  arch: 'x86_64',
  mode: null,
  engine: { version: '0.9.0', git: 'faf2078', nvim: '0.12.2' },
  engineProblem: null,
  pinned: { engine: 'faf2078d08ee7632a884bde2b2dee95fef7dfe25', lib: null },
};
const web: About = { ...hub, os: 'web', arch: 'wasm', mode: 'web', engine: { version: '0.9.0', git: 'faf2078', nvim: 'web+Lua5.4' } };

/** The dialog over a page whose `about` answered `doc`. */
const html = (doc: About, lang: 'en' | 'de' = 'en', focus: 'info' | 'report' = 'info') =>
  render(AboutDialog, {
    props: { app: { lang, about: { state: 'ok', doc, focus }, closeAbout() {}, tell() {} } } as never,
  }).body.replace(/<!--.*?-->/g, '');

describe('the Info dialog', () => {
  it('names the Neovim the engine runs in, with the hub', () => {
    const out = html(hub);
    expect(out).toContain('Neovim 0.12.2');
    expect(out).toContain('data-mode="hub"');
    expect(out).toContain('with the hub (tasks-hub)');
  });

  it('in the web variant says so and names the runtime of the browser, never a Neovim', () => {
    const out = html(web);
    expect(out).toContain('data-mode="web"');
    expect(out).toContain('web variant: the page alone in the browser');
    expect(out).toContain('in the browser (web+Lua5.4)');
    expect(out).not.toContain('Neovim');
    expect(html(web, 'de')).toContain('Web-Variante');
    expect(html(web, 'de')).not.toContain('Neovim');
  });

  it('in the web variant writes the same into the report', () => {
    const out = html(web, 'en', 'report');
    expect(out).toContain('Mode: web variant (in the browser, no hub)');
    expect(out).toContain('Engine: tasks.nvim 0.9.0, commit faf2078, in the browser (web+Lua5.4)');
    expect(out).not.toContain('Neovim');
  });
});
