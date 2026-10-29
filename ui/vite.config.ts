import { readFileSync } from 'node:fs';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { defineConfig } from 'vitest/config';

const test = {
  environment: 'node' as const,
  include: ['src/**/*.test.ts'],
};

// `vite build --mode web` builds the page of the web variant: one module with everything in it, out of `dist-web/`.
// `web/pack.mjs` turns that into the single `tasks.html` (script, style, engine parts embedded, the CSP).
// Nothing in it may fetch: no preload, no split chunk, no file next to the page.
const web = defineConfig({
  plugins: [svelte()],
  base: './',
  define: {
    __WEB_VERSION__: JSON.stringify((JSON.parse(readFileSync('package.json', 'utf8')) as { version: string }).version),
    __WEB_BUILD__: JSON.stringify(process.env['WEB_BUILD'] ?? null),
  },
  build: {
    outDir: 'dist-web',
    target: 'es2022',
    assetsInlineLimit: 0,
    modulePreload: false,
    cssCodeSplit: false,
    sourcemap: false,
    chunkSizeWarningLimit: 1200,
    rollupOptions: {
      input: 'index.web.html',
      output: { codeSplitting: false },
    },
  },
  test,
});

// The page is served by the hub on a fixed origin. Nothing is inlined: no
// data: URL, no inline script (the CSP of the shell allows 'self' only).
const hub = defineConfig({
  plugins: [svelte()],
  base: './',
  build: {
    outDir: 'dist',
    target: 'es2022',
    assetsInlineLimit: 0,
    modulePreload: { polyfill: false },
    sourcemap: false,
    // The page comes from 127.0.0.1 and is part of the binary, so the size of the one chunk (about 680 kB, 218 kB
    // gzip) costs no load time; the default limit of 500 kB is meant for pages that cross a network. The limit is a
    // little above what the page weighs, so that a jump in size still shows as a warning.
    chunkSizeWarningLimit: 800,
  },
  test,
});

export default ({ mode }: { mode: string }) => (mode === 'web' ? web : hub);
