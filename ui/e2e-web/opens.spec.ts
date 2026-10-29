// The single-file page of the web variant, opened from disk in Chrome: it starts, makes no request, breaks no rule of its
// own policy, and with a folder chosen it shows the tasks of the vault. The folder is a fake one (the real picker needs a
// person); its files are the fixture vault of the hub's tests.

import { expect, test } from '@playwright/test';
import { fakePicker, pageUrl, vaultFiles, violations, watchPage } from './page';

test('the file opens from disk, starts its engine and asks for a folder, without a request', async ({ page }) => {
  const seen = await watchPage(page);
  await page.goto(pageUrl());
  await expect(page.getByRole('heading', { name: /Open a vault|Vault öffnen/ })).toBeVisible();
  // The engine runs in a worker of its own.
  await expect.poll(() => page.workers().length).toBe(1);
  // A real folder cannot be chosen here: the way in must say what it can do, not fail.
  expect(seen.errors).toEqual([]);
  expect(seen.requests).toEqual([]);
  expect(await violations(page)).toEqual([]);
});

test('with a folder chosen the app shows the tasks of the vault, still without a request', async ({ page }) => {
  const seen = await watchPage(page);
  await fakePicker(page, vaultFiles());
  await page.goto(pageUrl());
  await page.getByRole('button', { name: /Choose folder|Ordner wählen/ }).click();
  // The app takes the place of the way in: a task of the fixture vault is on the page.
  await expect(page.getByText('Eta tests').first()).toBeVisible({ timeout: 30_000 });
  expect(seen.errors).toEqual([]);
  expect(seen.requests).toEqual([]);
  expect(await violations(page)).toEqual([]);
});

test('the watch would see a request: the policy refuses it and says so', async ({ page }) => {
  // A detector that reports nothing proves nothing until it has reported something (the positive test).
  const seen = await watchPage(page);
  await page.goto(pageUrl());
  await expect(page.getByRole('heading', { name: /Open a vault|Vault öffnen/ })).toBeVisible();
  const outcome = await page.evaluate(async () => {
    const results: string[] = [];
    try {
      await fetch('https://example.invalid/data');
      results.push('fetch went out');
    } catch {
      results.push('fetch refused');
    }
    const img = new Image();
    img.src = 'https://example.invalid/pixel.png';
    try {
      new WebSocket('wss://example.invalid/socket');
      results.push('socket opened');
    } catch {
      results.push('socket refused');
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
    return results;
  });
  expect(outcome[0]).toBe('fetch refused');
  const seenByPolicy = (await violations(page)).join('\n');
  expect(seenByPolicy).toContain('connect-src');
  expect(seenByPolicy).toContain('img-src');
  expect(seen.errors.length).toBeGreaterThan(0);
});

test('a file changed in the folder shows when the window gets the focus back', async ({ page }) => {
  const seen = await watchPage(page);
  await fakePicker(page, vaultFiles());
  await page.goto(pageUrl());
  await page.getByRole('button', { name: /Choose folder|Ordner wählen/ }).click();
  await expect(page.getByText('Eta tests').first()).toBeVisible({ timeout: 30_000 });

  const path = 'cascade.nvim/ROADMAP/tasks/eta.md';
  await page.evaluate(
    ([file]) => {
      const w = window as unknown as { __setFile: (p: string, t: string) => void };
      // An editor saved the file with another title.
      w.__setFile(file as string, '---\ntitle: Eta was edited\nstatus: open\nprio: 2\n---\n\nBody.\n');
      window.dispatchEvent(new Event('focus'));
    },
    [path],
  );
  await expect(page.getByText('Eta was edited').first()).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText('Eta tests')).toHaveCount(0);
  expect(seen.requests).toEqual([]);
  expect(await violations(page)).toEqual([]);
});
