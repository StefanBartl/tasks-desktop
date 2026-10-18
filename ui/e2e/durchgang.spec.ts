import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { expectAccessible, violations, watchViolations } from './a11y';
import { STATE } from './global';

// The findings of the walk through the page (2026-10-17): layout, keyboard and wording, each with the test that was
// red before its fix. The page is the one of `app.spec.ts`, paired the same way; every test runs axe on the state
// it makes and ends with the policy violations of the page (none).

test.use({ locale: 'en-US' });

const state = (): { token: string } => JSON.parse(readFileSync(STATE, 'utf8')) as { token: string };

async function pair(page: Page): Promise<void> {
  await watchViolations(page);
  await page.addInitScript((token) => sessionStorage.setItem('tasks-desktop.session', token), state().token);
  await page.goto('/');
  await expect(page.getByRole('menubar')).toBeVisible();
}

test.afterEach(async ({ page }) => {
  expect(await violations(page)).toEqual([]);
});

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
  await expectAccessible(page, 'the list with the detail open');
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
  await expectAccessible(page, 'the list in a narrow window');
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
  await expectAccessible(page, 'the open Help menu');
  await page.keyboard.press('Escape');

  await showList(page);
  await page.getByRole('button', { name: 'Areas', exact: true }).click();
  const choice = page.getByRole('group', { name: 'Areas' });
  await expect(choice).toBeVisible();
  // A press on the padding of the popup (no control there) keeps it open: the person is still in the choice.
  await choice.getByRole('checkbox').first().focus();
  await choice.click({ position: { x: 3, y: 3 } });
  await expect(choice).toBeVisible();
  await expectAccessible(page, 'the open choice of areas');
  // Shift+Tab from the trigger leaves the choice for the control before it: the popup must not stay open behind.
  await page.getByRole('button', { name: 'Areas', exact: true }).focus();
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
  await expectAccessible(page, 'the list with a task without a priority and its detail');
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
  await expectAccessible(page, 'the detail with the graph open');
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
  const alert = page.getByRole('alert').filter({ hasText: /there is no such folder/ });
  await expect(alert).toBeVisible();
  // The alert is a live region of its own: not inside the polite status region, which would read it a second time
  // or at the wrong moment.
  await expect(alert.locator('xpath=ancestor::*[@aria-live or @role="status"]')).toHaveCount(0);
  await expect(page.getByRole('status').filter({ hasText: /there is no such folder/ })).toHaveCount(0);
  await expectAccessible(page, 'the vaults dialog with a refusal');
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
  await expectAccessible(page, 'the list with hidden hits');
});

test('the finished tasks under the list say "none of this area" for one area, not "none at all"', async ({ page }) => {
  await pair(page);
  await showList(page);
  await page.getByLabel('Show finished tasks under the list').check();
  const finished = page.getByRole('region', { name: 'Finished' });
  await expect(finished).toBeVisible();
  // The last 90 days: the fixture's finished tasks (2025-12-30 ... 2026-01-02) are out of it; another spec may have
  // finished a lib.nvim task today. With one area the engine is asked for that area alone, so an empty answer says
  // nothing about the period as a whole: the sentence must not claim that nothing was finished.
  await finished.getByLabel('Period').selectOption('90');
  await page.getByRole('button', { name: 'Areas', exact: true }).click();
  const choice = page.getByRole('group', { name: 'Areas' });
  await choice.getByRole('checkbox', { name: /^cascade\.nvim/ }).check();
  await page.keyboard.press('Escape');
  await expect(finished.getByText('No task of this area was finished in this period.')).toBeVisible();
  await expect(finished.getByText('No task was finished in this period.')).toHaveCount(0);
  await expectAccessible(page, 'the finished tasks of one area');
});

