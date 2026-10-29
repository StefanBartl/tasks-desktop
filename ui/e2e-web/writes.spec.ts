// Writing in the single-file page, opened from disk in Chrome: a task is made, a field is set, the task is finished, and
// when another program changed a file meanwhile, nothing is overwritten. The folder is a fake one that the test also
// reads (the files on the fake disk are what the person's git would see).

import { expect, test, type Page } from '@playwright/test';
import { disk, editOnDisk, fakePicker, pageUrl, vaultFiles, violations, watchPage } from './page';

async function openVault(page: Page, files: Record<string, string> = vaultFiles()): Promise<void> {
  await fakePicker(page, files);
  await page.goto(pageUrl());
  await page.getByRole('button', { name: /Choose folder|Ordner wählen/ }).click();
  await expect(page.getByText('Eta tests').first()).toBeVisible({ timeout: 30_000 });
}

async function showList(page: Page): Promise<void> {
  await page.getByRole('menuitem', { name: /^(View|Ansicht)$/ }).click();
  await page.getByRole('menuitemradio', { name: /^(List|Liste)$/ }).click();
  await expect(page.locator('button.row').first()).toBeVisible();
}

/** The dialog of the capture, opened with its key (the menu may hold the focus: pressed again until it is there). */
async function capture(page: Page, title: string): Promise<void> {
  const dialog = page.getByRole('dialog', { name: /^(New task|Neuer Task)$/ });
  await expect(async () => {
    if (!(await dialog.isVisible())) await page.keyboard.press('c');
    await expect(dialog).toBeVisible({ timeout: 1000 });
  }).toPass({ timeout: 10_000 });
  await dialog.getByLabel(/Title|Titel/).fill(title);
  await dialog.locator('select').first().selectOption('lib.nvim');
  await dialog.getByRole('button', { name: /^(Create|Anlegen)$/ }).click();
  await expect(dialog).toHaveCount(0, { timeout: 30_000 });
}

test('a task is made, a field is set and the task is finished: the files on the disk are written', async ({ page }) => {
  const seen = await watchPage(page);
  await openVault(page);
  const before = await disk(page);

  // 1. made
  await capture(page, 'Web write e2e');
  const made = await disk(page);
  const file = 'lib.nvim/ROADMAP/tasks/web-write-e2e.md';
  expect(made[file]).toMatch(/^---\ntitle: Web write e2e\n/);
  expect(Object.keys(made).filter((p) => made[p] !== before[p]).sort()).toEqual(['lib.nvim/ROADMAP/TASKS.md', file]);
  expect(made['lib.nvim/ROADMAP/TASKS.md']).toContain('web-write-e2e');

  // 2. a field set in the detail
  await showList(page);
  await page.locator('button.row', { hasText: 'lib.nvim/web-write-e2e' }).first().click();
  const detail = page.locator('aside.detail');
  await expect(detail.locator('.id')).toHaveText('lib.nvim/web-write-e2e');
  await detail.getByLabel(/Effort|Aufwand/).selectOption('M');
  await expect.poll(async () => (await disk(page))[file]).toMatch(/\neffort: M\n/);
  // nothing else changed for that
  const set = await disk(page);
  expect(Object.keys(set).filter((p) => set[p] !== made[p]).sort()).toEqual(['lib.nvim/ROADMAP/TASKS.md', file]);

  // 3. finished: the file moves into the Backlog
  await detail.getByRole('button', { name: /Finish \.\.\.|Erledigen \.\.\./ }).click();
  const done = page.getByRole('dialog', { name: /Finish this task\?|Diesen Task erledigen\?/ });
  await expect(done).toBeVisible();
  await done.getByRole('button', { name: /^(Finish|Erledigen)$/ }).click();
  await expect(done).toHaveCount(0, { timeout: 30_000 });
  const finished = await disk(page);
  expect(finished[file]).toBeUndefined();
  const moved = Object.keys(finished).filter((p) => p.startsWith('lib.nvim/Backlog/') && p.endsWith('_web-write-e2e.md'));
  expect(moved).toHaveLength(1);
  expect(finished[moved[0] as string]).toMatch(/\nstatus: done\n/);
  expect(finished[moved[0] as string]).toMatch(/\neffort: M\n/);
  expect(finished['lib.nvim/Backlog/README.md']).toContain('web-write-e2e');
  // the rest of the vault is exactly as it was
  for (const path of Object.keys(before)) {
    if (path === 'lib.nvim/Backlog/README.md' || path === 'lib.nvim/ROADMAP/TASKS.md') continue;
    expect(finished[path], path).toBe(before[path]);
  }
  await expect(page.locator('button.row', { hasText: 'lib.nvim/web-write-e2e' })).toHaveCount(0);

  expect(seen.errors).toEqual([]);
  expect(seen.requests).toEqual([]);
  expect(await violations(page)).toEqual([]);
});

