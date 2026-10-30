// The shortcut of the web variant (Options > Create a shortcut ...): Chrome saves no downloaded .lnk or .url, so the
// page gives the lines for Windows' "New > Shortcut" to copy, Chrome as an app window and the plain address, and points
// to the start script of tasks-web. The two ways that start a program carry the warning. That Windows makes the link
// from the line is the hand run.

import { expect, test } from '@playwright/test';
import { expectAccessible } from '../e2e/a11y';
import { openVault, pageUrl, vaultFiles, violations, watchPage } from './page';

const CHROME = '"C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe"';

test('a shortcut to the page: the lines to copy for Chrome and the default browser, the warning where a program starts', async ({
  page,
  context,
}) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  const seen = await watchPage(page);
  await openVault(page, vaultFiles());
  // What goes to the clipboard is recorded on the way.
  await page.evaluate(() => {
    const w = window as unknown as { __copied: string[] };
    w.__copied = [];
    const write = navigator.clipboard.writeText.bind(navigator.clipboard);
    navigator.clipboard.writeText = async (text: string) => {
      w.__copied.push(text);
      return write(text);
    };
  });
  // A task in the address is not part of the shortcut: it opens the page.
  await page.evaluate(() => (location.hash = '#task=x/y'));
  await page.getByRole('menuitem', { name: 'Options', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Create a shortcut ...', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Shortcut to this page' });
  await expect(dialog).toBeVisible();

  const chrome = dialog.getByRole('region', { name: 'In a Chrome window of its own' });
  const browser = dialog.getByRole('region', { name: 'In the default browser' });
  await expect(chrome.getByRole('textbox')).toHaveValue(`${CHROME} --app=${pageUrl()}`);
  await expect(browser.getByRole('textbox')).toHaveValue(pageUrl());
  // Chrome and the start script start a program: each says so; the plain address does not.
  await expect(dialog.getByRole('note')).toHaveCount(2);
  await expect(chrome.getByRole('note')).toContainText('Security software or the policies of this computer');
  await expect(browser.getByRole('note')).toHaveCount(0);
  await expect(dialog.getByRole('region', { name: 'Start script (tasks-web)' }).getByRole('note')).toHaveCount(1);
  await expect(dialog).toContainText('start-tasks.cmd /shortcut');
  await expectAccessible(page, 'the shortcut dialog');

  await chrome.getByRole('button', { name: 'Copy' }).click();
  await expect(page.getByText('Copied: paste it as the location of the new shortcut.')).toBeVisible();
  await browser.getByRole('button', { name: 'Copy' }).click();
  const copied = await page.evaluate(() => (window as unknown as { __copied: string[] }).__copied);
  expect(copied).toEqual([`${CHROME} --app=${pageUrl()}`, pageUrl()]);

  await dialog.getByRole('button', { name: 'Close' }).click();
  await expect(dialog).toBeHidden();
  expect(seen.errors).toEqual([]);
  expect(seen.requests).toEqual([]);
  expect(await violations(page)).toEqual([]);
});
