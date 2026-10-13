import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { STATE } from './global';
import { pairingLink } from './hub';

test.use({ locale: 'en-US' });

const state = (): { config: string; vault: string; token: string } =>
  JSON.parse(readFileSync(STATE, 'utf8')) as { config: string; vault: string; token: string };

/** Everything the page reports about a policy it broke, from the start. */
async function watchViolations(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const w = window as unknown as { __violations: string[] };
    w.__violations = [];
    document.addEventListener('securitypolicyviolation', (e) => {
      w.__violations.push(`${e.violatedDirective} ${e.blockedURI}`);
    });
  });
}

async function violations(page: Page): Promise<string[]> {
  return page.evaluate(() => (window as unknown as { __violations: string[] }).__violations);
}

/** What the page wrote to the console: an error or a warning is a finding. */
const consoleProblems = new WeakMap<Page, string[]>();

/** The tab holds the session, as it does after the link was followed. */
async function pair(page: Page): Promise<void> {
  await prepare(page);
  await page.addInitScript((token) => {
    sessionStorage.setItem('tasks-desktop.session', token);
  }, state().token);
  await page.goto('/');
  await expect(page.getByRole('menubar')).toBeVisible();
}

/** The link of `tasks-hub open`, followed. Ten of these a minute at most. */
async function pairByLink(page: Page): Promise<void> {
  await prepare(page);
  await page.goto(pairingLink(state().config));
  await expect(page.getByRole('menubar')).toBeVisible();
}

async function prepare(page: Page): Promise<void> {
  const problems: string[] = [];
  consoleProblems.set(page, problems);
  page.on('console', (m) => {
    if (m.type() === 'error' || m.type() === 'warning') problems.push(`${m.type()}: ${m.text()}`);
  });
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  await watchViolations(page);
}


/** Choose a view in the menu bar (the labels are the page's own language). */
async function chooseView(page: Page, menu: string, item: string): Promise<void> {
  await page.getByRole('menuitem', { name: menu, exact: true }).click();
  await page.getByRole('menuitemradio', { name: item, exact: true }).click();
}

async function showList(page: Page): Promise<void> {
  await chooseView(page, 'View', 'List');
  await expect(page.locator('button.row').first()).toBeVisible();
}

/**
 * Drag `source` onto `target` with real mouse steps: the card is read again when the button goes down (a board that has
 * just been redrawn has moved), and `place` picks the upper or lower half of a card.
 */
async function drag(
  page: Page,
  source: Locator,
  target: Locator,
  place: 'upper' | 'lower' | 'middle' = 'middle',
): Promise<void> {
  const from = (await source.boundingBox())!;
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(from.x + from.width / 2 - 30, from.y + from.height / 2 + 10, { steps: 4 });
  const to = (await target.boundingBox())!;
  const y = place === 'upper' ? to.y + 8 : place === 'lower' ? to.y + to.height - 8 : to.y + to.height / 2;
  await page.mouse.move(to.x + to.width / 2, y, { steps: 10 });
  await page.mouse.up();
}

/** Make a task through the capture dialog; the key is pressed again until the dialog is there (the menu may hold the focus). */
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

async function open(page: Page, id: string): Promise<void> {
  await page.locator('button.row', { hasText: id }).first().click();
  // The detail of THIS task, read: the id is there and the reading is over.
  await expect(page.locator('aside.detail .id')).toHaveText(id);
  await expect(page.locator('aside.detail .muted', { hasText: /Reading the task/ })).toHaveCount(0);
  await expect(page.locator('aside.detail .prose, aside.detail pre.body')).toBeVisible();
}

test('an unpaired page says how to pair, and has no violation', async ({ page }) => {
  await watchViolations(page);
  await page.goto('/');
  await expect(page.getByRole('heading', { name: /not paired/i })).toBeVisible();
  await expect(page.getByText('tasks-hub open')).toBeVisible();
  expect(await violations(page)).toEqual([]);
});

test('the link pairs the tab, the code leaves the address bar, the list is there', async ({ page }) => {
  await pairByLink(page);
  expect(page.url()).toBe('http://127.0.0.1:17698/');
  expect(await page.evaluate(() => location.hash)).toBe('');
  await showList(page);
  const rows = await page.locator('button.row').count();
  // The fixture's 14 tasks and the hostile ones added by the test.
  expect(rows).toBeGreaterThanOrEqual(19);
  expect(await violations(page)).toEqual([]);
});

test('the browser enforces Trusted Types and no inline or eval script', async ({ page }) => {
  await pair(page);
  const result = await page.evaluate(() => {
    const out: Record<string, string> = {};
    const attempt = (name: string, fn: () => unknown) => {
      try {
        fn();
        out[name] = 'allowed';
      } catch (e) {
        out[name] = e instanceof Error ? e.name : 'threw';
      }
    };
    out['trustedTypes'] = typeof (window as unknown as { trustedTypes?: unknown }).trustedTypes;
    attempt('innerHTML', () => {
      document.body.innerHTML = 'x';
    });
    attempt('insertAdjacentHTML', () => document.body.insertAdjacentHTML('beforeend', '<b>x</b>'));
    attempt('document.write', () => document.write('x'));
    attempt('script src', () => {
      (document.createElement('script') as unknown as { src: string }).src = '/assets/x.js';
    });
    return out;
  });
  expect(result['trustedTypes']).toBe('object');
  for (const sink of ['innerHTML', 'insertAdjacentHTML', 'document.write', 'script src']) {
    expect(result[sink], sink).toBe('TypeError');
  }
  // Script a test runner puts in by the debugging protocol is exempt from the
  // policy (so `eval` cannot be probed from here: the header without
  // `unsafe-eval` is held by the hub's tests). What is put in as an element is
  // not exempt:
  await page
    .addScriptTag({ content: 'window.__inline = 1' })
    .catch(() => undefined);
  expect(
    await page.evaluate(() => (window as unknown as { __inline?: number }).__inline),
  ).toBeUndefined();
});

test('hostile titles and bodies run nothing and become text', async ({ page }) => {
  const requested: string[] = [];
  page.on('request', (r) => requested.push(r.url()));
  const dialogs: string[] = [];
  page.on('dialog', (d) => {
    dialogs.push(d.message());
    void d.dismiss();
  });
  await pair(page);
  await showList(page);

  // Titles with markup are rows of text.
  const row = page.locator('button.row', { hasText: 'xss-title-img' });
  await expect(row.locator('.title')).toContainText('<img src=x onerror=window.__xss=1>');
  await expect(page.locator('button.row img, button.row svg')).toHaveCount(0);

  for (const id of ['xss-title-img', 'xss-title-svg', 'xss-body-html', 'xss-body-links']) {
    await open(page, `lib.nvim/${id}`);
    await expect(page.locator('aside.detail pre, aside.detail .prose')).toBeVisible();
    // No element of the attacker's making anywhere in the page.
    await expect(
      page.locator('main script, main img, main iframe, main object, main embed, main svg'),
    ).toHaveCount(0);
  }

  // The links of the body: only what is allowed, with a safe rel.
  const hrefs = await page
    .locator('aside.detail .prose a')
    .evaluateAll((as) => as.map((a) => [a.getAttribute('href'), a.getAttribute('rel')]));
  expect(hrefs).toEqual([['https://example.org/page', 'noopener noreferrer nofollow']]);

  expect(await page.evaluate(() => (window as unknown as { __xss?: unknown }).__xss)).toBeUndefined();
  expect(dialogs).toEqual([]);
  expect(requested.filter((u) => u.includes('tracker.invalid'))).toEqual([]);
  expect(await violations(page)).toEqual([]);
});

test('characters that hide or reverse text are shown', async ({ page }) => {
  await pair(page);
  await showList(page);
  await open(page, 'lib.nvim/bidi-title');
  await expect(page.locator('aside.detail .task-title')).toContainText('⟦U+202E⟧');
  await expect(page.locator('aside.detail')).toContainText('⟦U+200B⟧');
  await expect(page.locator('aside.detail .warn')).toBeVisible();
  // The ASCII id stays readable.
  await expect(page.locator('aside.detail .id')).toHaveText('lib.nvim/bidi-title');
});