test('a file that another program changed meanwhile is not overwritten: the page says so, shows the disk, and a second try works', async ({ page }) => {
  const seen = await watchPage(page);
  await openVault(page);
  await showList(page);
  const file = 'lib.nvim/ROADMAP/tasks/beta.md';
  const original = (await disk(page))[file] as string;

  // An editor saves beta with another title; the page has not looked at the folder since (no focus, no timer).
  const foreign = original.replace('title: Beta waits for alpha', 'title: Beta edited elsewhere');
  await editOnDisk(page, file, foreign);

  await page.locator('button.row', { hasText: 'lib.nvim/beta' }).first().click();
  const detail = page.locator('aside.detail');
  await expect(detail.locator('.id')).toHaveText('lib.nvim/beta');
  await detail.getByLabel(/Effort|Aufwand/).selectOption('L');

  // The page tells it, and what is on the disk is what the editor wrote.
  await expect(page.getByRole('alert').getByText(/changed meanwhile|inzwischen geändert/)).toBeVisible({ timeout: 30_000 });
  expect((await disk(page))[file]).toBe(foreign);
  // The list was read again: the editor's title is on the page.
  await expect(page.getByText('Beta edited elsewhere').first()).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText('Beta waits for alpha')).toHaveCount(0);

  // Trying again works on the version that is there.
  await expect(detail.locator('.id')).toHaveText('lib.nvim/beta');
  await detail.getByLabel(/Effort|Aufwand/).selectOption('L');
  await expect.poll(async () => (await disk(page))[file]).toMatch(/\neffort: L\n/);
  expect((await disk(page))[file]).toContain('title: Beta edited elsewhere');

  expect(seen.requests).toEqual([]);
  expect(await violations(page)).toEqual([]);
});

test('closing the page is asked about while a write is under way, and not when none is', async ({ page }) => {
  await watchPage(page);
  await openVault(page);
  await showList(page);
  const file = 'lib.nvim/ROADMAP/tasks/beta.md';
  // what the browser does on leaving: the event goes to the page, and a handler that wants a question cancels it
  const asked = () =>
    page.evaluate(() => {
      const event = new Event('beforeunload', { cancelable: true });
      window.dispatchEvent(event);
      return event.defaultPrevented;
    });
  expect(await asked()).toBe(false);

  await page.evaluate(() => ((window as unknown as { __slowClose: number }).__slowClose = 1500));
  await page.locator('button.row', { hasText: 'lib.nvim/beta' }).first().click();
  await page.locator('aside.detail').getByLabel(/Effort|Aufwand/).selectOption('L');
  await expect.poll(asked, { timeout: 10_000 }).toBe(true);

  await page.evaluate(() => ((window as unknown as { __slowClose: number }).__slowClose = 0));
  await expect.poll(async () => (await disk(page))[file], { timeout: 30_000 }).toMatch(/\neffort: L\n/);
  await expect.poll(asked, { timeout: 10_000 }).toBe(false);
});

test('a task whose file was deleted meanwhile is not written back: nothing is created, the page drops the task', async ({ page }) => {
  await watchPage(page);
  await openVault(page);
  await showList(page);
  const file = 'lib.nvim/ROADMAP/tasks/beta.md';
  const before = await disk(page);
  await page.evaluate((path) => (window as unknown as { __disk: { remove(p: string): void } }).__disk.remove(path), file);

  await page.locator('button.row', { hasText: 'lib.nvim/beta' }).first().click();
  await page.locator('aside.detail').getByLabel(/Effort|Aufwand/).selectOption('L');
  await expect(page.getByRole('alert').getByText(/changed meanwhile|inzwischen geändert/)).toBeVisible({ timeout: 30_000 });
  const after = await disk(page);
  expect(after[file]).toBeUndefined();
  expect(Object.keys(after).sort()).toEqual(Object.keys(before).filter((p) => p !== file).sort());
  await expect(page.locator('button.row', { hasText: 'lib.nvim/beta' })).toHaveCount(0, { timeout: 30_000 });
});
