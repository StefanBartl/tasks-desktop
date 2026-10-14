import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { STATE } from './global';

// The plan view of a large vault: the first tasks are drawn at once and the rest in the frames after, so the first
// stage does not wait for two thousand rows (measured without the chunks: about 50 ms for 600, 150 ms for 2000).

test.use({ locale: 'en-US' });

const state = (): { token: string } => JSON.parse(readFileSync(STATE, 'utf8')) as { token: string };

const PLAN = 'lib.nvim/big-plan';

/** The snapshot of the hub, made `n` tasks large; the last `planned` of them belong to the plan `PLAN`. */
async function bigSnapshot(page: Page, n: number, planned = 0): Promise<void> {
  await page.addInitScript((token) => sessionStorage.setItem('tasks-desktop.session', token), state().token);
  await page.route('**/api/tasks/snapshot', async (route) => {
    const headers = { ...route.request().headers() };
    delete headers['if-none-match'];
    const response = await route.fetch({ headers });
    if (response.status() !== 200) return route.fulfill({ response });
    const doc = (await response.json()) as { tasks: Record<string, unknown>[]; plans?: unknown[] };
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
        ...(i >= n - planned ? { plan: PLAN } : { plan: undefined }),
        // Stages in blocks of ids, so the first tasks of the whole list are not the first tasks of the plan.
        readiness: { state: 'ready', stage: Math.floor(i / 167), rank: i, leverage: 0, open_blockers: [] },
      });
    }
    const plans =
      planned > 0
        ? [{ id: PLAN, title: 'Big plan', status: 'doing', areas: ['lib.nvim'], phase_order: [], valid: true }]
        : [];
    await route.fulfill({ response, json: { ...doc, tasks, plans } });
  });
  await page.goto('/');
  await expect(page.getByRole('menubar')).toBeVisible();
}

/** Open the plan view from the list. */
async function openPlan(page: Page): Promise<void> {
  await page.getByRole('menuitem', { name: 'View', exact: true }).click();
  await page.getByRole('menuitemradio', { name: 'List', exact: true }).click();
  await expect(page.locator('button.row').first()).toBeVisible();
  await page.getByRole('menuitem', { name: 'View', exact: true }).click();
  await expect(page.getByRole('menuitemradio', { name: 'Plan', exact: true })).toBeVisible();
}

for (const n of [600, 2000]) {
  test(`the plan view of ${n} tasks draws the first ones at once and all of them soon`, async ({ page }) => {
    await bigSnapshot(page, n);
    await openPlan(page);
    // Time from the click to the frame after the stages are in the page.
    const first = await page.evaluate(
      () =>
        new Promise<{ ms: number; rows: number }>((resolve) => {
          const el = [...document.querySelectorAll('[role="menuitemradio"]')].find(
            (e) => e.textContent?.trim() === 'Plan',
          ) as HTMLElement;
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

test('another plan starts from the first tasks again, not from the number the last one had grown to', async ({
  page,
}) => {
  await bigSnapshot(page, 2000, 1500);
  await openPlan(page);
  await page.getByRole('menuitemradio', { name: 'Plan', exact: true }).click();
  await expect(page.locator('.stages li')).toHaveCount(2000);
  // Choose the plan inside the page. At the next frame the plan stands with its first tasks only: a limit that kept
  // the number the other plan had grown to would show the whole of it (1500 rows) at once.
  const atFrame = await page.evaluate(
    () =>
      new Promise<number>((resolve) => {
        const select = document.querySelector('.plan-select select') as HTMLSelectElement;
        select.value = 'lib.nvim/big-plan';
        select.dispatchEvent(new Event('change', { bubbles: true }));
        requestAnimationFrame(() => resolve(document.querySelectorAll('.stages li').length));
      }),
  );
  console.log(`plan switch: ${atFrame} rows at the next frame`);
  expect(atFrame).toBeGreaterThan(0);
  expect(atFrame).toBeLessThan(1000);
  await expect(page.locator('.stages li')).toHaveCount(1500);
});

test('leaving a plan does not draw the number of rows the plan had grown to', async ({ page }) => {
  await bigSnapshot(page, 2000, 1500);
  await openPlan(page);
  await page.getByRole('menuitemradio', { name: 'Plan', exact: true }).click();
  await expect(page.locator('.stages li')).toHaveCount(2000);
  await page.locator('.plan-select select').selectOption(PLAN);
  await expect(page.locator('.stages li')).toHaveCount(1500);
  // Back to every task. The first tasks of the whole list are not in the plan's rows, so each row drawn is a new one:
  // a limit that still held 1500 would build 1500 of them before it was set back, the first 200 are the work.
  const built = await page.evaluate(
    () =>
      new Promise<number>((resolve) => {
        let added = 0;
        const obs = new MutationObserver((records) => {
          for (const record of records) {
            for (const node of record.addedNodes) {
              if (node instanceof Element) added += (node.matches('li') ? 1 : 0) + node.querySelectorAll('li').length;
            }
          }
        });
        obs.observe(document.querySelector('.stages') as Element, { childList: true, subtree: true });
        const select = document.querySelector('.plan-select select') as HTMLSelectElement;
        select.value = '';
        select.dispatchEvent(new Event('change', { bubbles: true }));
        requestAnimationFrame(() => {
          obs.disconnect();
          resolve(added);
        });
      }),
  );
  console.log(`leaving the plan: ${built} rows built before the next frame`);
  expect(built).toBeLessThanOrEqual(300);
  await expect(page.locator('.stages li')).toHaveCount(2000);
});