test('the page writes nothing to the console, in any view', async ({ page }) => {
  await pair(page);
  await expect(page.getByText('Next task')).toBeVisible();
  await showList(page);
  for (const id of [
    'lib.nvim/alpha',
    'lib.nvim/xss-body-html',
    'lib.nvim/xss-body-more',
    'lib.nvim/xss-frontmatter',
    'lib.nvim/wide-content',
  ]) {
    await open(page, id);
  }
  await chooseView(page, 'View', 'Today');
  await chooseView(page, 'View', 'List');
  expect(consoleProblems.get(page)).toEqual([]);
});

test('markup in titles, bodies and fields stays text, in every field', async ({ page }) => {
  await pair(page);
  await showList(page);
  for (const id of ['xss-body-more', 'xss-frontmatter']) {
    await open(page, `lib.nvim/${id}`);
    await expect(page.locator('main script, main img, main iframe, main form, main style')).toHaveCount(
      0,
    );
  }
  // The fields are text of the detail, not elements.
  await open(page, 'lib.nvim/xss-frontmatter');
  await expect(page.locator('aside.detail')).toContainText('<img src=x onerror=window.__xss=19>');
  const hrefs = await page
    .locator('aside.detail a')
    .evaluateAll((as) => as.map((a) => a.getAttribute('href')));
  expect(hrefs).toEqual([]);
  await open(page, 'lib.nvim/xss-body-more');
  const links = await page
    .locator('aside.detail .prose a')
    .evaluateAll((as) => as.map((a) => a.getAttribute('href')));
  expect(links).toEqual(['https://example.org/auto']);
  expect(await page.evaluate(() => (window as unknown as { __xss?: unknown }).__xss)).toBeUndefined();
  expect(await violations(page)).toEqual([]);
});

test('the rows come in frames and j keeps the selected row in view', async ({ page }) => {
  await pair(page);
  await showList(page);
  const total = Number(
    ((await page.locator('.count').innerText()).match(/of (\d+)/) ?? [])[1] ?? 0,
  );
  // Every row is there a moment after the first ones.
  await expect.poll(() => page.locator('button.row').count()).toBe(total);

  // A long way down with the key, the selected row is on the screen.
  for (let i = 0; i < 17; i++) await page.keyboard.press('j');
  const selected = page.locator('button.row[aria-current="true"]');
  await expect(selected).toBeVisible();
  const inView = await selected.evaluate((el) => {
    const box = el.getBoundingClientRect();
    const rows = el.closest('.rows')?.getBoundingClientRect();
    return !!rows && box.top >= rows.top - 1 && box.bottom <= rows.bottom + 1;
  });
  expect(inView).toBe(true);
  // The view is remembered: a reload opens on the list.
  await page.reload();
  await expect(page.locator('button.row').first()).toBeVisible();
});

test('a word that is only in the text of a task finds the task, with the place', async ({
  page,
}) => {
  await pair(page);
  await showList(page);
  await page.getByPlaceholder('Search id and title').fill('tracker.invalid');
  // The list holds nothing for it (no title or id has the word); the hub's
  // index of the texts is built a moment after it starts.
  const hit = page.locator('section.hits button.hit', { hasText: 'lib.nvim/xss-body-links' });
  await expect(hit).toBeVisible({ timeout: 15_000 });
  await expect(hit.locator('mark')).toContainText('tracker.invalid');
  // Text only: the match is not an element of the attacker's.
  await expect(page.locator('section.hits img, section.hits script, section.hits a')).toHaveCount(0);
  // The hit opens the task.
  await hit.click();
  await expect(page.locator('aside.detail .id')).toHaveText('lib.nvim/xss-body-links');
  // The area that was chosen holds for the text as well.
  await page.getByPlaceholder('Search id and title').fill('tracker.invalid');
  await expect(hit).toBeVisible();
  await page.getByRole('button', { name: 'Areas' }).click();
  await page.getByRole('checkbox', { name: 'cascade.nvim' }).check();
  await expect(hit).toHaveCount(0);
  // A second area added: any of them counts, so the hit of the first is back.
  await page.getByRole('checkbox', { name: 'lib.nvim' }).check();
  await expect(hit).toBeVisible();
  await page.getByRole('button', { name: 'Clear selection' }).click();
  await page.keyboard.press('Escape');
  await expect(hit).toBeVisible();
  // Nothing in the text either: said so.
  await page.getByPlaceholder('Search id and title').fill('zzzqqqxxx');
  await expect(page.getByText('Nothing in the texts either.')).toBeVisible({ timeout: 10_000 });
  expect(await violations(page)).toEqual([]);
  expect(consoleProblems.get(page)).toEqual([]);
});

test('a change in the vault arrives and the selection stays', async ({ page }) => {
  await pair(page);
  await showList(page);
  await open(page, 'lib.nvim/beta');
  const file = join(state().vault, 'lib.nvim', 'ROADMAP', 'tasks', 'beta.md');
  const text = readFileSync(file, 'utf8');
  writeFileSync(file, text.replace(/^title: (.*)$/m, 'title: $1 CHANGED'));
  await expect(page.locator('aside.detail .task-title')).toContainText('CHANGED', {
    timeout: 8000,
  });
  await expect(page.locator('button.row[aria-current="true"]')).toContainText('lib.nvim/beta');
  writeFileSync(file, text);
});

test('the list comes from the cache before the hub answers', async ({ page }) => {
  await pair(page);
  await showList(page);
  // Let the cache be written (it is after the classes are known).
  await page.waitForTimeout(1500);
  // From now on the hub answers a second and a half late. What shows before
  // that can only be the cache.
  await page.route('**/api/**', async (route) => {
    await new Promise((r) => setTimeout(r, 1500));
    await route.continue();
  });
  await page.reload();
  const started = Date.now();
  await chooseView(page, 'View', 'List');
  await expect(page.locator('button.row').first()).toBeVisible({ timeout: 1400 });
  const seen = Date.now() - started;
  console.log(`first list after reload, hub 1500 ms late: ${seen} ms`);
  await expect(page.locator('.banner')).toContainText('last known list');
  await page.unroute('**/api/**');
});

for (const scheme of ['light', 'dark'] as const) {
  test(`no accessibility violations in ${scheme}: today, list and detail`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: scheme });
    await pair(page);
    // Today waits for `next`.
    await expect(page.getByText('Next task')).toBeVisible();
    await expect(page.locator('.tile').first()).toBeVisible();
    const today = await new AxeBuilder({ page }).analyze();
    expect(today.violations, JSON.stringify(today.violations, null, 1)).toEqual([]);

    await showList(page);
    await open(page, 'lib.nvim/alpha');
    await expect(page.locator('aside.detail .prose')).toBeVisible();
    const list = await new AxeBuilder({ page }).analyze();
    expect(list.violations, JSON.stringify(list.violations, null, 1)).toEqual([]);

    // Content that scrolls: a long code line and a wide table.
    await open(page, 'lib.nvim/wide-content');
    await expect(page.locator('aside.detail .prose table')).toBeVisible();
    const wide = await new AxeBuilder({ page }).analyze();
    expect(wide.violations, JSON.stringify(wide.violations, null, 1)).toEqual([]);

    // The plan view: stages, a path, tags in the accent colour.
    await chooseView(page, 'View', 'Plan');
    await expect(page.getByRole('region', { name: 'Stages' })).toBeVisible();
    const plan = await new AxeBuilder({ page }).analyze();
    expect(plan.violations, JSON.stringify(plan.violations, null, 1)).toEqual([]);
  });
}

test('the German page has no violations either', async ({ page }) => {
  await pair(page);
  await page.getByRole('menuitem', { name: 'Language' }).click();
  await page.getByRole('menuitemradio', { name: 'Deutsch' }).click();
  await expect(page.getByRole('menuitem', { name: 'Ansicht' })).toBeVisible();
  await showListDe(page);
  const result = await new AxeBuilder({ page }).analyze();
  expect(result.violations, JSON.stringify(result.violations, null, 1)).toEqual([]);
});

async function showListDe(page: Page): Promise<void> {
  await chooseView(page, 'Ansicht', 'Liste');
  await expect(page.locator('button.row').first()).toBeVisible();
}

