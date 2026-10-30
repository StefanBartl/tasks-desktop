import { defineConfig } from '@playwright/test';

// The single-file page of the web variant, opened from disk. No hub, no server: `pnpm web:build` makes the file first.
// The system's Chrome is used (`channel`), as for the hub's tests. Firefox and WebKit are Playwright's own builds
// (`pnpm exec playwright install firefox webkit`, about 184 MiB); they run only what those engines can do: the read only
// way in and the record of the browser APIs the page needs (`engines.spec.ts`). Without them installed, leave them out
// with `--project=chrome`.
export default defineConfig({
  testDir: './e2e-web',
  testMatch: /.*\.spec\.ts/,
  workers: 1,
  fullyParallel: false,
  timeout: 60_000,
  reporter: 'list',
  use: {
    trace: 'retain-on-failure',
    screenshot: 'off',
    video: 'off',
  },
  projects: [
    { name: 'chrome', use: { channel: 'chrome' } },
    { name: 'firefox', use: { browserName: 'firefox' }, testMatch: /(readonly|engines)\.spec\.ts/ },
    { name: 'webkit', use: { browserName: 'webkit' }, testMatch: /(readonly|engines)\.spec\.ts/ },
  ],
});