test('the finished view dims the old figures and says "Loading" until the answer of the new period is there', async ({ page }) => {
  await pair(page);
  let release: () => void = () => undefined;
  const gate = new Promise<void>((r) => (release = r));
  let held = false;
  await page.route('**/api/tasks/finished**', async (route) => {
    if (held) await gate;
    await route.continue();
  });
  await page.getByRole('menuitem', { name: 'View', exact: true }).click();
  await page.getByRole('menuitemradio', { name: 'Finished', exact: true }).click();
  const view = page.locator('.done');
  await expect(view).toHaveAttribute('aria-busy', 'false');
  held = true;
  await view.locator('section.head select').first().selectOption('all');
  await expect(view).toHaveAttribute('aria-busy', 'true');
  await expect(view.getByRole('status').filter({ hasText: 'Loading' })).toBeVisible();
  release();
  await expect(view).toHaveAttribute('aria-busy', 'false');
  await expect(view.getByRole('status').filter({ hasText: 'Loading' })).toHaveCount(0);
  await expectAccessible(page, 'the finished view after loading');
});

test('the menu bar is one tab stop: Tab leaves it, Left, Right, Home and End walk the menus', async ({ page }) => {
  await pair(page);
  const triggers = page.getByRole('menubar').getByRole('menuitem');
  const count = await triggers.count();
  expect(count).toBeGreaterThanOrEqual(4);
  // Only one trigger takes the tab stop.
  const stops = await page.evaluate(() => [...document.querySelectorAll('[role="menubar"] button.trigger')].filter((b) => (b as HTMLElement).tabIndex === 0).length);
  expect(stops).toBe(1);
  await triggers.first().focus();
  await page.keyboard.press('End');
  await expect(triggers.nth(count - 1)).toBeFocused();
  await page.keyboard.press('Home');
  await expect(triggers.first()).toBeFocused();
  await page.keyboard.press('ArrowRight');
  await expect(triggers.nth(1)).toBeFocused();
  // The trigger used last holds the stop; Tab goes past the bar, not to the next menu.
  await page.keyboard.press('Tab');
  await expect(page.getByRole('menubar').locator(':focus')).toHaveCount(0);
  await page.keyboard.press('Shift+Tab');
  await expect(triggers.nth(1)).toBeFocused();
  await expectAccessible(page, 'the menu bar');
});