test('a key that is not part of the chord is left alone', async ({ page }) => {
  await pair(page);
  await page.locator('body').click();
  await page.keyboard.press('g');
  await page.keyboard.press('Tab');
  // Tab moved the focus: it was not swallowed by the chord.
  const tag = await page.evaluate(() => document.activeElement?.tagName);
  expect(tag).not.toBe('BODY');
  await page.keyboard.press('g');
  await page.keyboard.press('l');
  await expect(page.locator('button.row').first()).toBeVisible();
});

test('the overview is at the top right, tiles can be put away, choices combine', async ({ page }) => {
  await watchViolations(page);
  await pair(page);
  await expect(page.getByText('Next task')).toBeVisible();

  // The counts stand to the right of the work and in view without scrolling.
  const overview = page.locator('aside.overview');
  await expect(overview).toBeVisible();
  const box = await overview.boundingBox();
  const size = page.viewportSize();
  expect(box && size && box.x > size.width / 2 && box.y < size.height / 2).toBe(true);

  // A tile can be put away; it stays away after a reload.
  await page.getByRole('button', { name: 'Hide this tile' }).first().click();
  await expect(overview).toHaveCount(0);
  await page.reload();
  await expect(page.getByText('Next task')).toBeVisible();
  await expect(overview).toHaveCount(0);
  await page.getByRole('button', { name: /Hidden tiles \(1\)/ }).click();
  await expect(overview).toBeVisible();

  // The name of a choice is the button, not an option of it.
  await showList(page);
  const status = page.getByRole('button', { name: 'Status', exact: true });
  await status.click();
  await expect(page.getByRole('checkbox', { name: 'Status' })).toHaveCount(0);
  await page.getByRole('checkbox', { name: 'doing' }).check();
  await page.getByRole('checkbox', { name: 'open', exact: true }).check();
  await expect(page.getByRole('button', { name: 'Status: 2' })).toBeVisible();
  expect(await violations(page)).toEqual([]);
  await page.keyboard.press('Escape');
  await expect(page.getByRole('checkbox', { name: 'doing' })).toHaveCount(0);
});

