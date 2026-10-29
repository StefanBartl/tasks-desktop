// The floats in the web variant (the built tasks.html from disk): a task of the list opens in a float over it, the
// float moves and keeps its place in the browser's storage of the file, and a task is detached into a window of its own:
// the same file at `#task=<id>`, which shows that task alone once its folder is open.

import { expect, test, type Page } from '@playwright/test';
import { expectAccessible } from '../e2e/a11y';
import { disk, fakePicker, openVault, pageUrl, vaultFiles, violations, watchPage } from './page';

test.use({ locale: 'en-US' });

async function showList(page: Page): Promise<void> {
  await page.getByRole('menuitem', { name: 'View', exact: true }).click();
  await page.getByRole('menuitemradio', { name: 'List', exact: true }).click();
  await expect(page.locator('button.row').first()).toBeVisible();
}

test('a task of the list opens in a float over it, which moves and keeps its place', async ({ page }) => {
  const seen = await watchPage(page);
  await openVault(page, vaultFiles(), 'Next task');
  await showList(page);
  await expect(page.locator('aside.detail')).toHaveCount(0);
  await page.locator('button.row', { hasText: 'lib.nvim/beta' }).first().click();
  const float = page.getByRole('dialog', { name: 'Task' });
  await expect(float.locator('aside.detail .id')).toHaveText('lib.nvim/beta');
  await expectAccessible(page, 'the web list with a task in its float');

  const before = (await float.boundingBox())!;
  const handle = (await float.getByRole('button', { name: 'Move or resize the window' }).boundingBox())!;
  const from = { x: handle.x + handle.width / 2, y: handle.y + handle.height / 2 };
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(from.x - 40, from.y, { steps: 5 });
  await page.mouse.move(from.x - 80, from.y, { steps: 5 });
  await page.mouse.up();
  const after = (await float.boundingBox())!;
  expect(Math.abs(after.x - (before.x - 80))).toBeLessThanOrEqual(1);
  const kept = await page.evaluate(() => localStorage.getItem('tasks-desktop.floats'));
  expect(JSON.parse(kept ?? '{}').task.x).toBe(Math.round(after.x));
  await page.keyboard.press('Escape');
  await expect(float).toHaveCount(0);
  expect(seen.requests).toEqual([]);
  expect(await violations(page)).toEqual([]);
  expect(seen.errors).toEqual([]);
});

test('a task is detached into a new window of the same file, at the task', async ({ page, context }) => {
  const seen = await watchPage(page);
  await openVault(page, vaultFiles(), 'Next task');
  await showList(page);
  await page.locator('button.row', { hasText: 'lib.nvim/beta' }).first().click();
  const float = page.getByRole('dialog', { name: 'Task' });
  await expect(float.locator('aside.detail .id')).toHaveText('lib.nvim/beta');
  const [win] = await Promise.all([
    context.waitForEvent('page'),
    float.getByRole('button', { name: 'Open in a window of its own' }).click(),
  ]);
  await expect(float).toHaveCount(0);
  // The same file, at the task. Its own engine asks for the folder first (this test's fake folder is not in it).
  expect(win.url()).toBe(`${pageUrl()}#task=lib.nvim%2Fbeta`);
  await expect(win.getByRole('button', { name: /Choose folder/ })).toBeVisible({ timeout: 30_000 });
  await win.close();
  expect(seen.requests).toEqual([]);
  expect(seen.errors).toEqual([]);
});

