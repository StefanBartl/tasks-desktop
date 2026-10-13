import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';

// The plan view of a large vault: the first tasks are drawn at once and the rest in the frames after, so the first
// stage does not wait for two thousand rows (measured without the chunks: about 50 ms for 600, 150 ms for 2000).

import { STATE } from './global';

test.use({ locale: 'en-US' });

const state = (): { token: string } => JSON.parse(readFileSync(STATE, 'utf8')) as { token: string };

for (const n of [600, 2000]) {
  test(`the plan view of ${n} tasks draws the first ones at once and all of them soon`, async ({ page }) => {
    await page.addInitScript((token) => sessionStorage.setItem('tasks-desktop.session', token), state().token);
    await page.route('**/api/tasks/snapshot', async (route) => {
      const headers = { ...route.request().headers() };
      delete headers['if-none-match'];
      const response = await route.fetch({ headers });
      if (response.status() !== 200) return route.fulfill({ response });
      const doc = (await response.json()) as { tasks: Record<string, unknown>[]; counts: Record<string, number> };
      const base = doc.tasks;
      const tasks: Record<string, unknown>[] = [];
      for (let i = 0; i < n; i += 1) {
        const from = base[i % base.length] as Record<string, unknown>;
        tasks.push({
          ...from,
          id: `lib.nvim/big-${i}`,
          slug: `big-${i}`,
          title: `Big task number ${i} with a title of a usual length`,
          file: `lib.nvim/ROADMAP/tasks/big-${i}.md`,
          readiness: { state: 'ready', stage: i % 12, rank: i, leverage: 0, open_blockers: [] },
        });
      }
      await route.fulfill({ response, json: { ...doc, tasks } });
    });
    await page.goto('/');
    await expect(page.getByRole('menubar')).toBeVisible();
    await page.getByRole('menuitem', { name: 'View', exact: true }).click();
    await page.getByRole('menuitemradio', { name: 'List', exact: true }).click();
    await expect(page.locator('button.row').first()).toBeVisible();
    await page.getByRole('menuitem', { name: 'View', exact: true }).click();
    const item = page.getByRole('menuitemradio', { name: 'Plan', exact: true });
    await expect(item).toBeVisible();
    // Time from the click to the frame after the stages are in the page.
    const first = await page.evaluate(
      () =>
        new Promise<{ ms: number; rows: number }>((resolve) => {
          const el = [...document.querySelectorAll('[role="menuitemradio"]')].find((e) => e.textContent?.trim() === 'Plan') as HTMLElement;
          const t0 = performance.now();
          const done = (rows: number) =>
            requestAnimationFrame(() => requestAnimationFrame(() => resolve({ ms: performance.now() - t0, rows })));
          const obs = new MutationObserver(() => {
            if (document.querySelector('.stages .stage')) {
              obs.disconnect();
              done(document.querySelectorAll('.stages li').length);
            }
          });
          obs.observe(document.body, { childList: true, subtree: true });
          el.click();
        }),
    );
    console.log(`plan n=${n}: first stage after ${Math.round(first.ms)} ms with ${first.rows} rows`);
    // Not all at once: the first frame holds the first tasks only.
    expect(first.rows).toBeGreaterThan(0);
    expect(first.rows).toBeLessThan(n);
    // And all of them soon, each stage heading with the count of its whole stage.
    await expect(page.locator('.stages li')).toHaveCount(n);
  });
}
