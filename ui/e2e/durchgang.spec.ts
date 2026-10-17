import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { STATE } from './global';

// The findings of the walk through the page (2026-10-17): layout, keyboard and wording, each with the test that was
// red before its fix. The page is the one of `app.spec.ts`, paired the same way.

test.use({ locale: 'en-US' });

const state = (): { token: string } => JSON.parse(readFileSync(STATE, 'utf8')) as { token: string };

async function pair(page: Page): Promise<void> {
  await page.addInitScript((token) => sessionStorage.setItem('tasks-desktop.session', token), state().token);
  await page.goto('/');
  await expect(page.getByRole('menubar')).toBeVisible();
}

async function showList(page: Page): Promise<void> {
  await page.getByRole('menuitem', { name: 'View', exact: true }).click();
  await page.getByRole('menuitemradio', { name: 'List', exact: true }).click();
  await expect(page.locator('button.row').first()).toBeVisible();
}

test('the fields of the detail are one line tall (the text editor had taken their class)', async ({ page }) => {
  await pair(page);
  await showList(page);
  await page.locator('button.row').first().click();
  const title = page.locator('aside.detail .edit input').first();
  await expect(title).toBeVisible();
  const box = await title.boundingBox();
  expect(box, 'the title field has a box').not.toBeNull();
  // One line of text with its padding; the column rule made it 14rem (about 224px) tall.
  expect(box?.height ?? 0).toBeLessThan(60);
  const label = page.locator('aside.detail .edit label').first();
  const labelBox = await label.boundingBox();
  expect(labelBox?.height ?? 0).toBeLessThan(90);
});

test('in a narrow window the title of a row keeps a width and its tags wrap', async ({ page }) => {
  // One column, 448px for a row: the id column and four tags left nothing for the title before.
  await page.setViewportSize({ width: 480, height: 800 });
  await pair(page);
  await showList(page);
  // The row with the most tags is the one the tags would squeeze.
  const measured = await page.evaluate(() => {
    const rows = [...document.querySelectorAll<HTMLElement>('button.row')];
    let best: { tags: number; title: number; id: string } = { tags: -1, title: 0, id: '' };
    for (const row of rows) {
      const tags = row.querySelectorAll('.meta .tag').length;
      const title = row.querySelector<HTMLElement>('.title')?.getBoundingClientRect().width ?? 0;
      const id = row.querySelector('.id')?.textContent ?? '';
      if (tags > best.tags) best = { tags, title, id };
    }
    return best;
  });
  expect(measured.tags, 'a row with tags').toBeGreaterThanOrEqual(3);
  // 6rem at the page's 14px: the tags took it down to zero before.
  expect(measured.title, measured.id).toBeGreaterThanOrEqual(80);
});

test('the last menu opens inside the window, and a choice closes when the focus leaves it', async ({ page }) => {
  await page.setViewportSize({ width: 480, height: 800 });
  await pair(page);
  await page.getByRole('menuitem', { name: 'Help', exact: true }).click();
  const popup = page.getByRole('menu', { name: 'Help' });
  await expect(popup).toBeVisible();
  const box = await popup.boundingBox();
  expect(box, 'the popup has a box').not.toBeNull();
  expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(480);
  await page.keyboard.press('Escape');

  await showList(page);
  await page.getByRole('button', { name: /^Areas/ }).click();
  const choice = page.getByRole('group', { name: 'Areas' });
  await expect(choice).toBeVisible();
  // Shift+Tab leaves the choice for the control before it: the popup must not stay open behind.
  await page.keyboard.press('Shift+Tab');
  await expect(choice).toHaveCount(0);
});

async function capture(page: Page, title: string): Promise<void> {
  const dialog = page.getByRole('dialog', { name: 'New task' });
  await expect(async () => {
    if (!(await dialog.isVisible())) await page.keyboard.press('c');
    await expect(dialog).toBeVisible({ timeout: 1000 });
  }).toPass({ timeout: 10000 });
  await dialog.getByLabel('Title').fill(title);
  await dialog.locator('select').first().selectOption('lib.nvim');
  await dialog.getByRole('button', { name: 'Create' }).click();
  await expect(dialog).toHaveCount(0);
}

test('a sign on a row has a word for the screen reader, the count alone is live, the detail is a named landmark', async ({
  page,
}) => {
  await pair(page);
  await showList(page);
  await capture(page, 'Durchgang without a priority');
  // The "?" of a task without a priority is read as the word, not as a question mark.
  const row = page.getByRole('button', { name: /Durchgang without a priority.*no priority/ });
  await expect(row).toBeVisible();
  // The live region is the count only: no button is read out again with every change.
  const count = page.getByRole('status').filter({ hasText: /^\d+ of \d+$/ });
  await expect(count).toHaveCount(1);
  await expect(count.getByRole('button')).toHaveCount(0);
  // The detail is a landmark named for what it is, not for one of its sections.
  await row.click();
  await expect(page.getByRole('complementary', { name: 'Task detail' })).toBeVisible();
});

test('a blocker that is not in the list is no button, and "Close" is no direction of the graph', async ({ page }) => {
  await pair(page);
  await showList(page);
  // The hostile task waits on a markup id (not a task) and on lib.nvim/alpha (one).
  await page.locator('button.row', { hasText: 'lib.nvim/xss-frontmatter' }).first().click();
  const detail = page.getByRole('complementary', { name: 'Task detail' });
  await expect(detail.getByRole('heading', { name: 'Waits for' })).toBeVisible();
  const waits = detail.locator('h3:has-text("Waits for") + ul');
  await expect(waits.locator('li')).toHaveCount(2);
  await expect(waits.getByRole('button')).toHaveCount(1);
  await expect(waits.getByRole('button')).toContainText('lib.nvim/alpha');

  await detail.getByRole('button', { name: 'What do I need for this?' }).click();
  const direction = page.getByRole('group', { name: 'Direction' });
  await expect(direction).toBeVisible();
  await expect(direction.getByRole('button', { name: 'Close' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Close', exact: true }).first().click();
});

test('a refusal is an alert, a "Saved." is not', async ({ page }) => {
  await pair(page);
  await showList(page);
  await page.getByRole('menuitem', { name: 'Vaults', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Manage vaults ...' }).click();
  const dialog = page.getByRole('dialog', { name: 'Vaults' });
  await dialog.getByLabel(/^Name/).fill('nowhere');
  await dialog.getByLabel(/^Folder/).fill('Z:/no/such/folder/durchgang');
  await dialog.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(page.getByRole('alert').getByText(/there is no such folder/)).toBeVisible();
  await dialog.getByRole('button', { name: 'Close' }).click();
});

test('words that only match tasks the filters keep out say so', async ({ page }) => {
  await pair(page);
  await showList(page);
  // Only cascade.nvim is shown; the words are in the body of a lib.nvim task.
  await page.getByRole('button', { name: 'Areas', exact: true }).click();
  const choice = page.getByRole('group', { name: 'Areas' });
  await expect(choice).toBeVisible();
  await choice.getByRole('checkbox', { name: /^cascade\.nvim/ }).check();
  await page.keyboard.press('Escape');
  await page.getByPlaceholder('Search id and title').fill('plain body');
  await expect(page.getByText('The words occur in tasks the filters of the list keep out.')).toBeVisible();
});