test('"Show more" in the finished view loads the next page and adds it below the first', async ({ page }) => {
  await pair(page);
  // The hub's page is 100 tasks: the fixture has four finished ones, so the pages are made from the real answer.
  await page.route('**/api/tasks/finished**', async (route) => {
    const url = new URL(route.request().url());
    const response = await route.fetch();
    const doc = (await response.json()) as { items: Record<string, unknown>[]; total: number; limit: number; next_offset?: number };
    const offset = Number(url.searchParams.get('offset') ?? '0');
    const item = (i: number) => ({
      area: 'lib.nvim',
      slug: `paged-${i}`,
      done: '2025-12-30',
      kind: 'task',
      title: `Paged finished task ${i}`,
      id: `lib.nvim/paged-${i}`,
      file: `lib.nvim/Backlog/TASKS/2025-12-30_paged-${i}.md`,
    });
    const items = offset === 0 ? Array.from({ length: 100 }, (_, i) => item(i)) : Array.from({ length: 20 }, (_, i) => item(100 + i));
    const body = { ...doc, total: 120, limit: 100, items, ...(offset === 0 ? { next_offset: 100 } : { next_offset: undefined }) };
    await route.fulfill({ response, json: body });
  });
  await page.getByRole('menuitem', { name: 'View', exact: true }).click();
  await page.getByRole('menuitemradio', { name: 'Finished', exact: true }).click();
  const list = page.getByRole('region', { name: 'Finished tasks, newest first' });
  await expect(list.getByText('Paged finished task 99')).toBeVisible();
  await expect(list.getByText('Paged finished task 100')).toHaveCount(0);
  await page.getByRole('button', { name: 'Show more' }).click();
  await expect(list.getByText('Paged finished task 119')).toBeVisible();
  // The first page is still there, and with the last page the button is gone.
  await expect(list.getByText('Paged finished task 0', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Show more' })).toHaveCount(0);
  await expectAccessible(page, 'the finished view with two pages');
});

test('the marks of rows, cards and stage lines are explained with one tab stop each view, by the keyboard', async ({ page }) => {
  await pair(page);
  const legend = (scope: string, what: string) => page.locator(scope).getByRole('button', { name: `Explanation: ${what}` });
  const check = async (scope: string, what = 'the marks of a task') => {
    const button = legend(scope, what);
    await expect(button).toHaveCount(1);
    await button.focus();
    const tip = page.getByRole('tooltip');
    await expect(tip).toBeVisible();
    for (const words of ['Priority: 1', '↔ n', '⚑ n', 'not written']) await expect(tip).toContainText(words);
    // A screen reader hears it with the button, also without the popup.
    await expect(button).toHaveAttribute('aria-describedby', /\S/);
    await page.keyboard.press('Escape');
  };
  await showList(page);
  await check('p.count');
  await expectAccessible(page, 'the list with its legend');
  await page.getByRole('menuitem', { name: 'View', exact: true }).click();
  await page.getByRole('menuitemradio', { name: 'Board', exact: true }).click();
  await check('.wrap > p.count');
  await page.getByRole('menuitem', { name: 'View', exact: true }).click();
  await page.getByRole('menuitemradio', { name: 'Plan', exact: true }).click();
  // The plan explains its stages first, and says so in the name of the button.
  await check('section.stages', 'the stages and the marks of a task');
});

// The walk through every view in both languages and both themes (the part of the explanations task that asks for
// it): no key of the dictionary shows as text, the page does not scroll sideways, axe finds no contrast problem.
for (const lang of ['en', 'de'] as const) {
  for (const theme of ['light', 'dark'] as const) {
    test(`every view reads well in ${lang} and ${theme}: no raw key, no sideways scroll, no violation`, async ({ page }) => {
      test.slow();
      await page.addInitScript(
        ([l, th]) => {
          localStorage.setItem('tasks-desktop.lang', l!);
          localStorage.setItem('tasks-desktop.theme', th!);
        },
        [lang, theme],
      );
      await pair(page);
      // The memory was read: the menu has the words of the language, the page has the colours of the theme.
      await expect(page.getByRole('menuitem', { name: lang === 'de' ? 'Ansicht' : 'View', exact: true })).toBeVisible();
      const bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
      const lum = bg.match(/\d+/g)!.slice(0, 3).map(Number).reduce((x, y) => x + y, 0) / 3;
      expect(theme === 'dark' ? lum < 100 : lum > 150, `${theme} background ${bg}`).toBe(true);
      const viewMenu = page.getByRole('menubar').getByRole('menuitem').nth(1);
      await viewMenu.click();
      const count = await page.getByRole('menuitemradio').count();
      await page.keyboard.press('Escape');
      expect(count).toBeGreaterThan(4);
      for (let i = 0; i < count; i++) {
        await viewMenu.click();
        const radio = page.getByRole('menuitemradio').nth(i);
        const name = (await radio.textContent())?.trim() ?? String(i);
        await radio.click();
        await page.waitForTimeout(400);
        const bad = await page.evaluate(() => {
          const text = document.body.innerText;
          const keys = text.split(/\s+/).filter((w) => /^[a-z]+(\.[a-z0-9_-]+){1,}$/.test(w) && /^(today|plan|board|list|filter|hint|menu|check|graph|inbox|matrix|count|detail|nav|status|state|prop|vaults|remind|mark)\./.test(w));
          return { keys, wide: document.documentElement.scrollWidth - document.documentElement.clientWidth };
        });
        expect(bad.keys, `${lang} ${theme} ${name}: raw keys`).toEqual([]);
        expect(bad.wide, `${lang} ${theme} ${name}: sideways scroll`).toBeLessThanOrEqual(1);
        await expectAccessible(page, `${lang} ${theme} ${name}`);
      }
    });
  }
}