test('a window of one task keeps the keys of the hidden view off its task, and lets go of it into a page of views', async ({ page }) => {
  const seen = await watchPage(page);
  // The view kept in this browser is the list: hidden behind the task, its keys must not reach it.
  await page.addInitScript(() => localStorage.setItem('tasks-desktop.view', 'list'));
  await fakePicker(page, vaultFiles());
  await page.goto(`${pageUrl()}#task=lib.nvim%2Fbeta`);
  await page.getByRole('button', { name: /Choose folder/ }).click();
  const alone = page.locator('main aside.detail .id');
  await expect(alone).toHaveText('lib.nvim/beta', { timeout: 30_000 });
  await page.locator('main').focus();
  // j and k of the list, o, x: nothing changes the task or opens a float over it.
  for (const key of ['j', 'j', 'k', 'o', 'x']) await page.keyboard.press(key);
  await expect(alone).toHaveText('lib.nvim/beta');
  await expect(page.getByRole('dialog', { name: 'Task' })).toHaveCount(0);
  await expect(page.locator('section.list')).toHaveCount(0);
  // Escape lets go of it: the page of the list, with no detail.
  await page.keyboard.press('Escape');
  await expect(page.locator('section.list')).toBeVisible();
  await expect(page.locator('aside.detail')).toHaveCount(0);
  // A task chosen there opens in the float over the list, as in any page of views: no detail in place of the list.
  await page.locator('button.row', { hasText: 'lib.nvim/alpha' }).first().click();
  const float = page.getByRole('dialog', { name: 'Task' });
  await expect(float.locator('aside.detail .id')).toHaveText('lib.nvim/alpha');
  await expect(page.locator('section.list')).toHaveCount(1);
  await expect(page.locator('aside.detail')).toHaveCount(1);
  expect(seen.requests).toEqual([]);
  expect(seen.errors).toEqual([]);
});

test('a window of one task keeps the task in its address until it lets go of it: a reload then shows the views', async ({ page }) => {
  const seen = await watchPage(page);
  await page.addInitScript(() => localStorage.setItem('tasks-desktop.view', 'list'));
  await fakePicker(page, vaultFiles());
  await page.goto(`${pageUrl()}#task=lib.nvim%2Fbeta`);
  await page.getByRole('button', { name: /Choose folder/ }).click();
  const alone = page.locator('main aside.detail .id');
  await expect(alone).toHaveText('lib.nvim/beta', { timeout: 30_000 });
  // While it shows the task alone, a reload opens the task again: the fragment stays.
  expect(new URL(page.url()).hash).toBe('#task=lib.nvim%2Fbeta');
  await page.locator('main').focus();
  await page.keyboard.press('Escape');
  await expect(page.locator('section.list')).toBeVisible();
  await expect.poll(() => new URL(page.url()).hash).toBe('');
  await page.reload();
  await page.getByRole('button', { name: /Choose folder|fixture-vault/ }).first().click({ timeout: 30_000 });
  await expect(page.locator('section.list')).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('aside.detail')).toHaveCount(0);
  expect(seen.requests).toEqual([]);
  expect(seen.errors).toEqual([]);
});

test('Enter in the summary writes it and keeps the focus there; keys that fall onto the page do not reach the list under the float', async ({ page }) => {
  const seen = await watchPage(page);
  await openVault(page, vaultFiles(), 'Next task');
  await showList(page);
  // One mark, which Escape on the page would take away.
  const alpha = page.locator('button.row', { hasText: 'lib.nvim/alpha' }).first();
  await alpha.click();
  const float = page.getByRole('dialog', { name: 'Task' });
  await expect(float.locator('aside.detail .id')).toHaveText('lib.nvim/alpha');
  await page.keyboard.press('Escape');
  await expect(float).toHaveCount(0);
  await expect(alpha).toBeFocused();
  await page.keyboard.press('x');
  await expect(page.locator('input.mark:checked')).toHaveCount(1);
  await page.locator('button.row', { hasText: 'lib.nvim/beta' }).first().click();
  await expect(float.locator('aside.detail .id')).toHaveText('lib.nvim/beta');
  const summary = float.getByLabel('Summary', { exact: true });
  await summary.fill('Written by Enter');
  await summary.press('Enter');
  await expect.poll(async () => (await disk(page))['lib.nvim/ROADMAP/tasks/beta.md']).toMatch(/\nsummary: Written by Enter\n/);
  await expect(float.getByLabel('Summary', { exact: true })).toHaveValue('Written by Enter');
  // The focus is in the summary again (the fields are drawn anew after a write), not on the page.
  await expect(float.getByLabel('Summary', { exact: true })).toBeEditable();
  await expect(float.getByLabel('Summary', { exact: true })).toBeFocused();
  // A focus that fell onto the page all the same: j does not change the task of the float, Escape does not take the
  // marks away behind it (it closes the float).
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.keyboard.press('j');
  await expect(float.locator('aside.detail .id')).toHaveText('lib.nvim/beta');
  await page.keyboard.press('Escape');
  await expect(float).toHaveCount(0);
  await expect(page.locator('input.mark:checked')).toHaveCount(1);
  expect(seen.requests).toEqual([]);
  expect(seen.errors).toEqual([]);
});