test('the menu bar opens with the keyboard, switches views, language and theme', async ({ page }) => {
  await watchViolations(page);
  await pair(page);
  await expect(page.getByText('Next task')).toBeVisible();

  // Down opens a menu and focuses its first item; Escape gives the focus back.
  const view = page.getByRole('menuitem', { name: 'View' });
  await view.focus();
  await page.keyboard.press('ArrowDown');
  await expect(page.getByRole('menuitemradio', { name: 'Today' })).toBeFocused();
  await expect(page.getByRole('menuitemradio', { name: 'Today' })).toHaveAttribute('aria-checked', 'true');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await expect(page.locator('.split')).toBeVisible();
  await page.getByRole('menuitem', { name: 'View' }).focus();
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Escape');
  await expect(page.getByRole('menu')).toHaveCount(0);
  await expect(view).toBeFocused();

  // A menu that was opened with the mouse closes when the focus leaves the bar.
  await page.getByRole('menuitem', { name: 'Project' }).click();
  await expect(page.getByRole('menu')).toHaveCount(1);
  await page.locator('main button').first().focus();
  await expect(page.getByRole('menu')).toHaveCount(0);
  await page.getByRole('menuitem', { name: 'View' }).focus();

  // Left and Right walk the menus.
  await page.keyboard.press('ArrowRight');
  await expect(page.getByRole('menuitem', { name: 'Settings' })).toBeFocused();

  expect(await violations(page)).toEqual([]);
  await page.getByRole('menuitem', { name: 'Theme' }).click();
  await page.getByRole('menuitemradio', { name: 'Dark' }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');

  // Keys can be switched off from the settings menu.
  await page.getByRole('menuitem', { name: 'Settings' }).click();
  await page.getByRole('menuitemcheckbox', { name: 'Keys' }).click();
  await page.getByRole('menuitem', { name: 'Settings' }).click();
  await expect(page.getByRole('menuitemcheckbox', { name: 'Keys' })).toHaveAttribute('aria-checked', 'false');
  expect(await violations(page)).toEqual([]);
});

test('a task is created, changed, taken back and finished through the engine', async ({ page }) => {
  await watchViolations(page);
  await pair(page);
  await showList(page);

  // Capture: the key opens the dialog, a title and an area are enough.
  await page.keyboard.press('c');
  const capture = page.getByRole('dialog', { name: 'New task' });
  await expect(capture).toBeVisible();
  await capture.getByLabel('Title').fill('Written by the browser test');
  await capture.locator('select').first().selectOption('lib.nvim');
  expect(await violations(page)).toEqual([]);
  await capture.getByRole('button', { name: 'Create' }).click();
  await expect(capture).toHaveCount(0);
  await expect(page.getByRole('status').getByText('Saved.')).toBeVisible();
  await expect(page.locator('aside.detail .task-title')).toHaveText('Written by the browser test');
  const id = (await page.locator('aside.detail .id').innerText()).trim();
  expect(id).toMatch(/^lib\.nvim\//);

  // A change with the version that was shown, and the way back.
  await page.locator('aside.detail').getByLabel('Status').selectOption('doing');
  await expect(page.getByRole('status').getByText('Saved.')).toBeVisible();
  await expect(page.locator('aside.detail').getByLabel('Status')).toHaveValue('doing');
  await page.getByRole('button', { name: 'Undo' }).click();
  await expect(page.getByRole('status').getByText('Undone.')).toBeVisible();
  await expect(page.locator('aside.detail').getByLabel('Status')).toHaveValue('open');

  // Kind, effort, value and tags: the engine takes them, and a reload reads them back from the files.
  const detail = page.locator('aside.detail');
  await detail.getByLabel('Effort').selectOption('M');
  await detail.getByLabel('Value').selectOption('4');
  await detail.getByLabel('Kind').selectOption('bug');
  await detail.getByLabel('Tags').fill(' ui, e2e ,, ui');
  await detail.getByLabel('Tags').blur();
  await expect(detail.getByLabel('Tags')).toHaveValue('ui, e2e');
  await page.reload();
  await expect(page.getByRole('menubar')).toBeVisible();
  await showList(page);
  await open(page, id);
  await expect(detail.getByLabel('Effort')).toHaveValue('M');
  await expect(detail.getByLabel('Value')).toHaveValue('4');
  await expect(detail.getByLabel('Kind')).toHaveValue('bug');
  await expect(detail.getByLabel('Tags')).toHaveValue('ui, e2e');

  // A tag the engine would refuse is told before anything is sent, and the text stays in the field.
  await detail.getByLabel('Tags').fill('ui, bad#tag');
  await detail.getByLabel('Tags').blur();
  await expect(page.getByRole('status').getByText(/bad#tag/)).toBeVisible();
  await expect(detail.getByLabel('Tags')).toHaveValue('ui, bad#tag');

  // Emptying a field takes the key out of the file.
  await detail.getByLabel('Tags').fill('');
  await detail.getByLabel('Tags').blur();
  await detail.getByLabel('Effort').selectOption('');
  await page.reload();
  await expect(page.getByRole('menubar')).toBeVisible();
  await showList(page);
  await open(page, id);
  await expect(detail.getByLabel('Tags')).toHaveValue('');
  await expect(detail.getByLabel('Effort')).toHaveValue('');
  await expect(detail.getByLabel('Value')).toHaveValue('4');

  // Finishing shows what it does and asks.
  await page.locator('aside.detail').getByRole('button', { name: 'Finish ...' }).click();
  const done = page.getByRole('dialog', { name: 'Finish this task?' });
  await expect(done).toBeVisible();
  await expect(done.getByText(id)).toBeVisible();
  expect(await violations(page)).toEqual([]);
  await done.getByRole('button', { name: 'Finish', exact: true }).click();
  await expect(done).toHaveCount(0);
  await expect(page.locator('button.row', { hasText: id })).toHaveCount(0);
  expect(consoleProblems.get(page)).toEqual([]);
});

test('marked tasks are changed in one batch, with the keys and the button', async ({ page }) => {
  await watchViolations(page);
  await pair(page);
  await showList(page);

  for (const n of [1, 2, 3]) {
    await page.keyboard.press('c');
    const capture = page.getByRole('dialog', { name: 'New task' });
    await capture.getByLabel('Title').fill(`Bulk e2e ${n}`);
    await capture.locator('select').first().selectOption('lib.nvim');
    await capture.getByRole('button', { name: 'Create' }).click();
    await expect(capture).toHaveCount(0);
  }

  // Narrow the list to the three, mark them all, change the status once.
  const search = page.getByRole('searchbox', { name: /search/i }).first();
  await search.fill('Bulk e2e');
  const rows = page.locator('.rows .line');
  await expect(rows).toHaveCount(3);
  await page.getByRole('button', { name: 'Mark all shown' }).click();
  await expect(page.getByText('3 marked')).toBeVisible();
  const bar = page.getByRole('group', { name: 'Change the marked tasks' });
  const apply = bar.getByRole('button', { name: 'Apply to the marked' });
  await expect(apply).toBeDisabled();
  // The bar is on the screen: the page still passes the checks of the policy and of axe.
  expect(await violations(page)).toEqual([]);

  // Choosing writes nothing, not even with the arrow keys; only the button does. The requests are counted.
  let writes = 0;
  await page.route('**/api/tasks/ops', async (route) => {
    writes += 1;
    await route.continue();
  });
  await bar.getByLabel('Status').selectOption('doing');
  await bar.getByLabel('Priority').selectOption('1');
  await bar.getByLabel('Priority').press('ArrowDown');
  await page.waitForTimeout(400);
  expect(writes).toBe(0);
  await expect(page.locator('.rows .line', { hasText: 'doing' })).toHaveCount(0);
  await apply.click();
  await expect(page.getByRole('status').getByText('Saved: 3.')).toBeVisible();
  expect(writes).toBe(1);
  await expect(page.getByText('3 marked')).toHaveCount(0);
  await expect(page.locator('.rows .line', { hasText: 'doing' })).toHaveCount(3);
  await expect(page.locator('.rows .line', { hasText: 'P2' })).toHaveCount(3);

  // The choice belongs to the bar: after "Clear marks" a new mark starts with nothing chosen.
  await page.getByRole('button', { name: 'Mark all shown' }).click();
  await bar.getByLabel('Status').selectOption('parked');
  await expect(apply).toBeEnabled();
  await page.getByRole('button', { name: 'Clear marks' }).click();
  await rows.nth(0).getByRole('checkbox').check();
  await expect(bar.getByLabel('Status')).toHaveValue('');
  await expect(apply).toBeDisabled();
  await page.getByRole('button', { name: 'Clear marks' }).click();

  // A filter that hides a mark takes the mark with it.
  await page.getByRole('button', { name: 'Mark all shown' }).click();
  await expect(page.getByText('3 marked')).toBeVisible();
  await search.fill('Bulk e2e 1');
  await expect(page.getByText('1 marked')).toBeVisible();
  await page.getByRole('button', { name: 'Clear marks' }).click();
  await search.fill('Bulk e2e');
  await expect(rows).toHaveCount(3);

  // A click on the box leaves the keys of the page alive; the key marks the selected row;
  // Escape takes the marks away and leaves the selection where it is.
  await rows.nth(0).getByRole('checkbox').check();
  await expect(page.getByText('1 marked')).toBeVisible();
  await page.keyboard.press('j');
  await page.keyboard.press('x');
  await expect(page.getByText('2 marked')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByText('2 marked')).toHaveCount(0);
  await expect(page.locator('.rows [aria-current="true"]')).toHaveCount(1);

  // Holding the key does not flip the mark back and forth (the second press of a held key is a repeat).
  await page.keyboard.down('x');
  await page.keyboard.down('x');
  await page.keyboard.up('x');
  await expect(page.getByText('1 marked')).toBeVisible();

  // Escape on another page does not take marks the person cannot see.
  await page.keyboard.press('g');
  await page.keyboard.press('h');
  await page.keyboard.press('Escape');
  await page.keyboard.press('g');
  await page.keyboard.press('l');
  await expect(page.getByText('1 marked')).toBeVisible();
  await page.getByRole('button', { name: 'Clear marks' }).click();
  await page.keyboard.press('Escape');
  await expect(page.locator('.rows [aria-current="true"]')).toHaveCount(0);

  // The boxes of the filter are not the marks: the keys of the page do nothing while one has the focus.
  await page.getByRole('button', { name: /^Status/ }).first().click();
  await page.getByRole('group', { name: 'Status' }).getByRole('checkbox').first().check();
  await page.keyboard.press('c');
  await expect(page.getByRole('dialog', { name: 'New task' })).toHaveCount(0);
  await page.keyboard.press('Escape');

  expect(await violations(page)).toEqual([]);
  expect(consoleProblems.get(page)).toEqual([]);
});

test('a task that changed meanwhile fails alone in a batch; the others are saved and can be taken back', async ({
  page,
}) => {
  await watchViolations(page);
  await pair(page);
  await showList(page);

  for (const n of [1, 2, 3]) {
    await page.keyboard.press('c');
    const capture = page.getByRole('dialog', { name: 'New task' });
    await capture.getByLabel('Title').fill(`Partial e2e ${n}`);
    await capture.locator('select').first().selectOption('lib.nvim');
    await capture.getByRole('button', { name: 'Create' }).click();
    await expect(capture).toHaveCount(0);
  }
  await page.getByRole('searchbox', { name: /search/i }).first().fill('Partial e2e');
  const rows = page.locator('.rows .line');
  await expect(rows).toHaveCount(3);
  await page.getByRole('button', { name: 'Mark all shown' }).click();

  // The file of the second task changes after the page showed it and before the request arrives.
  const file = join(state().vault, 'lib.nvim', 'ROADMAP', 'tasks', 'partial-e2e-2.md');
  await page.route('**/api/tasks/ops', async (route) => {
    writeFileSync(file, readFileSync(file, 'utf8') + '\nChanged by someone else.\n');
    await route.continue();
  });
  const bar = page.getByRole('group', { name: 'Change the marked tasks' });
  await bar.getByLabel('Priority').selectOption('1');
  await bar.getByRole('button', { name: 'Apply to the marked' }).click();

  const toast = page.getByRole('status');
  await expect(toast.getByText(/2 saved, 1 not/)).toBeVisible();
  // Only the task that failed stays marked; the other two are P1.
  await expect(page.getByText('1 marked')).toBeVisible();
  await expect(rows.filter({ hasText: 'Partial e2e 2' }).getByRole('checkbox')).toBeChecked();
  await expect(page.locator('.rows .line', { hasText: 'P1' })).toHaveCount(2);

  // The way back takes the two that went through back, as one batch.
  await toast.getByRole('button', { name: 'Undo' }).click();
  await expect(toast.getByText('Undone.')).toBeVisible();
  await expect(page.locator('.rows .line', { hasText: 'P1' })).toHaveCount(0);
  expect(consoleProblems.get(page)).toEqual([]);
});

test('a tag that was refused does not travel to the next task', async ({ page }) => {
  await watchViolations(page);
  await pair(page);
  await showList(page);
  // Two tasks without tags: the field reads '' for both, which is the case a stale value would survive.
  for (const n of [1, 2]) {
    await page.keyboard.press('c');
    const capture = page.getByRole('dialog', { name: 'New task' });
    await capture.getByLabel('Title').fill(`Travel e2e ${n}`);
    await capture.locator('select').first().selectOption('lib.nvim');
    await capture.getByRole('button', { name: 'Create' }).click();
    await expect(capture).toHaveCount(0);
  }
  await page.getByRole('searchbox', { name: /search/i }).first().fill('Travel e2e');
  await open(page, 'lib.nvim/travel-e2e-1');
  const tags = page.locator('aside.detail').getByLabel('Tags');
  await tags.fill('keep, bad#tag');
  await tags.blur();
  await expect(page.getByRole('status').getByText(/bad#tag/)).toBeVisible();
  await expect(tags).toHaveValue('keep, bad#tag');
  await open(page, 'lib.nvim/travel-e2e-2');
  await expect(tags).toHaveValue('');
});

test('the board: cards move by key and by drag, the engine keeps the order, a priority border is not crossed', async ({
  page,
}) => {
  await watchViolations(page);
  await pair(page);
  await showList(page);

  for (const n of [1, 2, 3]) await capture(page, `Board e2e ${n}`);
  // The filter of the list is the filter of the board.
  await page.getByRole('searchbox', { name: /search/i }).first().fill('Board e2e');
  await expect(page.locator('.rows .line')).toHaveCount(3);
  await chooseView(page, 'View', 'Board');

  const column = (name: string) => page.getByRole('region', { name, exact: true });
  const titles = (name: string) => column(name).locator('.card .title').allInnerTexts();
  await expect(column('open').locator('.card')).toHaveCount(3);
  const first = await titles('open');
  expect(first).toHaveLength(3);

  // J moves the selected card one place down inside its group, and the engine's order says so after a reload.
  await column('open').locator('.card').first().click();
  await page.keyboard.press('Shift+J');
  await expect(page.getByRole('status').getByText('Saved.')).toBeVisible();
  const moved = [first[1], first[0], first[2]];
  await expect.poll(() => titles('open')).toEqual(moved);
  await page.reload();
  await expect(page.getByRole('menubar')).toBeVisible();
  // The filter is not kept over a reload: narrow to the three again through the list.
  await chooseView(page, 'View', 'List');
  await page.getByRole('searchbox', { name: /search/i }).first().fill('Board e2e');
  await chooseView(page, 'View', 'Board');
  await expect(column('open').locator('.card')).toHaveCount(3);
  expect(await titles('open')).toEqual(moved);

  // K takes it back; at the edge of the group there is nowhere to go, and that is told.
  await column('open').locator('.card').nth(1).click();
  await page.keyboard.press('Shift+K');
  await expect.poll(() => titles('open')).toEqual(first);
  await page.keyboard.press('Shift+K');
  await expect(page.getByRole('status').getByText(/end of its priority group/)).toBeVisible();

  // Drag one card onto the lower half of another: the order changes by a reorder.
  const cards = column('open').locator('.card');
  await drag(page, cards.nth(0), cards.nth(2), 'lower');
  await expect.poll(() => titles('open')).toEqual([first[1], first[2], first[0]]);

  // Drag a card into another column: the status changes.
  const name = (await titles('open'))[0] as string;
  await drag(page, column('open').locator('.card', { hasText: name }), column('doing'));
  await expect(column('doing').locator('.card', { hasText: name })).toHaveCount(1);
  await expect(column('open').locator('.card')).toHaveCount(2);

  // H and L change the status of the selected card with the keys.
  await column('doing').locator('.card', { hasText: name }).click();
  await page.keyboard.press('Shift+L');
  await expect(column('decision').locator('.card', { hasText: name })).toHaveCount(1);
  await page.keyboard.press('Shift+H');
  await expect(column('doing').locator('.card', { hasText: name })).toHaveCount(1);

  // A card of another priority is another group: the engine orders inside a group only, so the move is refused.
  const other = (await titles('open'))[0] as string;
  await column('open').locator('.card', { hasText: other }).click();
  await page.locator('aside.detail').getByLabel('Priority').selectOption('1');
  await expect(page.getByRole('status').getByText('Saved.')).toBeVisible();
  const rest = column('open').locator('.card').filter({ hasNotText: other });
  await expect(rest).toHaveCount(1);
  let writes = 0;
  await page.route('**/api/tasks/ops', async (route) => {
    writes += 1;
    await route.continue();
  });
  // A card can be dragged when no write is under way.
  await expect(column('open').locator('.card', { hasText: other })).toHaveAttribute('draggable', 'true');
  await drag(page, column('open').locator('.card', { hasText: other }), rest.first(), 'lower');
  expect(writes).toBe(0);
  await expect(page.getByRole('status').getByText(/holds inside one priority/)).toBeVisible();

  // The other way - a card without a priority dropped under the card of priority 1 - asks whether the priority
  // goes with it. No is nothing sent; yes is one batch (the priority, then the place), read back after a reload.
  const mover = (await rest.first().locator('.title').innerText()) as string;
  const target = column('open').locator('.card', { hasText: other });
  await drag(page, column('open').locator('.card', { hasText: mover }), target, 'lower');
  const ask = page.getByRole('dialog', { name: 'Priority 1?' });
  await expect(ask).toBeVisible();
  await ask.getByRole('button', { name: 'Cancel' }).click();
  await expect(ask).toBeHidden();
  expect(writes).toBe(0);
  await drag(page, column('open').locator('.card', { hasText: mover }), target, 'lower');
  await ask.getByRole('button', { name: /Set priority 1/ }).click();
  await expect(page.getByRole('status').getByText(/Saved/)).toBeVisible();
  expect(writes).toBe(1);
  await expect.poll(() => titles('open')).toEqual([other, mover]);
  await page.reload();
  await expect(page.getByRole('menubar')).toBeVisible();
  await chooseView(page, 'View', 'List');
  await page.getByRole('searchbox', { name: /search/i }).first().fill('Board e2e');
  await chooseView(page, 'View', 'Board');
  await expect.poll(() => titles('open')).toEqual([other, mover]);
  await column('open').locator('.card', { hasText: mover }).click();
  await expect(page.locator('aside.detail').getByLabel('Priority')).toHaveValue('1');

  expect(await violations(page)).toEqual([]);
  expect(consoleProblems.get(page)).toEqual([]);
});

test('the plan wizard names the plan with a dry run, refuses what the engine refuses and makes the file', async ({
  page,
}) => {
  await watchViolations(page);
  await pair(page);
  await showList(page);

  const dialog = page.getByRole('dialog', { name: 'New plan' });
  const open = async (): Promise<void> => {
    await page.getByRole('menuitem', { name: 'Project', exact: true }).click();
    await page.getByRole('menuitem', { name: 'New plan ...' }).click();
    await expect(dialog).toBeVisible();
  };
  await open();
  const create = dialog.getByRole('button', { name: 'Create' });
  await expect(create).toBeDisabled();
  expect(await violations(page)).toEqual([]);

  // The engine names the plan while the person types; nothing is written yet.
  await dialog.getByLabel('Title', { exact: true }).fill('Wizard e2e plan');
  await dialog.getByLabel('Area of the plan file').selectOption('lib.nvim');
  await expect(dialog.getByRole('status')).toHaveText('The plan will be lib.nvim/wizard-e2e-plan');
  const file = join(state().vault, 'lib.nvim', 'ROADMAP', 'plans', 'wizard-e2e-plan.md');
  expect(existsSync(file)).toBe(false);

  // What the engine refuses is shown as it says it, and the plan cannot be made.
  await dialog.getByLabel(/Phases in order/).fill('design, Not Kebab');
  await expect(dialog.getByRole('status')).toContainText('kebab');
  await expect(create).toBeDisabled();
  await dialog.getByLabel(/Phases in order/).fill('design, build');
  await expect(dialog.getByRole('status')).toHaveText('The plan will be lib.nvim/wizard-e2e-plan');
  await expect(create).toBeEnabled();

  await dialog.getByLabel('Target task').fill('lib.nvim/alpha');
  await dialog.getByLabel('State of the plan').selectOption('doing');
  await dialog.getByLabel(/Each phase waits/).check();
  await dialog.getByLabel('One line about it').fill('Made by the browser test.');
  await expect(create).toBeEnabled();
  await create.click();
  await expect(dialog).toHaveCount(0);

  // The plan view opens on the new plan, and the file is what the engine makes.
  await expect(page.getByRole('heading', { name: 'Plan', level: 1 })).toBeAttached();
  await expect(page.getByLabel('Plan', { exact: true }).or(page.locator('.plan-select select'))).toHaveValue(
    'lib.nvim/wizard-e2e-plan',
  );
  const text = readFileSync(file, 'utf8');
  expect(text).toContain('title: Wizard e2e plan');
  expect(text).toContain('gate: hard');
  expect(text).toContain('Made by the browser test.');
  expect(text).toMatch(/phase_order: \[design, build\]/);

  // The same title again: the name is taken, and the dry run says so before anything is made.
  await open();
  await dialog.getByLabel('Title', { exact: true }).fill('Wizard e2e plan');
  await dialog.getByLabel('Area of the plan file').selectOption('lib.nvim');
  await expect(dialog.getByRole('status')).toHaveText(
    'The name was taken: the plan will be lib.nvim/wizard-e2e-plan-2',
  );
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(dialog).toHaveCount(0);
  expect(existsSync(join(state().vault, 'lib.nvim', 'ROADMAP', 'plans', 'wizard-e2e-plan-2.md'))).toBe(false);

  expect(await violations(page)).toEqual([]);
  expect(consoleProblems.get(page)).toEqual([]);
});

/** Put a line into the frontmatter of a task file the page made (the way another tool would change it). */
function addFrontmatter(slug: string, lines: string): void {
  const file = join(state().vault, 'lib.nvim', 'ROADMAP', 'tasks', `${slug}.md`);
  const text = readFileSync(file, 'utf8');
  writeFileSync(file, text.replace(/^(status: .*)$/m, `$1\n${lines}`));
}

test('the board does not place a card beside one of its priority in another stage, which the engine would refuse', async ({
  page,
}) => {
  await watchViolations(page);
  await pair(page);
  await showList(page);
  for (const n of ['a', 'b', 'c']) await capture(page, `Stage e2e ${n}`);
  // a: P1, b: P1 and waits for a (the next stage), c: P2 - listed a, c, b: the two P1 cards are not neighbours.
  addFrontmatter('stage-e2e-a', 'prio: 1');
  addFrontmatter('stage-e2e-b', 'prio: 1\nblocked_by: [lib.nvim/stage-e2e-a]');
  addFrontmatter('stage-e2e-c', 'prio: 2');
  await page.getByRole('searchbox', { name: /search/i }).first().fill('Stage e2e');
  await chooseView(page, 'View', 'Board');
  const open = page.getByRole('region', { name: 'open', exact: true });
  await expect(open.locator('.card .title')).toHaveText(['Stage e2e a', 'Stage e2e c', 'Stage e2e b']);
  await expect(open.locator('.group')).toHaveCount(3);

  let writes = 0;
  await page.route('**/api/tasks/ops', async (route) => {
    writes += 1;
    await route.continue();
  });
  // Down from a would be "after b": another stage. The board says it is at the edge and asks the engine nothing.
  await open.locator('.card', { hasText: 'Stage e2e a' }).click();
  await page.keyboard.press('Shift+J');
  await expect(page.getByRole('status').getByText(/end of its priority group/)).toBeVisible();
  expect(writes).toBe(0);
  await drag(page, open.locator('.card', { hasText: 'Stage e2e a' }), open.locator('.card', { hasText: 'Stage e2e b' }), 'lower');
  await expect(page.getByRole('status').getByText(/holds inside one priority/)).toBeVisible();
  expect(writes).toBe(0);
  expect(await violations(page)).toEqual([]);
});

test('the board: a held key writes once, a card the filter hides is not moved, a drop on a card of another column sets the status', async ({
  page,
}) => {
  await watchViolations(page);
  await pair(page);
  await showList(page);
  for (const n of ['uno', 'dos', 'tres']) await capture(page, `Keys e2e ${n}`);
  await page.getByRole('searchbox', { name: /search/i }).first().fill('Keys e2e');
  await expect(page.locator('.rows .line')).toHaveCount(3);
  await chooseView(page, 'View', 'Board');
  const column = (name: string) => page.getByRole('region', { name, exact: true });
  const first = column('open').locator('.card').first();
  const firstTitle = (await first.locator('.title').innerText()).trim();
  const second = column('open').locator('.card').nth(1);
  const secondTitle = (await second.locator('.title').innerText()).trim();
  const thirdTitle = (await column('open').locator('.card').nth(2).locator('.title').innerText()).trim();

  let writes = 0;
  await page.route('**/api/tasks/ops', async (route) => {
    writes += 1;
    await route.continue();
  });

  // A held Shift+J is a repeat after the first press: one write, not a shuffle. The repeat comes after the first write
  // is over, so it is the key's own guard that stops it and not the page being busy.
  await first.click();
  await page.keyboard.down('Shift');
  await page.keyboard.down('J');
  await expect(page.getByRole('status').getByText('Saved.')).toBeVisible();
  await expect(column('open').locator('.card').first()).toHaveAttribute('draggable', 'true');
  await page.keyboard.down('J');
  await page.keyboard.down('J');
  await page.keyboard.up('J');
  await page.keyboard.up('Shift');
  await page.waitForTimeout(300);
  expect(writes).toBe(1);
  await expect.poll(() => column('open').locator('.card .title').allInnerTexts()).toEqual([secondTitle, firstTitle, thirdTitle]);

  // A plain K (CapsLock gives 'K' without Shift) never writes, although the card could go up.
  await page.keyboard.press('K');
  await page.waitForTimeout(300);
  expect(writes).toBe(1);

  // Drop a card on a card of another column: its status is set; the order is the engine's.
  await expect(column('open').locator('.card').first()).toHaveAttribute('draggable', 'true');
  await drag(page, column('open').locator('.card', { hasText: firstTitle }), column('doing'));
  await expect(column('doing').locator('.card', { hasText: firstTitle })).toHaveCount(1);
  await expect(column('open').locator('.card', { hasText: secondTitle })).toHaveCount(1);
  await expect(column('open').locator('.card', { hasText: secondTitle })).toHaveAttribute('draggable', 'true');
  await drag(
    page,
    column('open').locator('.card', { hasText: secondTitle }),
    column('doing').locator('.card', { hasText: firstTitle }),
  );
  await expect(column('doing').locator('.card', { hasText: secondTitle })).toHaveCount(1);
  await expect(column('open').locator('.card')).toHaveCount(1);

  // The filter hides the selected card: the keys do not move it behind the person's back.
  await column('doing').locator('.card', { hasText: firstTitle }).click();
  await chooseView(page, 'View', 'List');
  await page.getByRole('searchbox', { name: /search/i }).first().fill(secondTitle);
  await chooseView(page, 'View', 'Board');
  await expect(column('doing').locator('.card')).toHaveCount(1);
  const before = writes;
  // The focus is on the page, not in the menu that was just used.
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.keyboard.press('Shift+L');
  await page.keyboard.press('Shift+K');
  await page.waitForTimeout(300);
  expect(writes).toBe(before);
});

test('the plan wizard does not make a plan from a name the engine has not confirmed', async ({ page }) => {
  await watchViolations(page);
  await pair(page);
  await showList(page);
  const dialog = page.getByRole('dialog', { name: 'New plan' });
  await page.getByRole('menuitem', { name: 'Project', exact: true }).click();
  await page.getByRole('menuitem', { name: 'New plan ...' }).click();
  await dialog.getByLabel('Title', { exact: true }).fill('Stale one');
  await dialog.getByLabel('Area of the plan file').selectOption('lib.nvim');
  await expect(dialog.getByRole('status')).toHaveText('The plan will be lib.nvim/stale-one');
  const create = dialog.getByRole('button', { name: 'Create' });
  await expect(create).toBeEnabled();
  // The title changes: the answer on the screen is for the old one, and Create waits for the new one.
  await dialog.getByLabel('Title', { exact: true }).pressSequentially(' two');
  await expect(create).toBeDisabled();
  await expect(dialog.getByRole('status')).toHaveText('The plan will be lib.nvim/stale-one-two');
  await expect(create).toBeEnabled();
  // The areas the plan covers follow the file's area until they are chosen.
  await dialog.getByLabel('Area of the plan file').selectOption('cascade.nvim');
  await expect(dialog.getByRole('button', { name: /Areas the plan covers/ })).toContainText('cascade.nvim');
  // Escape closes the popup of the areas and leaves the dialog and what was typed in it.
  await dialog.getByRole('button', { name: /Areas the plan covers/ }).click();
  await expect(dialog.getByRole('group', { name: 'Areas the plan covers' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(dialog.getByRole('group', { name: 'Areas the plan covers' })).toHaveCount(0);
  await expect(dialog).toBeVisible();
  await expect(dialog.getByLabel('Title', { exact: true })).toHaveValue('Stale one two');
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(dialog).toHaveCount(0);
});

test('a reminder set on a task comes back on the Today page when it is due', async ({ page }) => {
  await watchViolations(page);
  await pair(page);
  await showList(page);
  await open(page, 'lib.nvim/alpha');

  // "Today" is a reminder that is due at once: the card lists the task.
  await page.locator('aside.detail').getByLabel('Remind me').selectOption('+0d');
  await expect(page.getByRole('status').getByText('Saved.')).toBeVisible();
  await expect(page.locator('button.row', { hasText: 'lib.nvim/alpha' }).locator('.tag.due')).toBeVisible();

  await chooseView(page, 'View', 'Today');
  const card = page.getByRole('region', { name: 'To look at again' });
  await expect(card).toBeVisible();
  await expect(card.getByText('lib.nvim/alpha')).toBeVisible();
  expect(await violations(page)).toEqual([]);

  // Taken away again: the card is gone.
  await card.getByRole('button').first().click();
  await showList(page);
  await open(page, 'lib.nvim/alpha');
  await page.locator('aside.detail').getByLabel('Remind me').selectOption('');
  await expect(page.getByRole('status').getByText('Saved.')).toBeVisible();
  await chooseView(page, 'View', 'Today');
  await expect(page.getByRole('region', { name: 'To look at again' })).toHaveCount(0);
  expect(consoleProblems.get(page)).toEqual([]);
});

test('a finished task with a reminder comes back on Today and the reminder can be removed', async ({ page }) => {
  await watchViolations(page);
  await pair(page);
  await showList(page);

  await page.keyboard.press('c');
  const capture = page.getByRole('dialog', { name: 'New task' });
  await capture.getByLabel('Title').fill('Shipped, look at the result');
  await capture.locator('select').first().selectOption('lib.nvim');
  await capture.getByRole('button', { name: 'Create' }).click();
  await expect(page.getByRole('status').getByText('Saved.')).toBeVisible();
  const id = (await page.locator('aside.detail .id').innerText()).trim();

  // Finish it and ask to be reminded: the task leaves the list, the reminder does not.
  await page.locator('aside.detail').getByRole('button', { name: 'Finish ...' }).click();
  const done = page.getByRole('dialog', { name: 'Finish this task?' });
  await done.getByLabel('Remind me about the result').selectOption('+0d');
  await done.getByRole('button', { name: 'Finish', exact: true }).click();
  await expect(done).toHaveCount(0);
  await expect(page.locator('button.row', { hasText: id })).toHaveCount(0);

  await chooseView(page, 'View', 'Today');
  const card = page.getByRole('region', { name: 'To look at again' });
  await expect(card.getByText(id)).toBeVisible();
  await expect(card.getByText('finished')).toBeVisible();
  expect(await violations(page)).toEqual([]);

  // Removing it takes the line away and leaves the finished task alone.
  await card.getByRole('button', { name: new RegExp(`Remove the reminder: ${id}`) }).click();
  await expect(page.getByRole('status').getByText('Saved.')).toBeVisible();
  await expect(page.getByRole('region', { name: 'To look at again' })).toHaveCount(0);
  expect(consoleProblems.get(page)).toEqual([]);
});

test('the plan view shows the stages and the critical path, and opens a task', async ({ page }) => {
  await watchViolations(page);
  await pair(page);
  await chooseView(page, 'View', 'Plan');
  await expect(page.getByRole('region', { name: 'Stages' })).toBeVisible();
  await expect(page.getByRole('heading', { name: /^Stage 0/ })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Critical path' })).toBeVisible();
  expect(await violations(page)).toEqual([]);

  // A task of a stage opens in the list, selected.
  const first = page.getByRole('region', { name: 'Stages' }).getByRole('button').first();
  const title = (await first.innerText()).trim();
  await first.click();
  await expect(page.locator('aside.detail .task-title')).toHaveText(title);
  expect(consoleProblems.get(page)).toEqual([]);
});

test('the plan view narrows to the chosen plan and keeps the choice', async ({ page }) => {
  await watchViolations(page);
  await pair(page);
  await chooseView(page, 'View', 'Plan');
  const stages = page.getByRole('region', { name: 'Stages' });
  const cycle = page.getByText('lib.nvim/cyc-a', { exact: false });
  const hint = page.getByText(/the phase counts are those of the chosen plan/);
  const select = page.getByRole('combobox', { name: 'Plan' });

  // Every task: the cycle of two tasks outside any plan is warned of, and no hint.
  await expect(select).toHaveValue('');
  await expect(cycle.first()).toBeVisible();
  await expect(stages.getByRole('button', { name: 'Cycle A' })).toBeVisible();
  await expect(hint).toHaveCount(0);

  // One plan: its tasks and phases only, the warnings of other tasks go, and the
  // hint says which numbers stay those of the whole vault.
  await select.selectOption('lib.nvim/the-plan');
  await expect(stages.getByRole('button', { name: 'Zeta builds' })).toBeVisible();
  await expect(stages.getByRole('button', { name: 'Cycle A' })).toHaveCount(0);
  await expect(cycle).toHaveCount(0);
  await expect(hint).toBeVisible();
  expect(await violations(page)).toEqual([]);

  // The choice is kept when the view is left and come back to.
  await chooseView(page, 'View', 'List');
  await chooseView(page, 'View', 'Plan');
  await expect(select).toHaveValue('lib.nvim/the-plan');
  await expect(stages.getByRole('button', { name: 'Cycle A' })).toHaveCount(0);
  expect(consoleProblems.get(page)).toEqual([]);
});


test('the board: a card dropped on blocked asks for the blocker, a card dropped on the done zone asks to finish', async ({
  page,
}) => {
  await watchViolations(page);
  await pair(page);
  await showList(page);
  for (const n of [1, 2]) await capture(page, `Block e2e ${n}`);
  await page.getByRole('searchbox', { name: /search/i }).first().fill('Block e2e');
  await expect(page.locator('.rows .line')).toHaveCount(2);
  await chooseView(page, 'View', 'Board');

  const column = (name: string) => page.getByRole('region', { name, exact: true });
  const card = (title: string) => column('open').locator('.card', { hasText: title });
  const idOf = async (title: string) => (await card(title).locator('.id').innerText()).trim();
  const blockerId = await idOf('Block e2e 2');

  let writes = 0;
  await page.route('**/api/tasks/ops', async (route) => {
    writes += 1;
    await route.continue();
  });

  // To the blocked column: asked first, and "cancel" sends nothing.
  const ask = page.getByRole('dialog', { name: 'Blocked by what?' });
  await drag(page, card('Block e2e 1'), column('blocked'));
  await expect(ask).toBeVisible();
  await ask.getByRole('button', { name: 'Cancel' }).click();
  await expect(ask).toBeHidden();
  expect(writes).toBe(0);

  // A name that is no task is told and nothing is sent.
  await drag(page, card('Block e2e 1'), column('blocked'));
  await ask.getByLabel(/Blocked by/).fill('nowhere/nothing');
  await ask.getByRole('button', { name: 'Block', exact: true }).click();
  await expect(ask.getByRole('alert')).toContainText('nowhere/nothing');
  expect(writes).toBe(0);

  // The real blocker: the card is in the blocked column and the engine has it.
  await ask.getByLabel(/Blocked by/).fill(blockerId);
  await ask.getByRole('button', { name: 'Block', exact: true }).click();
  await expect(column('blocked').locator('.card', { hasText: 'Block e2e 1' })).toHaveCount(1);
  expect(writes).toBe(1);
  await column('blocked').locator('.card', { hasText: 'Block e2e 1' }).click();
  await expect(page.locator('aside.detail')).toContainText(blockerId);

  // To the done zone: the preview of finishing, as with the button.
  const zone = page.getByRole('group', { name: 'Drop a card here to finish it' });
  await drag(page, card('Block e2e 2'), zone);
  const finish = page.getByRole('dialog', { name: 'Finish this task?' });
  await expect(finish).toBeVisible();
  await finish.getByRole('button', { name: 'Cancel' }).click();
  await expect(finish).toBeHidden();
  await expect(card('Block e2e 2')).toHaveCount(1);

  expect(await violations(page)).toEqual([]);
  expect(consoleProblems.get(page)).toEqual([]);
});

test('the board: taking back a move that numbered its neighbours gives every file its old order back', async ({
  page,
}) => {
  await watchViolations(page);
  await pair(page);
  await showList(page);
  for (const n of [1, 2, 3]) await capture(page, `Restore e2e ${n}`);
  await page.getByRole('searchbox', { name: /search/i }).first().fill('Restore e2e');
  await expect(page.locator('.rows .line')).toHaveCount(3);
  await chooseView(page, 'View', 'Board');
  const open = page.getByRole('region', { name: 'open', exact: true });
  const titles = () => open.locator('.card .title').allInnerTexts();
  const first = await titles();
  expect(first).toHaveLength(3);
  const files = [1, 2, 3].map((n) => join(state().vault, 'lib.nvim', 'ROADMAP', 'tasks', `restore-e2e-${n}.md`));
  const orders = () => files.map((f) => /^order:/m.test(readFileSync(f, 'utf8')));
  expect(orders()).toEqual([false, false, false]);

  // The last card one place up: the engine numbers the cards before the spot, and says how many files it wrote.
  await open.locator('.card').nth(2).click();
  await page.keyboard.press('Shift+K');
  await expect.poll(() => titles()).toEqual([first[0], first[2], first[1]]);
  await expect(page.getByRole('status').getByText(/files written/)).toBeVisible();
  expect(orders().filter(Boolean).length).toBeGreaterThan(1);

  // Undo: the place and the numbers are as they were, in every file.
  await page.getByRole('status').getByRole('button', { name: 'Undo' }).click();
  await expect(page.getByRole('status').getByText('Undone.')).toBeVisible();
  await expect.poll(() => titles()).toEqual(first);
  expect(orders()).toEqual([false, false, false]);

  // The same for a move that wrote one file only: the card had no number, and has none after the undo.
  await open.locator('.card').nth(0).click();
  await page.keyboard.press('Shift+J');
  await expect.poll(() => titles()).toEqual([first[1], first[0], first[2]]);
  await page.getByRole('status').getByRole('button', { name: 'Undo' }).click();
  await expect.poll(() => titles()).toEqual(first);
  await expect(page.getByRole('status').getByText('Undone.')).toBeVisible();
  expect(orders()).toEqual([false, false, false]);

  expect(await violations(page)).toEqual([]);
  expect(consoleProblems.get(page)).toEqual([]);
});

test('marking stops at 100: "Mark all" says so, and the box of the 101st row jumps back', async ({ page }) => {
  await watchViolations(page);
  const dir = join(state().vault, 'lib.nvim', 'ROADMAP', 'tasks');
  const files: string[] = [];
  // More tasks than one batch takes, made the way another tool would make them.
  for (let n = 1; n <= 101; n++) {
    const file = join(dir, `limit-e2e-${String(n).padStart(3, '0')}.md`);
    writeFileSync(file, `---\ntitle: Limit e2e ${String(n).padStart(3, '0')}\nstatus: open\n---\n`);
    files.push(file);
  }
  try {
    await pair(page);
    await showList(page);
    await page.getByRole('searchbox', { name: /search/i }).first().fill('Limit e2e');
    // The rows come in frames: all of them are there a moment later.
    await expect.poll(() => page.locator('.rows .line').count()).toBe(101);

    await page.getByRole('button', { name: 'Mark all shown' }).click();
    await expect(page.getByText('100 marked')).toBeVisible();
    await expect(page.getByRole('status').getByText('At most 100 tasks in one batch.')).toBeVisible();
    await expect(page.locator('.rows .line input.mark:checked')).toHaveCount(100);

    // The 101st box is refused: it is not left checked on the screen, and the count stays.
    const last = page.locator('.rows .line').last().locator('input.mark');
    await page.getByRole('status').getByRole('button', { name: 'Close' }).click();
    await last.scrollIntoViewIfNeeded();
    await last.click();
    await expect(page.getByRole('status').getByText('At most 100 tasks in one batch.')).toBeVisible();
    await expect(last).not.toBeChecked();
    await expect(page.getByText('100 marked')).toBeVisible();
    await expect(page.locator('.rows .line input.mark:checked')).toHaveCount(100);

    // Taking one off makes room for exactly that box.
    await page.locator('.rows .line').first().locator('input.mark').uncheck();
    await expect(page.getByText('99 marked')).toBeVisible();
    await last.check();
    await expect(last).toBeChecked();
    await expect(page.getByText('100 marked')).toBeVisible();
  } finally {
    for (const file of files) rmSync(file, { force: true });
  }
  expect(consoleProblems.get(page)).toEqual([]);
});

test('the bulk bar sets effort, a reminder and tags, takes a tag off, and the files say so', async ({ page }) => {
  await watchViolations(page);
  await pair(page);
  await showList(page);
  for (const n of [1, 2, 3]) await capture(page, `Bulk more e2e ${n}`);
  const file = (n: number) => join(state().vault, 'lib.nvim', 'ROADMAP', 'tasks', `bulk-more-e2e-${n}.md`);
  const text = (n: number) => readFileSync(file(n), 'utf8');
  // The second task has a tag already: the others get it added, none is taken off a task that has not got it.
  addFrontmatter('bulk-more-e2e-2', 'tags: [old, shared]');
  await page.getByRole('searchbox', { name: /search/i }).first().fill('Bulk more e2e');
  await expect(page.locator('.rows .line')).toHaveCount(3);
  // The page holds the new version of the file when its tags show in the form (the version is what is checked on writing).
  await page.locator('button.row', { hasText: 'Bulk more e2e 2' }).click();
  await expect(page.locator('aside.detail').getByLabel(/Tags/)).toHaveValue('old, shared');
  await page.getByRole('button', { name: 'Mark all shown' }).click();
  const bar = page.getByRole('group', { name: 'Change the marked tasks' });

  // A tag the engine would refuse is told and nothing is sent.
  let writes = 0;
  await page.route('**/api/tasks/ops', async (route) => {
    writes += 1;
    await route.continue();
  });
  await bar.getByPlaceholder('Add tags').fill('bad,tag, a#b');
  await bar.getByRole('button', { name: 'Apply to the marked' }).click();
  await expect(page.getByRole('status').getByText(/a#b/)).toBeVisible();
  expect(writes).toBe(0);

  await bar.getByPlaceholder('Add tags').fill('batch, shared');
  await bar.getByLabel('Effort').selectOption('S');
  await bar.getByLabel('Remind me').selectOption('+7d');
  await bar.getByRole('button', { name: 'Apply to the marked' }).click();
  await expect(page.getByRole('status').getByText('Saved: 3.')).toBeVisible();
  expect(writes).toBe(1);
  for (const n of [1, 2, 3]) {
    expect(text(n)).toMatch(/^effort: S$/m);
    expect(text(n)).toMatch(/^remind: /m);
    expect(text(n)).toMatch(/batch/);
  }
  expect(text(2)).toMatch(/old/);

  // Taken back: every file as it was.
  await page.getByRole('status').getByRole('button', { name: 'Undo' }).click();
  await expect(page.getByRole('status').getByText('Undone.')).toBeVisible();
  for (const n of [1, 2, 3]) {
    expect(text(n)).not.toMatch(/^effort:/m);
    expect(text(n)).not.toMatch(/^remind:/m);
    expect(text(n)).not.toMatch(/batch/);
  }

  // A tag taken off the marked tasks; effort and the reminder taken away with the choice "remove".
  await page.getByRole('button', { name: 'Mark all shown' }).click();
  await bar.getByPlaceholder('Remove tags').fill('shared');
  await bar.getByRole('button', { name: 'Apply to the marked' }).click();
  await expect(page.getByRole('status').getByText('Saved: 1.')).toBeVisible();
  expect(text(2)).toMatch(/old/);
  expect(text(2)).not.toMatch(/shared/);

  expect(await violations(page)).toEqual([]);
  expect(consoleProblems.get(page)).toEqual([]);
});
