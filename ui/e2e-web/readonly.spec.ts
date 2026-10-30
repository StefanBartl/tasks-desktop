// The single-file page in a browser without `showDirectoryPicker` (Firefox, Safari): the folder comes through an
// `<input webkitdirectory>`, the vault is shown and searched, a change is refused with the reason, and the page makes no
// request. It runs in Firefox and WebKit as they are (no picker there) and in Chrome with the picker taken away.

import { expect, test, type Page } from '@playwright/test';
import { closeFloat, FIXTURE, pageUrl, vaultFiles, violations, watchPage } from './page';

async function withoutPicker(page: Page): Promise<void> {
  await page.addInitScript(() => {
    Object.defineProperty(window, 'showDirectoryPicker', { value: undefined, configurable: true });
  });
}

async function chooseByInput(page: Page): Promise<void> {
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: /Choose folder|Ordner wählen/ }).click();
  await (await chooser).setFiles(FIXTURE);
}

test('without the picker the vault is read through the input, shown read only, and a change is refused', async ({ page }) => {
  const seen = await watchPage(page);
  const onDisk = vaultFiles();
  await withoutPicker(page);
  await page.goto(pageUrl());
  // The way in says what this browser can do, and still offers the one button.
  await expect(page.getByText(/cannot write into a folder|kann nicht in einen Ordner schreiben/)).toBeVisible();
  await expect(page.getByText(/Used before|Zuletzt genutzt/)).toHaveCount(0);
  await chooseByInput(page);
  await expect(page.getByText('Eta tests').first()).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole('status').filter({ hasText: /Read only|Nur lesen/ })).toBeVisible();

  // A change goes to the hub of the page, which answers read_only: the person is told, the field keeps the value.
  await closeFloat(page);
  await page.getByRole('menuitem', { name: /^(View|Ansicht)$/ }).click();
  await page.getByRole('menuitemradio', { name: /^(List|Liste)$/ }).click();
  await page.locator('button.row', { hasText: 'Eta tests' }).first().click();
  const detail = page.locator('aside.detail');
  const effort = detail.getByLabel(/Effort|Aufwand/);
  const before = await effort.inputValue();
  const other = before === 'M' ? 'L' : 'M';
  await effort.selectOption(other);
  await expect(page.getByRole('alert').filter({ hasText: /Nothing was saved|Nichts gespeichert/ })).toBeVisible({ timeout: 15_000 });
  await expect(detail.getByLabel(/Effort|Aufwand/)).toHaveValue(before);

  // Nothing was written to the folder the page was given.
  expect(vaultFiles()).toEqual(onDisk);
  expect(seen.errors).toEqual([]);
  expect(seen.requests).toEqual([]);
  expect(await violations(page)).toEqual([]);
});

test('a browser with the picker never shows the read only way in', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'chrome', 'only Chrome has the picker');
  await page.goto(pageUrl());
  await expect(page.getByRole('button', { name: /Choose folder|Ordner wählen/ })).toBeVisible();
  await expect(page.getByText(/cannot write into a folder|kann nicht in einen Ordner schreiben/)).toHaveCount(0);
});