test('Enter in the summary of the inbox keeps the focus there: the next letter is typed, not a key of the inbox', async ({ page }) => {
  const seen = await watchPage(page);
  await openVault(page, vaultFiles(), 'Next task');
  await page.getByRole('menuitem', { name: 'View', exact: true }).click();
  await page.getByRole('menuitemradio', { name: 'Inbox', exact: true }).click();
  const detail = page.locator('main aside.detail');
  await expect(detail.locator('.id')).not.toHaveText('');
  const id = (await detail.locator('.id').innerText()).trim();
  const [area, name] = id.split('/');
  const file = `${area}/ROADMAP/tasks/${name}.md`;
  const effortOf = async (): Promise<string | null> => (await disk(page))[file]?.match(/\neffort: .*\n/)?.[0] ?? null;
  const effortBefore = await effortOf();
  const summary = detail.getByLabel('Summary', { exact: true });
  await summary.fill('Inbox summary');
  await summary.press('Enter');
  await expect.poll(async () => (await disk(page))[file]).toMatch(/\nsummary: Inbox summary\n/);
  // The write has ended (the field is no longer read-only while it is under way) and the field has the focus.
  await expect(detail.getByLabel('Summary', { exact: true })).toBeEditable();
  await expect(detail.getByLabel('Summary', { exact: true })).toBeFocused();
  // s is a key of the inbox (effort S); in the field it is a letter.
  await page.keyboard.press('s');
  await expect(detail.getByLabel('Summary', { exact: true })).toHaveValue('Inbox summarys');
  expect(await effortOf()).toBe(effortBefore);
  expect(seen.requests).toEqual([]);
  expect(seen.errors).toEqual([]);
});

test('one task after the other is captured with c, its title and Enter: the float of the new task takes c too', async ({ page }) => {
  const seen = await watchPage(page);
  await openVault(page, vaultFiles(), 'Next task');
  await showList(page);
  const capture = page.getByRole('dialog', { name: 'New task' });
  const float = page.getByRole('dialog', { name: 'Task' });
  await page.locator('main').focus();
  for (const title of ['Loop capture one', 'Loop capture two']) {
    await page.keyboard.press('c');
    await expect(capture).toBeVisible();
    await page.keyboard.type(title);
    await page.keyboard.press('Enter');
    await expect(capture).toHaveCount(0, { timeout: 30_000 });
    await expect(float.locator('aside.detail .task-title')).toHaveText(title);
  }
  // In a field of the float, c is a letter.
  const summary = float.getByLabel('Summary', { exact: true });
  await summary.focus();
  await page.keyboard.press('c');
  await expect(capture).toHaveCount(0);
  await expect(summary).toHaveValue('c');
  expect(seen.requests).toEqual([]);
  expect(seen.errors).toEqual([]);
});

test('the file opened at a task shows that task alone once the folder is open', async ({ page }) => {
  const seen = await watchPage(page);
  await fakePicker(page, vaultFiles());
  await page.goto(`${pageUrl()}#task=lib.nvim%2Fbeta`);
  await page.getByRole('button', { name: /Choose folder/ }).click();
  await expect(page.locator('main aside.detail .id')).toHaveText('lib.nvim/beta', { timeout: 30_000 });
  await expect(page.locator('section.list')).toHaveCount(0);
  await expect(page.getByRole('dialog', { name: 'Task' })).toHaveCount(0);
  await expectAccessible(page, 'the web window of one task');
  await showList(page);
  await expect(page.locator('aside.detail')).toHaveCount(0);
  expect(seen.requests).toEqual([]);
  expect(await violations(page)).toEqual([]);
  expect(seen.errors).toEqual([]);
});
