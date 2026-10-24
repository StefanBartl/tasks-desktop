import { svelte } from '@sveltejs/vite-plugin-svelte';
import { defineConfig } from 'vitest/config';

// The page is served by the hub on a fixed origin. Nothing is inlined: no
// data: URL, no inline script (the CSP of the shell allows 'self' only).
export default defineConfig({
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
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
