import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
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
