import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Locator, type Page, type Route } from '@playwright/test';
import { expectAccessible, violations, watchViolations } from './a11y';
import { STATE } from './global';
import { pairingLink } from './hub';

test.use({ locale: 'en-US' });

const state = (): { config: string; vault: string; token: string } =>
  JSON.parse(readFileSync(STATE, 'utf8')) as { config: string; vault: string; token: string };

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
  // The dialog closes when the write is answered and the list read again. The hub gives the engine 5 s for a call,
  // and a write may first wait for the engine behind another call: on a busy runner that is more than the 5 s of an
  // expect (CI, a8827db).
  await expect(dialog).toHaveCount(0, { timeout: WRITE_BUDGET });
}

/** How long a test waits for a write to be answered: the engine's 5 s for a call, and a call it may wait behind. */
const WRITE_BUDGET = 15_000;

/** The title field of the detail: it is held back only while a write is on its way. */
function detailTitle(page: Page): Locator {
  return page.locator('aside.detail').getByLabel('Title', { exact: true });
}

/**
 * No write of the page is on its way: every card of the board can be dragged again, and the fields of the detail can
 * be edited again (the title is held back only while a write is on its way, and so is the read of the list after its
 * answer). A key or a drag while a write is on its way is not sent, and the board or the inbox may already show the
 * change before the answer is there (the hub's event of the changed file can come first; CI, 5da9dd1 and a098dff).
 * Without a card and without the title there is nothing that could tell, and the wait would pass at once: that is red.
 */
async function settled(page: Page): Promise<void> {
  const cards = page.locator('.card');
  const title = detailTitle(page);
  await expect(cards.or(title).first(), 'settled() needs a card or the title of the detail').toBeAttached();
  await expect(page.locator('.card:not([draggable="true"])')).toHaveCount(0, { timeout: WRITE_BUDGET });
  await expect(title.and(page.locator(':disabled'))).toHaveCount(0, { timeout: WRITE_BUDGET });
}

/** The answer of the next write the page sends (red after WRITE_BUDGET when none is sent or answered). */
function nextAnswer(page: Page): Promise<unknown> {
  const answer = page.waitForResponse(
    (r) => r.request().method() === 'POST' && new URL(r.url()).pathname === '/api/tasks/ops',
    { timeout: WRITE_BUDGET },
  );
  // A step that fails before the answer is awaited must not leave a rejection nobody handles.
  answer.catch(() => undefined);
  return answer;
}

/**
 * Do a step that sends one write, and wait until it is answered and the page has read the list again: what the step
 * shows can be looked at with the 5 s of an `expect` after that, and the next key or drag is sent. Red when the step
 * sends no write.
 */
async function write(page: Page, step: () => Promise<unknown>): Promise<void> {
  const answer = nextAnswer(page);
  await step();
  await answer;
  await settled(page);
}

/** How late a write made slow on purpose reaches the engine: more than the 5 s an `expect` waits by default. */
const SLOW_WRITE = 6_000;

/**
 * The calls to `path` (a write: '/api/tasks/ops', a read of the list: '/api/tasks/snapshot') reach the engine `ms`
 * late, as on a busy runner: the hub's event of the changed file and the answer both come late. `times` calls, or
 * every call to the end of the test (an unroute would let a call that is being held go on at once).
 */
async function slow(page: Page, path: string, ms: number, times?: number): Promise<void> {
  const late = async (route: Route) => {
    await new Promise((resolve) => setTimeout(resolve, ms));
    // A call still held when the test ends has nowhere to go; any other failure shows in the test's own waits.
    await route.continue().catch(() => undefined);
  };
  await page.route((url) => url.pathname === path, late, times === undefined ? {} : { times });
}

/**
 * Hold the answer of the next write until the returned function is called: the write reaches the engine (and the hub
 * tells of the changed file), only the page does not hear the answer yet. A test that never calls it is red at its
 * next wait for the answer (WRITE_BUDGET).
 */
async function holdNextWrite(page: Page): Promise<() => void> {
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  await page.route(
    '**/api/tasks/ops',
    async (route) => {
      const answer = await route.fetch();
      await held;
      await route.fulfill({ response: answer });
    },
    { times: 1 },
  );
  return release;
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

test('a link pasted into the tab that is open pairs it without a reload', async ({ page }) => {
  await watchViolations(page);
  await page.goto('/');
  await expect(page.getByRole('heading', { name: /not paired/i })).toBeVisible();
  const code = pairingLink(state().config).split('#pair=')[1] ?? '';
  // Pasting a link that differs from the address only in the fragment changes the hash and does not reload.
  await page.evaluate((c) => {
    window.location.hash = `#pair=${c}`;
  }, code);
  await showList(page);
  expect(await page.evaluate(() => location.hash)).toBe('');
  await expect(page.getByRole('heading', { name: /not paired/i })).toHaveCount(0);
  expect(await violations(page)).toEqual([]);
});

test('a code that is refused is said so, with the way out', async ({ page }) => {
  await watchViolations(page);
  await page.goto(`/#pair=${'ab'.repeat(16)}`);
  await expect(page.getByRole('heading', { name: /not paired/i })).toBeVisible();
  await expect(page.getByRole('alert').filter({ hasText: /not accepted/i })).toBeVisible();
  await expect(page.getByText('tasks-hub open')).toBeVisible();
  await expectAccessible(page, 'the refused pairing page');
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

    // The board, and the command palette over it.
    await chooseView(page, 'View', 'Board');
    await expect(page.getByRole('group', { name: 'Board' })).toBeVisible();
    await expectAccessible(page, 'the board');
    await page.keyboard.press('Control+k');
    await expect(page.getByRole('dialog', { name: 'Command palette' })).toBeVisible();
    await expectAccessible(page, 'the command palette');
    await page.keyboard.press('Escape');
  });
}

test('the German page has no violations either', async ({ page }) => {
  await pair(page);
  await page.getByRole('menuitem', { name: 'Options' }).click();
  await page.getByRole('menuitemradio', { name: 'Deutsch' }).click();
  await expect(page.getByRole('menuitem', { name: 'Ansicht' })).toBeVisible();
  await showListDe(page);
  const result = await new AxeBuilder({ page }).analyze();
  expect(result.violations, JSON.stringify(result.violations, null, 1)).toEqual([]);
  // The region of the hint popup is named in German too: the word comes from the page, not from the kit.
  await chooseView(page, 'Ansicht', 'Plan');
  await page.locator('.chips .info').focus();
  await expect(page.getByRole('region', { name: 'Erklärung', exact: true })).toBeAttached();
  await page.keyboard.press('Escape');
  await chooseView(page, 'Ansicht', 'Board');
  await expect(page.getByRole('group', { name: 'Board' })).toBeVisible();
  await expectAccessible(page, 'the board, German');
  await page.keyboard.press('Control+k');
  await expect(page.getByRole('dialog', { name: 'Befehlspalette' })).toBeVisible();
  await expectAccessible(page, 'the command palette, German');
  await page.keyboard.press('Escape');
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

test('the tiles of the overview can be put in another order with the keys, the order stays, and is reset', async ({ page }) => {
  // The tiles are drawn as their data arrives, the last of it being the next task, asked after the list: the order is
  // read once that answer is in (a signal, not a pause), and every later look polls until it holds.
  const nextRead = () => page.waitForResponse((r) => new URL(r.url()).pathname === '/api/tasks/next');
  let read = nextRead();
  await pair(page);
  await read;
  await expect(page.getByText('Next task')).toBeVisible();
  const order = () => page.locator('section[data-tile]').evaluateAll((els) =>
    els.sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top).map((e) => (e as HTMLElement).dataset.tile));
  const before = (await order()) as string[];
  expect(before.length).toBeGreaterThan(1);
  const after = [before[1], before[0], ...before.slice(2)];

  // The first block goes one place down: the grip takes the arrow key and a screen reader hears where it is now.
  const grip = page.locator(`section[data-tile="${before[0]}"] button.grip`);
  await grip.focus();
  await page.keyboard.press('ArrowDown');
  await expect.poll(order).toEqual(after);
  await expect(page.locator('p.sr-only[aria-live]')).toContainText(`is now number 2 of ${before.length}`);
  await expect(grip).toBeFocused();

  // The order is remembered, and goes back to the standard on request.
  read = nextRead();
  await page.reload();
  await read;
  await expect.poll(order).toEqual(after);
  await page.getByRole('button', { name: 'Reset the order of the tiles' }).click();
  await expect.poll(order).toEqual(before);
  await expect(page.getByRole('button', { name: 'Reset the order of the tiles' })).toHaveCount(0);
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
  await expect(page.getByRole('menuitem', { name: 'Vaults' })).toBeFocused();

  expect(await violations(page)).toEqual([]);
  await page.getByRole('menuitem', { name: 'Options' }).click();
  await page.getByRole('menuitemradio', { name: 'Dark' }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');

  // Keys can be switched off from the settings menu.
  await page.getByRole('menuitem', { name: 'Options' }).click();
  await page.getByRole('menuitemcheckbox', { name: 'Keys' }).click();
  await page.getByRole('menuitem', { name: 'Options' }).click();
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
  await expect(page.getByRole('alert').getByText(/bad#tag/)).toBeVisible();
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

  const toast = page.getByRole('alert');
  await expect(toast.getByText(/2 saved, 1 not/)).toBeVisible();
  // Only the task that failed stays marked; the other two are P1.
  await expect(page.getByText('1 marked')).toBeVisible();
  await expect(rows.filter({ hasText: 'Partial e2e 2' }).getByRole('checkbox')).toBeChecked();
  await expect(page.locator('.rows .line', { hasText: 'P1' })).toHaveCount(2);

  // The way back takes the two that went through back, as one batch.
  await toast.getByRole('button', { name: 'Undo' }).click();
  await expect(page.getByRole('status').getByText('Undone.')).toBeVisible();
  await expect(page.locator('.rows .line', { hasText: 'P1' })).toHaveCount(0);
  expect(consoleProblems.get(page)).toEqual([]);
});

test('a list that typing it back would clean up is not edited as one line', async ({ page }) => {
  await watchViolations(page);
  await pair(page);
  await showList(page);
  await page.keyboard.press('c');
  const capture = page.getByRole('dialog', { name: 'New task' });
  await capture.getByLabel('Title').fill('Dup tags e2e');
  await capture.locator('select').first().selectOption('lib.nvim');
  await capture.getByRole('button', { name: 'Create' }).click();
  await expect(capture).toHaveCount(0);
  // Someone wrote the same tag twice in the file: the line would be cleaned up if it were typed back.
  const file = join(state().vault, 'lib.nvim', 'ROADMAP', 'tasks', 'dup-tags-e2e.md');
  writeFileSync(file, readFileSync(file, 'utf8').replace(/^status: .*$/m, (line) => `${line}
tags: [dup, dup]`));
  await page.getByRole('searchbox', { name: /search/i }).first().fill('Dup tags e2e');
  await open(page, 'lib.nvim/dup-tags-e2e');
  const tags = page.locator('aside.detail').getByLabel('Tags');
  await expect(tags).toBeDisabled();
  await expect(tags).toHaveAttribute('title', /change it in the file/);
  expect(consoleProblems.get(page)).toEqual([]);
});

test('the inbox sorts tasks with single keys and nothing else', async ({ page }) => {
  await watchViolations(page);
  await pair(page);
  await showList(page);
  for (const n of [1, 2, 3]) {
    await page.keyboard.press('c');
    const capture = page.getByRole('dialog', { name: 'New task' });
    await capture.getByLabel('Title').fill(`Inbox e2e ${n}`);
    await capture.locator('select').first().selectOption('lib.nvim');
    await capture.getByRole('button', { name: 'Create' }).click();
    await expect(capture).toHaveCount(0);
  }
  // g i opens the inbox: the new tasks lack everything.
  await page.keyboard.press('g');
  await page.keyboard.press('i');
  const inbox = page.locator('section.inbox');
  await expect(inbox).toBeVisible();
  for (const n of [1, 2, 3]) {
    await expect(inbox.locator('.row', { hasText: `inbox-e2e-${n}` })).toContainText(/no priority.*no effort.*no who/);
  }
  await expectAccessible(page, 'inbox');
  const toast = page.getByRole('status');
  for (const n of [1, 2, 3]) {
    const row = inbox.locator('.row', { hasText: `lib.nvim/inbox-e2e-${n}` });
    await row.click();
    await expect(page.locator('aside.detail .id')).toHaveText(`lib.nvim/inbox-e2e-${n}`);
    // Priority, effort and who, each with one key; the row loses a chip after each, and leaves with the last.
    await page.keyboard.press('2');
    await expect(toast.getByText('Saved')).toBeVisible();
    await expect(row).not.toContainText('no priority');
    await page.keyboard.press(n === 3 ? 'Shift+f' : 's');
    await expect(row).not.toContainText('no effort');
    await page.keyboard.press(n === 2 ? 'p' : 'm');
    await expect(row).toHaveCount(0);
  }
  // What the keys wrote is in the files.
  const text = (n: number) => readFileSync(join(state().vault, 'lib.nvim', 'ROADMAP', 'tasks', `inbox-e2e-${n}.md`), 'utf8');
  expect(text(1)).toMatch(/prio: 2[\s\S]*effort: S[\s\S]*actor: me/);
  expect(text(2)).toMatch(/actor: pair/);
  expect(text(3)).toMatch(/effort: XL/);
  // u takes the last one back: the task is in the inbox again, without a who.
  await page.keyboard.press('u');
  await expect(toast.getByText('Undone.')).toBeVisible();
  await expect(inbox.locator('.row', { hasText: 'lib.nvim/inbox-e2e-3' })).toContainText('no who');
  expect(consoleProblems.get(page)).toEqual([]);
});

test('the estimate matrix sets effort and value of several tasks, with the figures of the engine, in one batch', async ({ page }) => {
  await watchViolations(page);
  await pair(page);
  await showList(page);
  for (const n of [1, 2]) {
    await page.keyboard.press('c');
    const capture = page.getByRole('dialog', { name: 'New task' });
    await capture.getByLabel('Title').fill(`Matrix e2e ${n}`);
    await capture.locator('select').first().selectOption('lib.nvim');
    await capture.getByRole('button', { name: 'Create' }).click();
    await expect(capture).toHaveCount(0);
  }
  await page.getByRole('searchbox', { name: /search/i }).first().fill('Matrix e2e');
  await expect(page.locator('.rows .line')).toHaveCount(2);
  await page.getByRole('button', { name: 'Mark all shown' }).click();
  // The key e opens the matrix on the marked tasks.
  await page.locator('body').press('e');
  const matrix = page.getByRole('dialog', { name: 'Estimate' });
  await expect(matrix).toBeVisible();
  await expect(matrix.getByRole('row')).toHaveCount(3);
  const figures = matrix.getByRole('status');
  await expect(figures).toContainText('0 of 2 have an effort, 0 of 2 a value');
  await expectAccessible(page, 'estimate matrix');
  // Nothing is written by choosing: the engine only reckons.
  const file = (n: number) => join(state().vault, 'lib.nvim', 'ROADMAP', 'tasks', `matrix-e2e-${n}.md`);
  await matrix.getByLabel('Effort: lib.nvim/matrix-e2e-1').selectOption('M');
  await matrix.getByLabel('Value: lib.nvim/matrix-e2e-1').selectOption('4');
  await matrix.getByLabel('Effort: lib.nvim/matrix-e2e-2').selectOption('XL');
  // M and XL: the engine reckons the sum and the range of the sizes, the page shows them.
  await expect(figures).toContainText('2 tasks - 6 days (between 3.7 and 9.5) - value 4');
  await expect(figures).toContainText('2 of 2 have an effort, 1 of 2 a value');
  expect(readFileSync(file(1), 'utf8')).not.toMatch(/effort:/);
  await expect(matrix.getByRole('button', { name: 'Apply' })).toBeEnabled();
  await matrix.getByRole('button', { name: 'Apply' }).click();
  await expect(matrix).toHaveCount(0);
  expect(readFileSync(file(1), 'utf8')).toMatch(/effort: M[\s\S]*value: 4|value: 4[\s\S]*effort: M/);
  expect(readFileSync(file(2), 'utf8')).toMatch(/effort: XL/);
  expect(readFileSync(file(2), 'utf8')).not.toMatch(/value:/);
  // The way back takes both back, as one batch.
  const toast = page.getByRole('status').filter({ hasText: 'Undo' });
  await toast.getByRole('button', { name: 'Undo' }).click();
  await expect(page.getByRole('status').getByText('Undone.')).toBeVisible();
  expect(readFileSync(file(2), 'utf8')).not.toMatch(/effort:/);
  expect(consoleProblems.get(page)).toEqual([]);
});

test('the graph of a task lists what it needs and what waits for it, as a list', async ({ page }) => {
  await watchViolations(page);
  await pair(page);
  await showList(page);
  await open(page, 'cascade.nvim/iota');
  // How often the graph is asked for: once when it opens, once more when the vault changed, never in between.
  const asked: string[] = [];
  page.on('request', (r) => {
    if (r.url().includes('/api/tasks/plan_for')) asked.push(r.url());
  });
  await page.locator('aside.detail').getByRole('button', { name: 'What do I need for this?' }).click();
  const graph = page.locator('section.graph');
  await expect(graph).toBeVisible();
  // The panel takes the focus when it opens (the button that opened it is gone from the page).
  await expect(graph.getByRole('heading', { name: 'What cascade.nvim/iota needs' })).toBeFocused();
  await expect(graph.getByRole('status')).toContainText('2 tasks');
  // The task itself first, then what it needs, one step in; the edge is the engine's.
  const nodes = graph.locator('ol.nodes > li');
  await expect(nodes).toHaveCount(2);
  await expect(nodes.nth(0)).toContainText('cascade.nvim/iota');
  await expect(nodes.nth(1)).toContainText('lib.nvim/alpha');
  await expect(nodes.nth(0)).toContainText('waits for: lib.nvim/alpha');
  await expect(nodes.nth(1)).toHaveAttribute('aria-level', '2');
  await expectAccessible(page, 'graph');
  // The arrow keys move between the nodes.
  await nodes.nth(0).getByRole('button').focus();
  await page.keyboard.press('ArrowDown');
  await expect(nodes.nth(1).getByRole('button')).toBeFocused();
  // Nothing asks again by itself (an effect that listened to its own answer asked for ever) ...
  await page.waitForTimeout(900);
  expect(asked).toHaveLength(1);
  // ... and a change of the vault asks once more.
  writeFileSync(
    join(state().vault, 'lib.nvim', 'ROADMAP', 'tasks', 'graph-reload-e2e.md'),
    '---\ntitle: Graph reload e2e\nstatus: open\n---\n\n## Kontext\n',
  );
  await expect.poll(() => asked.length, { timeout: 15_000 }).toBe(2);
  await page.waitForTimeout(900);
  expect(asked).toHaveLength(2);
  // The other way: nothing waits for this task.
  await graph.getByRole('button', { name: 'Unlocks' }).click();
  await expect(graph.getByRole('heading', { name: 'What waits for cascade.nvim/iota' })).toBeVisible();
  await expect(nodes).toHaveCount(1);
  await graph.getByRole('button', { name: 'Close' }).click();
  await expect(graph).toHaveCount(0);
  await expect(page.locator('section.stages')).toBeFocused();
  // The palette opens it again (the task is still selected); Escape closes it from inside and gives the focus back.
  await page.keyboard.press('Control+k');
  await page.keyboard.type('What do I need');
  await page.keyboard.press('Enter');
  await expect(graph).toBeVisible();
  await expect(graph.getByRole('heading', { name: 'What cascade.nvim/iota needs' })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(graph).toHaveCount(0);
  await expect(page.locator('section.stages')).toBeFocused();
  expect(consoleProblems.get(page)).toEqual([]);
});

test('the check runs as a job in the background and its findings reach the list and the detail', async ({ page }) => {
  await watchViolations(page);
  await pair(page);
  await showList(page);
  await page.getByRole('button', { name: 'Check ...' }).click();
  const dialog = page.getByRole('dialog', { name: 'Check the vault' });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('status')).toContainText('No check has run yet.');
  await expectAccessible(page, 'check dialog');
  await dialog.getByRole('button', { name: 'Check now' }).click();
  // The engine's findings, with the task each is about; the fixture has broken tasks.
  await expect(dialog.getByRole('status')).toContainText(/Errors: \d+, warnings: \d+, task files: \d+/, { timeout: 30_000 });
  const findings = dialog.locator('ul.findings li');
  await expect(findings.first()).toBeVisible();
  await expect(findings.filter({ hasText: 'lib.nvim/broken' }).first()).toContainText('bad-');
  await expectAccessible(page, 'check findings');
  // The jump goes to the task in the list, and the detail names the findings.
  await findings.filter({ hasText: 'lib.nvim/broken' }).first().getByRole('button', { name: 'lib.nvim/broken' }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.locator('aside.detail .id')).toHaveText('lib.nvim/broken');
  await expect(page.locator('aside.detail').getByRole('heading', { name: 'Findings of the check' })).toBeVisible();
  await expect(page.locator('aside.detail ul.findings')).toContainText('bad-');
  // The row carries a flag with the number of findings.
  await expect(page.locator('button.row', { hasText: 'lib.nvim/broken' }).locator('.tag.bad', { hasText: '⚑' })).toBeVisible();
  expect(consoleProblems.get(page)).toEqual([]);
});

test('the keys of the inbox stay out of fields and dialogs, ignore a held key and read the letter without its case', async ({ page }) => {
  await watchViolations(page);
  await pair(page);
  await showList(page);
  for (const n of [1, 2]) {
    await page.keyboard.press('c');
    const capture = page.getByRole('dialog', { name: 'New task' });
    await capture.getByLabel('Title').fill(`Inbox keys ${n}`);
    await capture.locator('select').first().selectOption('lib.nvim');
    await capture.getByRole('button', { name: 'Create' }).click();
    await expect(capture).toHaveCount(0);
  }
  await page.keyboard.press('g');
  await page.keyboard.press('i');
  const inbox = page.locator('section.inbox');
  await expect(inbox).toBeVisible();
  const writes: string[] = [];
  page.on('request', (r) => {
    if (r.url().includes('/api/tasks/ops') && r.method() === 'POST') writes.push(r.url());
  });
  const row = inbox.locator('.row', { hasText: 'lib.nvim/inbox-keys-1' });
  await row.click();
  await expect(page.locator('aside.detail .id')).toHaveText('lib.nvim/inbox-keys-1');
  // Typing in a field of the detail writes nothing to the task: m, s and 1 are letters there.
  const tags = page.locator('aside.detail').getByLabel('Tags');
  await tags.focus();
  await page.keyboard.type('ms1');
  await page.keyboard.press('Control+a');
  await page.keyboard.press('Backspace');
  // A dialog takes the keys too.
  await page.keyboard.press('Control+k');
  const palette = page.getByRole('dialog');
  await expect(palette).toBeVisible();
  await page.keyboard.type('ms1');
  await page.keyboard.press('Escape');
  await expect(palette).toHaveCount(0);
  await row.click();
  expect(writes).toHaveLength(0);
  // A held key is not written again: the repeat is ignored.
  await page.evaluate(() => {
    document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', { key: '2', repeat: true, bubbles: true }));
  });
  await page.waitForTimeout(300);
  expect(writes).toHaveLength(0);
  // With CapsLock on, j arrives as J without Shift: it still moves the selection.
  const current = inbox.locator('.row[aria-current="true"] .id');
  const before = await current.innerText();
  await page.keyboard.press('J');
  await expect(current).not.toHaveText(before);
  await page.keyboard.press('K');
  await expect(current).toHaveText(before);
  // And the real key writes once.
  await page.keyboard.press('2');
  await expect(page.getByRole('status').getByText('Saved')).toBeVisible();
  expect(writes).toHaveLength(1);
  expect(consoleProblems.get(page)).toEqual([]);
});

test('the inbox keeps the selection at the place of a task that was sorted, and a selection of none stays', async ({ page }) => {
  // Every read of the list is slow on purpose from the second key on (1.5 s each), and each write may take a few
  // seconds on a busy runner: the 30 s of a test are not enough for that (test.slow gives three times as much).
  test.slow();
  await watchViolations(page);
  await pair(page);
  await showList(page);
  // A name of its own for each repeat (--repeat-each with the one worker shares the vault).
  const repeat = test.info().repeatEachIndex;
  const name = `Inbox mid${repeat === 0 ? '' : repeat}`;
  const slug = `inbox-mid${repeat === 0 ? '' : repeat}`;
  for (const n of [1, 2, 3]) await capture(page, `${name} ${n}`);
  await page.keyboard.press('g');
  await page.keyboard.press('i');
  const inbox = page.locator('section.inbox');
  await expect(inbox).toBeVisible();
  const middle = inbox.locator('.row', { hasText: `lib.nvim/${slug}-2` });
  await middle.click();
  // Sorted from the middle of the list: the selection stays where the task was, on the one that took its place.
  // The answer of the first key is held until the row shows the priority, as the hub's event of the changed file may
  // show it before the answer is there: the next key waits for the answer, not for the picture (a key while a write
  // is on its way is not sent; CI, a098dff). Every read of the list is slow from then on, and the write is on its way
  // until the read after its answer is done: only the title of the detail tells that here (the inbox has no card), so
  // a settled() that did not wait for the title would let 's' go while the write is on its way, and 's' would be lost.
  const release = await holdNextWrite(page);
  const answer = nextAnswer(page);
  await page.keyboard.press('2');
  await expect(middle).not.toContainText('no priority', { timeout: WRITE_BUDGET });
  await slow(page, '/api/tasks/snapshot', 1_500);
  release();
  await answer;
  await expect(detailTitle(page)).toBeDisabled();
  await settled(page);
  await write(page, () => page.keyboard.press('s'));
  await expect(middle).not.toContainText('no effort');
  // (the engine's order moves a task when its priority is set: the neighbour is looked at before the last key)
  const ids = await inbox.locator('.row .id').allInnerTexts();
  const at = ids.indexOf(`lib.nvim/${slug}-2`);
  expect(at).toBeGreaterThanOrEqual(0);
  const next = ids[at + 1];
  expect(next).toBeDefined();
  await write(page, () => page.keyboard.press('m'));
  await expect(middle).toHaveCount(0);
  await expect(inbox.locator('.row[aria-current="true"] .id')).toHaveText(next as string);
  // Escape selects none; a change of the vault does not put the selection back.
  await page.keyboard.press('Escape');
  await expect(inbox.locator('.row[aria-current="true"]')).toHaveCount(0);
  writeFileSync(
    join(state().vault, 'lib.nvim', 'ROADMAP', 'tasks', `${slug}-later-e2e.md`),
    `---\ntitle: ${name} later\nstatus: open\n---\n\n## Kontext\n`,
  );
  await expect(inbox.locator('.row', { hasText: `${slug}-later-e2e` })).toBeVisible({ timeout: 15_000 });
  await page.waitForTimeout(500);
  await expect(inbox.locator('.row[aria-current="true"]')).toHaveCount(0);
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
  await expect(page.getByRole('alert').getByText(/bad#tag/)).toBeVisible();
  await expect(tags).toHaveValue('keep, bad#tag');
  await open(page, 'lib.nvim/travel-e2e-2');
  await expect(tags).toHaveValue('');
});

test('the board: cards move by key and by drag, the engine keeps the order, a priority border is not crossed', async ({
  page,
}) => {
  // Two writes are made slow on purpose (SLOW_WRITE each), and each of the others may take a few seconds on a busy
  // runner, up to WRITE_BUDGET: the 30 s of a test are not enough for that (test.slow gives three times as much).
  test.slow();
  await watchViolations(page);
  await pair(page);
  await showList(page);

  // The first write reaches the engine late, as on a busy runner: more than the 5 s an expect waits by default.
  await slow(page, '/api/tasks/ops', SLOW_WRITE, 1);
  // A title of its own for each repeat (--repeat-each with the one worker shares the vault). The search finds a word
  // anywhere in a title ('Board' finds 'Board1'), so the word of a repeat has a fixed width: no repeat's word is a part
  // of another's, whatever is in the vault already.
  const prefix = `Board e2e r${String(test.info().repeatEachIndex).padStart(3, '0')}`;
  for (const n of [1, 2, 3]) await capture(page, `${prefix} ${n}`);
  // The filter of the list is the filter of the board.
  await page.getByRole('searchbox', { name: /search/i }).first().fill(prefix);
  await expect(page.locator('.rows .line')).toHaveCount(3);
  await chooseView(page, 'View', 'Board');

  const column = (name: string) => page.getByRole('region', { name, exact: true });
  const titles = (name: string) => column(name).locator('.card .title').allInnerTexts();
  await expect(column('open').locator('.card')).toHaveCount(3);
  const first = await titles('open');
  expect(first).toHaveLength(3);

  // J moves the selected card one place down inside its group, and the engine's order says so after a reload. Each
  // write below is awaited by write(): its answer gets WRITE_BUDGET, and this one is slow on purpose to hold that.
  await column('open').locator('.card').first().click();
  await slow(page, '/api/tasks/ops', SLOW_WRITE, 1);
  await write(page, () => page.keyboard.press('Shift+J'));
  // (a reorder may renumber the neighbours: "Saved (n files written ...)"; the "Saved." of the last create is gone)
  await expect(page.getByRole('status').getByText(/^Saved/)).toBeVisible();
  const moved = [first[1], first[0], first[2]];
  await expect.poll(() => titles('open')).toEqual(moved);
  await page.reload();
  await expect(page.getByRole('menubar')).toBeVisible();
  // The filter is not kept over a reload: narrow to the three again through the list.
  await chooseView(page, 'View', 'List');
  await page.getByRole('searchbox', { name: /search/i }).first().fill(prefix);
  await chooseView(page, 'View', 'Board');
  await expect(column('open').locator('.card')).toHaveCount(3);
  expect(await titles('open')).toEqual(moved);

  // K takes it back; at the edge of the group there is nowhere to go, and that is told.
  await column('open').locator('.card').nth(1).click();
  // (the order can stand before the write is answered: its "Saved." would replace what the next key tells)
  await write(page, () => page.keyboard.press('Shift+K'));
  await expect.poll(() => titles('open')).toEqual(first);
  await page.keyboard.press('Shift+K');
  await expect(page.getByRole('alert').getByText(/end of its priority group/)).toBeVisible();

  // Drag one card onto the lower half of another: the order changes by a reorder.
  const cards = column('open').locator('.card');
  await write(page, () => drag(page, cards.nth(0), cards.nth(2), 'lower'));
  await expect.poll(() => titles('open')).toEqual([first[1], first[2], first[0]]);

  // Drag a card into another column: the status changes.
  const name = (await titles('open'))[0] as string;
  await write(page, () => drag(page, column('open').locator('.card', { hasText: name }), column('doing')));
  await expect(column('doing').locator('.card', { hasText: name })).toHaveCount(1);
  await expect(column('open').locator('.card')).toHaveCount(2);

  // H and L change the status of the selected card with the keys. The answer of L is held: the hub's event of the
  // changed file moves the card while the write is still on its way, and H is pressed when the write is done.
  await column('doing').locator('.card', { hasText: name }).click();
  const release = await holdNextWrite(page);
  const answer = nextAnswer(page);
  await page.keyboard.press('Shift+L');
  await expect(column('decision').locator('.card', { hasText: name })).toHaveCount(1, { timeout: WRITE_BUDGET });
  release();
  await answer;
  await settled(page);
  await write(page, () => page.keyboard.press('Shift+H'));
  await expect(column('doing').locator('.card', { hasText: name })).toHaveCount(1);

  // A card of another priority is another group: the engine orders inside a group only, so the move is refused.
  const other = (await titles('open'))[0] as string;
  await column('open').locator('.card', { hasText: other }).click();
  await write(page, () => page.locator('aside.detail').getByLabel('Priority').selectOption('1'));
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
  await expect(page.getByRole('alert').getByText(/holds inside one priority/)).toBeVisible();

  // The other way - a card without a priority dropped under the card of priority 1 - asks whether the priority
  // goes with it. No is nothing sent; yes is one batch (the priority, then the place), read back after a reload.
  const mover = (await rest.first().locator('.title').innerText()) as string;
  const target = column('open').locator('.card', { hasText: other });
  await drag(page, column('open').locator('.card', { hasText: mover }), target, 'lower');
  const ask = page.getByRole('dialog', { name: 'Priority 1?' });
  await expect(ask).toBeVisible();
  await expectAccessible(page, 'the priority dialog');
  await ask.getByRole('button', { name: 'Cancel' }).click();
  await expect(ask).toBeHidden();
  expect(writes).toBe(0);
  await drag(page, column('open').locator('.card', { hasText: mover }), target, 'lower');
  await write(page, () => ask.getByRole('button', { name: /Set priority 1/ }).click());
  await expect(page.getByRole('status').getByText(/Saved/)).toBeVisible();
  expect(writes).toBe(1);
  await expect.poll(() => titles('open')).toEqual([other, mover]);
  await page.reload();
  await expect(page.getByRole('menubar')).toBeVisible();
  await chooseView(page, 'View', 'List');
  await page.getByRole('searchbox', { name: /search/i }).first().fill(prefix);
  await chooseView(page, 'View', 'Board');
  await expect.poll(() => titles('open')).toEqual([other, mover]);
  await column('open').locator('.card', { hasText: mover }).click();
  await expect(page.locator('aside.detail').getByLabel('Priority')).toHaveValue('1');

  expect(await violations(page)).toEqual([]);
  expect(consoleProblems.get(page)).toEqual([]);
});

test('explanations: a chip says what it means on hover, the info button on focus, Escape closes, and the days are written out', async ({
  page,
}) => {
  await watchViolations(page);
  await pair(page);
  await chooseView(page, 'View', 'Plan');
  const tip = page.locator('#hint-tip');
  await expect(tip).toBeHidden();

  // The pointer: the first counter is "ready", and its popup says what that is.
  const chip = page.locator('.chips .chip').first();
  await chip.hover();
  await expect(tip).toBeVisible();
  await expect(tip).toContainText('No open blocker');
  // The popup can be reached: the pointer may move onto it, and it stays.
  const box = await tip.boundingBox();
  if (!box) throw new Error('popup not drawn');
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.waitForTimeout(400);
  await expect(tip).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(tip).toBeHidden();

  // The keyboard: the info button after the counters shows all six meanings, and the page keeps them for a screen reader.
  const info = page.locator('.chips .info');
  await info.focus();
  await expect(tip).toBeVisible();
  // The region of the popup carries the page's word (the kit has none): here the English one.
  await expect(page.getByRole('region', { name: 'Explanation', exact: true })).toBeAttached();
  await expect(tip).toContainText('freed');
  await expect(tip).toContainText('Its status says blocked');
  await expect(info).toHaveAttribute('aria-describedby', /\S+/);
  await expectAccessible(page, 'the plan view with an explanation open');
  await info.blur();
  await expect(tip).toBeHidden();

  // The unit is written out, and the critical path has its explanation.
  await expect(page.getByRole('heading', { name: /Critical path: [\d.,]+ days?$/ })).toBeVisible();
  await page.getByRole('button', { name: 'Explanation: Critical path' }).focus();
  await expect(tip).toContainText('longest chain of tasks');
  expect(await violations(page)).toEqual([]);
});

test('connections: the links between areas, narrowed to the chosen areas, and the tasks that connect them in the list', async ({
  page,
}) => {
  await watchViolations(page);
  await pair(page);
  await chooseView(page, 'View', 'Connections');
  // The fixture has one task of cascade.nvim that waits for one of lib.nvim.
  const row = page.locator('.pairs > li', { hasText: 'cascade.nvim ↔ lib.nvim' });
  await expect(row).toBeVisible();
  await row.getByText('cascade.nvim ↔ lib.nvim').click();
  // The edges are in the page closed or open: it is the click that makes them visible.
  await expect(row.getByText('waits for')).toBeVisible();
  await expectAccessible(page, 'the connections');

  // The engine finds more than the list does: the ref `lib.nvim@abc1234` of cascade.nvim/theta names the repo (the
  // plain path next to it says nothing), and the pair has two links now.
  await expect(row.getByText('names the repo in the ref')).toBeVisible();
  await expect(row.getByText('lib.nvim@abc1234')).toBeVisible();
  await expect(row.getByText('lua/x.lua')).toHaveCount(0);
  // The matrix has the number of the pair as a button that opens the pair.
  const cell = page.getByRole('button', { name: 'cascade.nvim and lib.nvim: 2 links, open the list' });
  await expect(cell).toBeVisible();
  await row.getByText('cascade.nvim ↔ lib.nvim').click();
  await expect(row.getByText('waits for')).toBeHidden();
  await cell.click();
  await expect(row.getByText('waits for')).toBeVisible();
  // The matrix is symmetric: the pair is one button, not two; the click moves the focus to the pair it opened.
  await expect(page.getByRole('button', { name: /^cascade\.nvim and lib\.nvim:|^lib\.nvim and cascade\.nvim:/ })).toHaveCount(1);
  await expect(row.locator('summary')).toBeFocused();

  // Only lib.nvim chosen: no link between two chosen areas. Both chosen: the link is back.
  await page.getByRole('region', { name: 'Links between areas' }).getByRole('button', { name: 'Areas' }).click();
  await page.getByRole('checkbox', { name: 'lib.nvim' }).check();
  await expect(page.getByText('No open task links two of the chosen areas.')).toBeVisible();
  await page.getByRole('checkbox', { name: 'cascade.nvim' }).check();
  await page.keyboard.press('Escape');
  await expect(row).toBeVisible();

  // The list, narrowed to the tasks on the two ends of a link.
  await page.getByRole('button', { name: 'Show the connecting tasks in the list' }).click();
  await expect(page.getByRole('list', { name: 'Filters that are on' })).toContainText('only tasks that connect areas');
  const rows = page.locator('button.row');
  await expect(rows.filter({ hasText: 'cascade.nvim/iota' })).toHaveCount(1);
  await expect(rows.filter({ hasText: 'lib.nvim/alpha' })).toHaveCount(1);
  await expect(rows.filter({ hasText: 'lib.nvim/beta' })).toHaveCount(0);
  // The tasks that touch two areas carry a mark with the areas in its title (also the one that is only named in a ref).
  await expect(rows.filter({ hasText: 'cascade.nvim/theta' }).locator('[data-hint^="Touches 2 areas"]')).toHaveCount(1);
  expect(await violations(page)).toEqual([]);
});

test('finished: the figures of a period come from the engine, a click on an area or a month narrows them', async ({
  page,
}) => {
  await watchViolations(page);
  await pair(page);
  await chooseView(page, 'View', 'Finished');
  // The fixture finished four tasks between 2025-12-30 and 2026-01-02 (other tests finish more, today).
  await page.getByRole('combobox', { name: /^Period/ }).selectOption('custom');
  await page.getByLabel('From', { exact: true }).fill('2025-12-01');
  await page.getByLabel('To', { exact: true }).fill('2026-01-31');
  const status = page.locator('.done p[role=status]');
  await expect(status).toContainText('4 tasks finished. Effort in days: 3.');
  await expect(status).toContainText('2 of them have no effort');
  const byArea = page.getByRole('region', { name: 'By area' });
  await expect(byArea.getByRole('row', { name: /lib\.nvim 2/ })).toBeVisible();
  await expect(byArea.getByRole('row', { name: /cascade\.nvim 2/ })).toBeVisible();
  await expectAccessible(page, 'the finished tasks');

  // An area narrows the figures to it: cascade.nvim has the feature (a medium task, one day) and one without a size.
  await byArea.getByRole('button', { name: 'cascade.nvim' }).click();
  await expect(status).toContainText('2 tasks finished. Effort in days: 1.');
  await expect(page.getByText('Showing: cascade.nvim')).toBeVisible();
  await page.getByRole('button', { name: 'Show everything' }).click();
  await expect(status).toContainText('4 tasks finished.');

  // A month: December 2025 has the bug and the feature.
  await page.getByRole('region', { name: 'Over time' }).getByRole('button', { name: '2025-12' }).click();
  await expect(status).toContainText('2 tasks finished. Effort in days: 3.');
  await expect(page.getByText('Showing: 2025-12')).toBeVisible();
  const list = page.getByRole('region', { name: 'Finished tasks, newest first' });
  await expect(list).toContainText('Shipped feature');
  await expect(list).toContainText('Shipped bug');
  await expect(list).not.toContainText('Done without an effort');
  expect(await violations(page)).toEqual([]);

  // A window that cuts the month: only the part inside it counts, and the page agrees with the row (the bug of the
  // 30th is out of it, the feature of the 31st is in).
  await page.getByRole('button', { name: 'Show everything' }).click();
  await page.getByLabel('From', { exact: true }).fill('2025-12-31');
  const cut = page.getByRole('region', { name: 'Over time' });
  await expect(cut.getByRole('row', { name: /2025-12 1/ })).toBeVisible();
  await cut.getByRole('button', { name: '2025-12' }).click();
  await expect(status).toContainText('1 task finished.');
  await expect(list).toContainText('Shipped feature');
  await expect(list).not.toContainText('Shipped bug');

  // A period without a finished task says so.
  await page.getByRole('button', { name: 'Show everything' }).click();
  await page.getByLabel('From', { exact: true }).fill('2020-01-01');
  await page.getByLabel('To', { exact: true }).fill('2020-01-31');
  await expect(page.getByText('No task was finished in this period.')).toBeVisible();
});

test('finished: the list shows them under the open ones, narrowed by the area and the text, and the period is remembered', async ({
  page,
}) => {
  await watchViolations(page);
  await pair(page);
  await showList(page);
  const finished = page.getByRole('region', { name: 'Finished' });
  await expect(finished).toHaveCount(0);
  await page.getByLabel('Show finished tasks under the list').check();
  await expect(finished).toBeVisible();
  // All time, so that the dates of the fixture (2025-12-30 ... 2026-01-02) are in.
  await finished.getByLabel('Period').selectOption('all');
  await expect(finished).toContainText('Shipped bug');
  await expect(finished).toContainText('Shipped feature');
  // The text of the list narrows them, the same text that narrows the open tasks.
  await page.getByRole('searchbox').fill('feature');
  await expect(finished).toContainText('Shipped feature');
  await expect(finished).not.toContainText('Shipped bug');
  expect(await violations(page)).toEqual([]);

  // The period of the view of the finished tasks is kept over a reload.
  await page.getByRole('searchbox').fill('');
  await chooseView(page, 'View', 'Finished');
  const period = page.getByRole('combobox', { name: /^Period/ });
  await period.selectOption('30');
  // The view that was left open asks as soon as it is drawn from the cache, before the hub has answered hello: that
  // question must carry the session of the tab (an unsigned one is refused and the page then believes the session
  // lost). The hello is held back until that question was seen, so the order is the test's, not the timing's; if the
  // page does not draw from the cache and ask first, the wait for the question runs out and the test is red.
  let releaseHello: () => void = () => undefined;
  const helloHeld = new Promise<void>((r) => (releaseHello = r));
  await page.route('**/api/tasks/hello', async (route) => {
    await helloHeld;
    await route.continue();
  });
  const asked = page.waitForRequest((r) => new URL(r.url()).pathname === '/api/tasks/finished');
  await page.reload();
  const first = await asked;
  expect(first.headers()['authorization'] ?? '').toMatch(/^Bearer \S+/);
  releaseHello();
  await expect(page.getByRole('combobox', { name: /^Period/ })).toHaveValue('30');
});

test('finished: a plan shows its finished tasks ticked when asked, and only those of the chosen plan', async ({ page }) => {
  await watchViolations(page);
  await pair(page);
  await chooseView(page, 'View', 'Plan');
  // The whole vault is no plan: there is nothing to ask for.
  await expect(page.getByLabel('Show the finished tasks of this plan')).toHaveCount(0);
  await page.getByRole('combobox', { name: 'Plan' }).selectOption('lib.nvim/the-plan');
  const box = page.getByLabel('Show the finished tasks of this plan');
  await expect(box).not.toBeChecked();
  await expect(page.getByText('Shipped bug')).toHaveCount(0);
  await box.check();
  const group = page.getByRole('region', { name: /^Finished/ });
  await expect(group).toContainText('Shipped bug');
  await expect(group).toContainText('2025-12-30');
  // A finished task of another plan (or none) is not in it.
  await expect(group).not.toContainText('Shipped feature');
  expect(await violations(page)).toEqual([]);
  await box.uncheck();
  await expect(page.getByText('Shipped bug')).toHaveCount(0);
});

test('explanations: the board, the inbox and the matrix say what their labels mean, also inside the modal dialog of the matrix', async ({
  page,
}) => {
  await watchViolations(page);
  await pair(page);
  const tip = page.locator('#hint-tip');

  await chooseView(page, 'View', 'Board');
  await page.locator('.column h2 > span[data-hint]').first().hover();
  await expect(tip).toContainText('Somebody works on it');
  await page.locator('.column h2 .n').first().hover();
  await expect(tip).toContainText('How many cards this column holds');
  await page.locator('.donezone').hover();
  await expect(tip).toContainText('Drop a card on this strip');
  await page.locator('button.card .tag', { hasText: /^P\d$/ }).first().hover();
  await expect(tip).toContainText('Priority: 1 is the most urgent');
  await page.keyboard.press('Escape');
  // The headings of the board are hover only; the keyboard has the explanation button.
  await page.getByRole('button', { name: 'Explanation: Board' }).focus();
  await expect(tip).toContainText('Drop a card on the strip above the columns');
  await page.keyboard.press('Escape');

  await chooseView(page, 'View', 'Inbox');
  await page.getByRole('button', { name: 'Explanation: Inbox' }).focus();
  await expect(tip).toContainText('lack a priority, an effort or a who');
  await page.locator('.inbox .row .tag').first().hover();
  await expect(tip).toContainText(/is written/);
  await page.keyboard.press('Escape');

  // The matrix is a modal dialog: the popup has to be in front of it and inside it, not behind its backdrop.
  await showList(page);
  await page.getByRole('button', { name: 'Estimate ...' }).click();
  const dialog = page.locator('dialog[open]');
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'Explanation: Effort' }).focus();
  await expect(dialog.locator('#hint-tip')).toBeVisible();
  // The column header keeps its own name; the explanation button is not part of it.
  await expect(dialog.getByRole('columnheader', { name: 'Effort', exact: true })).toBeVisible();
  await expect(tip).toContainText('XS is a quarter of a day');
  const covered = await tip.evaluate((el) => {
    const r = el.getBoundingClientRect();
    const top = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
    return !(top && (el === top || el.contains(top)));
  });
  expect(covered).toBe(false);
  expect(await violations(page)).toEqual([]);
  // The first Escape closes only the explanation, with the draft of the dialog still open; the popup goes home to the
  // page; the second Escape closes the dialog.
  await page.keyboard.press('Escape');
  await expect(tip).toBeHidden();
  await expect(dialog).toBeVisible();
  await expect(page.locator('body > .hint-host')).toHaveCount(1);
  await page.keyboard.press('Escape');
  await expect(page.locator('dialog[open]')).toHaveCount(0);
});

test('more filters: any field, switched on in a row of chips that can be taken off one by one, and reset', async ({
  page,
}) => {
  await watchViolations(page);
  await pair(page);
  await showList(page);
  const count = page.locator('p.count').first();
  const total = async (): Promise<number> => {
    const m = /(\d+) of (\d+)/.exec((await count.textContent()) ?? '');
    if (!m) throw new Error('no count');
    return Number(m[1]);
  };
  const all = await total();

  await page.getByText('More filters', { exact: false }).first().click();
  // Priority: the values the tasks have, with how many.
  await page.getByRole('button', { name: 'Priority', exact: true }).click();
  const group = page.getByRole('group', { name: 'Priority' });
  await expect(group.getByRole('checkbox').first()).toBeVisible();
  const first = group.getByRole('checkbox').first();
  const label = (await first.evaluate((el) => el.closest('label')?.textContent ?? '')).trim();
  await first.check();
  await page.keyboard.press('Escape');

  // The chip says what is on; the list got shorter (or stayed when every task has it).
  const chips = page.getByRole('list', { name: 'Filters that are on' });
  await expect(chips).toContainText('Priority');
  const narrowed = await total();
  // The option said how many tasks have it: that many are left.
  const said = Number(/\((\d+)\)/.exec(label)?.[1]);
  expect(said).toBeGreaterThan(0);
  expect(narrowed).toBe(said);
  expect(narrowed).toBeLessThan(all);
  await expectAccessible(page, 'the list with more filters on');

  // A second field combines with it; taking its chip off leaves the first.
  const alpha = page.locator('button.row').filter({ has: page.locator('.id', { hasText: /^lib\.nvim\/alpha$/ }) });
  await page.getByRole('combobox', { name: 'Changed' }).selectOption('7');
  await expect(chips).toContainText('Changed');
  // The tasks of the fixture were changed on 2026-01-01: not within 7 days, but more than 90 days ago.
  await expect(alpha).toHaveCount(0);
  await page.getByRole('combobox', { name: 'Changed' }).selectOption('older');
  await expect(alpha).toHaveCount(1);
  // Taking a chip off keeps the focus in the row of chips (here on the next control), not on the page.
  const off = page.getByRole('button', { name: /^Switch off: Changed/ });
  await off.focus();
  await off.click();
  await expect(chips).not.toContainText('Changed');
  expect(await total()).toBe(narrowed);
  await expect(page.locator('.active :focus')).toHaveCount(1);

  // Reset takes every chip away and the whole list is back.
  await page.getByRole('button', { name: 'Clear all filters' }).click();
  await expect(chips).toHaveCount(0);
  expect(await total()).toBe(all);
  expect(await violations(page)).toEqual([]);
});

test('explanations: the popup stays while the pointer crosses to it, follows from chip to chip, and survives the scroll of a focused element', async ({
  page,
}) => {
  await pair(page);
  await chooseView(page, 'View', 'Plan');
  const tip = page.locator('#hint-tip');
  const chips = page.locator('.chips .chip');

  // The pointer goes from the chip to its popup in small steps, over the elements in between: it stays.
  await chips.nth(0).hover();
  await expect(tip).toBeVisible();
  const box = await tip.boundingBox();
  if (!box) throw new Error('popup not drawn');
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 30 });
  await page.waitForTimeout(500);
  await expect(tip).toBeVisible();

  // From one chip to the next one over the gap: the next chip gets its popup (a pending show is not lost).
  await chips.nth(0).hover();
  await expect(tip).toContainText('No open blocker');
  const next = await chips.nth(1).boundingBox();
  if (!next) throw new Error('chip not drawn');
  await page.mouse.move(next.x + next.width / 2, next.y + next.height / 2, { steps: 30 });
  await expect(tip).toContainText('Waits for a decision');

  // An element below the fold: the browser scrolls it into view when it gets the focus, and the popup follows.
  await page.setViewportSize({ width: 1000, height: 300 });
  await page.keyboard.press('Escape');
  const info = page.locator('.info').last();
  await page.evaluate(() => window.scrollTo(0, 0));
  await expect(info).not.toBeInViewport();
  await info.focus();
  await expect(tip).toBeVisible();
  await expect(tip).toBeInViewport();
});

test('explanations: every info button has a name of its own, and its text is not read twice', async ({ page }) => {
  await pair(page);
  await chooseView(page, 'View', 'Plan');
  await expect(page.getByRole('button', { name: 'Explanation: Counters' })).toHaveCount(1);
  await expect(page.getByRole('button', { name: 'Explanation: Estimate' })).toHaveCount(1);
  const info = page.getByRole('button', { name: 'Explanation: Counters' });
  await info.focus();
  // The button already points at its own copy of the text: the popup adds no second pointer to the same words.
  const described = (await info.getAttribute('aria-describedby')) ?? '';
  expect(described.split(/\s+/).filter(Boolean)).toHaveLength(1);
  expect(described).not.toContain('hint-tip');
});

test('the plan header: the label belongs to the choice, the button comes after it and stays inside the window', async ({
  page,
}) => {
  await pair(page);
  await chooseView(page, 'View', 'Plan');
  const label = page.locator('.plan-select > span');
  const select = page.locator('.plan-select select');
  const button = page.getByRole('button', { name: 'Create a plan' });
  await expect(select).toBeVisible();
  await expect(button).toBeVisible();

  const box = async (l: Locator): Promise<{ x: number; y: number; width: number; height: number }> => {
    const b = await l.boundingBox();
    if (!b) throw new Error('not drawn');
    return b;
  };
  for (const width of [1280, 360]) {
    await page.setViewportSize({ width, height: 800 });
    const [l, c, b] = [await box(label), await box(select), await box(button)];
    // The label is in the line of the choice (its middle lies between the top and the bottom of it), before it.
    expect(l.y + l.height / 2).toBeGreaterThan(c.y);
    expect(l.y + l.height / 2).toBeLessThan(c.y + c.height);
    expect(l.x).toBeLessThan(c.x);
    // The button is not between the label and the choice: it is after the choice (right of it, or in the line below).
    expect(b.y >= c.y + c.height - 1 || b.x >= c.x + c.width - 1).toBe(true);
    // Nothing leaves the window.
    expect(c.x + c.width).toBeLessThanOrEqual(width + 1);
    expect(b.x + b.width).toBeLessThanOrEqual(width + 1);
  }
});

test('the plan wizard names the plan with a dry run, refuses what the engine refuses and makes the file', async ({
  page,
}) => {
  await watchViolations(page);
  await pair(page);
  await showList(page);

  const dialog = page.getByRole('dialog', { name: 'Create a plan' });
  const open = async (): Promise<void> => {
    await page.getByRole('menuitem', { name: 'Project', exact: true }).click();
    await page.getByRole('menuitem', { name: 'Create a plan' }).click();
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
  await dialog.getByLabel('Status of the plan').selectOption('doing');
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
  await expect(page.getByRole('alert').getByText(/end of its priority group/)).toBeVisible();
  expect(writes).toBe(0);
  await drag(page, open.locator('.card', { hasText: 'Stage e2e a' }), open.locator('.card', { hasText: 'Stage e2e b' }), 'lower');
  await expect(page.getByRole('alert').getByText(/holds inside one priority/)).toBeVisible();
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
  const dialog = page.getByRole('dialog', { name: 'Create a plan' });
  await page.getByRole('menuitem', { name: 'Project', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Create a plan' }).click();
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
  await expectAccessible(page, 'the blocker dialog');
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
    await expect(page.getByRole('alert').getByText('At most 100 tasks in one batch.')).toBeVisible();
    await expect(page.locator('.rows .line input.mark:checked')).toHaveCount(100);

    // The 101st box is refused: it is not left checked on the screen, and the count stays.
    const last = page.locator('.rows .line').last().locator('input.mark');
    await page.getByRole('alert').getByRole('button', { name: 'Close' }).click();
    await last.scrollIntoViewIfNeeded();
    await last.click();
    await expect(page.getByRole('alert').getByText('At most 100 tasks in one batch.')).toBeVisible();
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
  await expectAccessible(page, 'the bulk bar');

  // A tag the engine would refuse is told and nothing is sent.
  let writes = 0;
  await page.route('**/api/tasks/ops', async (route) => {
    writes += 1;
    await route.continue();
  });
  await bar.getByPlaceholder('Add tags').fill('bad,tag, a#b');
  await bar.getByRole('button', { name: 'Apply to the marked' }).click();
  await expect(page.getByRole('alert').getByText(/a#b/)).toBeVisible();
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

test('the command palette: Ctrl+K, an action by a few letters, a task by its words, a change of the selected task, what was chosen comes first', async ({
  page,
}) => {
  await watchViolations(page);
  await pair(page);
  await showList(page);
  for (const n of [1, 2]) await capture(page, `Palette e2e ${n}`);
  const palette = page.getByRole('dialog', { name: 'Command palette' });
  const box = palette.getByRole('combobox');

  // Opens with Ctrl+K, has no violation, closes with Escape.
  await page.keyboard.press('Control+k');
  await expect(palette).toBeVisible();
  await expect(box).toBeFocused();
  await expectAccessible(page, 'the command palette');
  expect(await violations(page)).toEqual([]);
  await page.keyboard.press('Escape');
  await expect(palette).toBeHidden();

  // Opened again at once, without waiting for it to be gone: the end of the one before must not close the new one.
  for (let i = 0; i < 5; i++) {
    await page.keyboard.press('Control+k');
    await page.keyboard.press('Escape');
    await page.keyboard.press('Control+k');
    await expect(palette).toBeVisible();
    await page.waitForTimeout(100);
    await expect(palette).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(palette).toBeHidden();
  }

  // An action by letters in order: the board.
  await page.keyboard.press('Control+k');
  await box.fill('gbo');
  await expect(palette.getByRole('option').first()).toContainText('Go to Board');
  await page.keyboard.press('Enter');
  await expect(palette).toBeHidden();
  await expect(page.getByRole('group', { name: 'Board' })).toBeVisible();

  // A task by the words of its title: it is selected in the list.
  await page.keyboard.press('Control+k');
  await box.fill('palette e2e 2');
  await expect(palette.getByRole('option').first()).toContainText('Palette e2e 2');
  await page.keyboard.press('Enter');
  await expect(page.locator('aside.detail')).toContainText('Palette e2e 2');
  await expect(page.getByRole('searchbox', { name: /search/i }).first()).toBeVisible();

  // An action on the selected task: its status, written through the engine.
  await page.keyboard.press('Control+k');
  await box.fill('status doing');
  await expect(palette.getByRole('option').first()).toContainText('Selected task: status doing');
  await page.keyboard.press('Enter');
  const file = join(state().vault, 'lib.nvim', 'ROADMAP', 'tasks', 'palette-e2e-2.md');
  await expect.poll(() => readFileSync(file, 'utf8')).toMatch(/^status: doing$/m);

  // What was chosen comes first: the task is offered with an empty box, and the action that was used leads (the
  // status the task has now is not offered again).
  await page.keyboard.press('Control+k');
  await expect(palette.getByRole('option', { name: /Palette e2e 2/ })).toBeVisible();
  await expect(palette.getByRole('option').first()).toContainText('Go to Board');
  await expect(palette.getByRole('option', { name: /status doing/ })).toHaveCount(0);
  // Words that match nothing say so.
  await box.fill('qqqqzzzz');
  await expect(palette.getByText('Nothing matches')).toBeVisible();
  await page.keyboard.press('Escape');

  // Ctrl+K works from the menu, too, and the page is quiet.
  await page.getByRole('menuitem', { name: 'Project' }).click();
  await page.getByRole('menuitem', { name: 'Command palette ...' }).click();
  await expect(palette).toBeVisible();
  await page.keyboard.press('Escape');
  expect(await violations(page)).toEqual([]);
  expect(consoleProblems.get(page)).toEqual([]);
});

test('the conflict center keeps a refused change, shows wanted and now, and tries it again on the version that is there', async ({
  page,
}) => {
  await watchViolations(page);
  await pair(page);
  await showList(page);
  await capture(page, 'Conflict e2e 1');
  await page.getByRole('searchbox', { name: /search/i }).first().fill('Conflict e2e');
  await expect(page.locator('.rows .line')).toHaveCount(1);
  await page.locator('button.row', { hasText: 'Conflict e2e 1' }).click();
  const detail = page.locator('aside.detail');
  await expect(detail).toContainText('Conflict e2e 1');
  const file = join(state().vault, 'lib.nvim', 'ROADMAP', 'tasks', 'conflict-e2e-1.md');

  // The first write goes out with a version that is not the file's: the engine refuses it, as it would after a
  // change by another program. Nothing is written.
  let spoiled = false;
  await page.route('**/api/tasks/ops', async (route) => {
    const body = route.request().postData() ?? '';
    if (!spoiled && body.includes('"patch"')) {
      spoiled = true;
      await route.continue({ postData: body.replace(/"if_match":"[^"]*"/, '"if_match":"sha256:0000000000000000"') });
      return;
    }
    await route.continue();
  });
  await detail.getByLabel('Status').selectOption('parked');
  const button = page.getByRole('button', { name: /Refused changes: 1/ });
  await expect(button).toBeVisible();
  expect(readFileSync(file, 'utf8')).not.toMatch(/^status: parked$/m);

  // The center says what was wanted and what is there now.
  await button.click();
  const center = page.getByRole('dialog', { name: /Refused changes/ });
  await expect(center).toBeVisible();
  await expect(center).toContainText('Conflict e2e 1');
  const row = center.getByRole('row', { name: /Status/ });
  await expect(row).toContainText('parked');
  await expect(row).toContainText('open');
  await expectAccessible(page, 'the conflict center');
  expect(await violations(page)).toEqual([]);

  // Try again: it is written on the version that is there, and the list is empty.
  await center.getByRole('button', { name: 'Try again' }).click();
  await expect.poll(() => readFileSync(file, 'utf8')).toMatch(/^status: parked$/m);
  await expect(center).toBeHidden();
  await expect(page.getByRole('button', { name: /Refused changes/ })).toHaveCount(0);

  // A second refusal, let go of: nothing is written and the button is gone.
  spoiled = false;
  await detail.getByLabel('Status').selectOption('doing');
  await expect(page.getByRole('button', { name: /Refused changes: 1/ })).toBeVisible();
  await page.getByRole('button', { name: /Refused changes: 1/ }).click();
  await center.getByRole('button', { name: 'Let go' }).click();
  await expect(center).toBeHidden();
  await expect(page.getByRole('button', { name: /Refused changes/ })).toHaveCount(0);
  expect(readFileSync(file, 'utf8')).toMatch(/^status: parked$/m);

  expect(await violations(page)).toEqual([]);
  expect(consoleProblems.get(page)).toEqual([]);
});

test('a step is ticked in the detail, the file changes when the engine wrote it, and undo takes it back', async ({ page }) => {
  await watchViolations(page);
  await pair(page);
  await showList(page);
  await open(page, 'lib.nvim/alpha');
  const detail = page.locator('aside.detail');
  const file = join(state().vault, 'lib.nvim', 'ROADMAP', 'tasks', 'alpha.md');

  // Steps 1 and 2 have a box; step 3 is dropped and has none.
  await expect(detail.getByRole('checkbox')).toHaveCount(2);
  const box = detail.getByRole('checkbox', { name: /2\. second/ });
  await expect(box).not.toBeChecked();
  expect(readFileSync(file, 'utf8')).toContain('- [ ] 2. second');

  await box.click();
  await expect(page.getByRole('status').getByText('Saved.')).toBeVisible();
  await expect(box).toBeChecked();
  expect(readFileSync(file, 'utf8')).toContain('- [x] 2. second');
  await expectAccessible(page, 'the detail with its steps and the note box');

  await page.getByRole('status').getByRole('button', { name: 'Undo' }).click();
  await expect(box).not.toBeChecked();
  expect(readFileSync(file, 'utf8')).toContain('- [ ] 2. second');
  expect(await violations(page)).toEqual([]);
  expect(consoleProblems.get(page)).toEqual([]);
});

test('a note is added to a task, dated, below its notes; the box empties only when it was written', async ({ page }) => {
  await watchViolations(page);
  await pair(page);
  await showList(page);

  await page.keyboard.press('c');
  const capture = page.getByRole('dialog', { name: 'New task' });
  await capture.getByLabel('Title').fill('Task that gets a note');
  await capture.locator('select').first().selectOption('lib.nvim');
  await capture.getByRole('button', { name: 'Create' }).click();
  await expect(page.getByRole('status').getByText('Saved.')).toBeVisible();
  const id = (await page.locator('aside.detail .id').innerText()).trim();
  const detail = page.locator('aside.detail');
  const file = join(state().vault, 'lib.nvim', 'ROADMAP', 'tasks', `${id.split('/')[1]}.md`);

  const box = detail.getByRole('textbox', { name: /Add a note/ });
  const add = detail.getByRole('button', { name: 'Add note' });
  await expect(add).toBeDisabled();
  await box.fill('looked at it, nothing found');
  await add.click();
  await expect(page.getByRole('status').getByText('Saved.').last()).toBeVisible();
  await expect(box).toHaveValue('');
  // The text of the task is read again and shows the line.
  await expect(detail.locator('.prose, pre.body')).toContainText('looked at it, nothing found');
  expect(readFileSync(file, 'utf8')).toMatch(/\n- \d{4}-\d{2}-\d{2}: looked at it, nothing found\n/);
  // A line cannot be taken back from the page: the toast offers no undo for it.
  await expect(page.getByRole('status').getByRole('button', { name: 'Undo' })).toHaveCount(0);
  expect(await violations(page)).toEqual([]);
  expect(consoleProblems.get(page)).toEqual([]);
});

test('a task is discarded with a reason: it is parked and the reason is noted, not counted as done', async ({ page }) => {
  await watchViolations(page);
  await pair(page);
  await showList(page);

  await page.keyboard.press('c');
  const capture = page.getByRole('dialog', { name: 'New task' });
  await capture.getByLabel('Title').fill('Task that is discarded');
  await capture.locator('select').first().selectOption('lib.nvim');
  await capture.getByRole('button', { name: 'Create' }).click();
  await expect(page.getByRole('status').getByText('Saved.')).toBeVisible();
  const id = (await page.locator('aside.detail .id').innerText()).trim();
  const detail = page.locator('aside.detail');
  const file = join(state().vault, 'lib.nvim', 'ROADMAP', 'tasks', `${id.split('/')[1]}.md`);

  const box = detail.getByRole('textbox', { name: /Discard this task/ });
  const button = detail.getByRole('button', { name: 'Discard', exact: true });
  await expect(button).toBeDisabled();
  await box.fill('superseded by the other plan');
  await button.click();
  await expect(page.getByRole('status').getByText('Saved.').last()).toBeVisible();
  await expect(detail.locator('.prose, pre.body')).toContainText('Discarded: superseded by the other plan');
  const text = readFileSync(file, 'utf8');
  expect(text).toMatch(/\nstatus: parked\n/);
  expect(text).toMatch(/\n- \d{4}-\d{2}-\d{2}: Discarded: superseded by the other plan\n/);
  // A parked task offers no second discard.
  await expect(box).toHaveCount(0);
  expect(await violations(page)).toEqual([]);
  expect(consoleProblems.get(page)).toEqual([]);
});

test('a task is moved to another area: the id changes, the file follows, the selection too, and undo brings it back', async ({ page }) => {
  await watchViolations(page);
  await pair(page);
  await showList(page);

  await page.keyboard.press('c');
  const capture = page.getByRole('dialog', { name: 'New task' });
  await capture.getByLabel('Title').fill('Task that changes its area');
  await capture.locator('select').first().selectOption('lib.nvim');
  await capture.getByRole('button', { name: 'Create' }).click();
  await expect(page.getByRole('status').getByText('Saved.')).toBeVisible();
  const id = (await page.locator('aside.detail .id').innerText()).trim();
  const slug = id.split('/')[1];
  const detail = page.locator('aside.detail');
  const from = join(state().vault, 'lib.nvim', 'ROADMAP', 'tasks', `${slug}.md`);
  const to = join(state().vault, 'cascade.nvim', 'ROADMAP', 'tasks', `${slug}.md`);

  const target = detail.getByRole('combobox', { name: 'Move to another area' });
  await target.selectOption('cascade.nvim');
  await detail.getByRole('button', { name: 'Check the move' }).click();
  await expect(detail.getByRole('button', { name: `Move (becomes cascade.nvim/${slug})` })).toBeVisible();
  expect(existsSync(from)).toBe(true);
  expect(existsSync(to)).toBe(false);
  await detail.getByRole('button', { name: `Move (becomes cascade.nvim/${slug})` }).click();
  await expect(page.getByRole('status').getByText('Saved.').last()).toBeVisible();
  await expect(page.locator('aside.detail .id')).toHaveText(`cascade.nvim/${slug}`);
  expect(existsSync(from)).toBe(false);
  expect(existsSync(to)).toBe(true);

  await page.getByRole('status').getByRole('button', { name: 'Undo' }).click();
  await expect(page.locator('aside.detail .id')).toHaveText(`lib.nvim/${slug}`);
  expect(existsSync(from)).toBe(true);
  expect(existsSync(to)).toBe(false);
  expect(await violations(page)).toEqual([]);
  expect(consoleProblems.get(page)).toEqual([]);
});

test('the title, the summary and the relations are changed in the detail, and the engine refuses what is wrong', async ({ page }) => {
  await watchViolations(page);
  await pair(page);
  await showList(page);

  await page.keyboard.press('c');
  const capture = page.getByRole('dialog', { name: 'New task' });
  await capture.getByLabel('Title').fill('Task to rename');
  await capture.locator('select').first().selectOption('lib.nvim');
  await capture.getByRole('button', { name: 'Create' }).click();
  await expect(page.getByRole('status').getByText('Saved.')).toBeVisible();
  const id = (await page.locator('aside.detail .id').innerText()).trim();
  const detail = page.locator('aside.detail');
  const file = join(state().vault, 'lib.nvim', 'ROADMAP', 'tasks', `${id.split('/')[1]}.md`);

  await detail.getByLabel('Title', { exact: true }).fill('Task that was renamed');
  await detail.getByLabel('Title', { exact: true }).press('Enter');
  await expect(page.getByRole('status').getByText('Saved.').last()).toBeVisible();
  await expect(detail.getByRole('heading', { level: 2 })).toHaveText('Task that was renamed');
  expect(readFileSync(file, 'utf8')).toContain('title: Task that was renamed');

  await detail.getByLabel('Summary').fill('One line about it');
  await detail.getByLabel('Summary').press('Enter');
  await expect(detail.locator('p', { hasText: 'One line about it' })).toBeVisible();

  // The title may not be empty: said on the page, nothing is sent.
  await detail.getByLabel('Title', { exact: true }).fill('   ');
  await detail.getByLabel('Title', { exact: true }).press('Enter');
  await expect(page.getByRole('alert').getByText('The title may not be empty.')).toBeVisible();
  await expect(detail.getByLabel('Title', { exact: true })).toHaveValue('Task that was renamed');

  // A relation to a task that is not there is refused by the engine in its words, and the file stays as it was.
  const before = readFileSync(file, 'utf8');
  await detail.getByLabel('After').fill('lib.nvim/does-not-exist');
  await detail.getByLabel('After').press('Enter');
  await expect(page.getByRole('alert').getByText(/Not accepted/)).toBeVisible();
  expect(readFileSync(file, 'utf8')).toBe(before);

  // A real one is written.
  await detail.getByLabel('After').fill('lib.nvim/alpha');
  await detail.getByLabel('After').press('Enter');
  await expect(page.getByRole('status').getByText('Saved.').last()).toBeVisible();
  expect(readFileSync(file, 'utf8')).toMatch(/after: .*lib\.nvim\/alpha/);
  await expectAccessible(page, 'the detail with the title and relation fields');
  expect(await violations(page)).toEqual([]);
  expect(consoleProblems.get(page)).toEqual([]);
});

test('the vaults menu lists the vault that is read, and the dialog adds, shows and forgets one', async ({ page }) => {
  await watchViolations(page);
  await pair(page);
  await showList(page);

  // The vault that is read is ticked in the menu.
  await page.getByRole('menuitem', { name: 'Vaults', exact: true }).click();
  await expect(page.getByRole('menuitemradio', { checked: true })).toHaveCount(1);
  await expect(page.getByRole('menuitemradio').first()).toHaveAttribute('aria-checked', 'true');
  await page.getByRole('menuitem', { name: 'Manage vaults ...' }).click();

  const dialog = page.getByRole('dialog', { name: 'Vaults' });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText('read now')).toBeVisible();
  await expectAccessible(page, 'the vaults dialog');

  // A folder that is not there is refused in the hub's words, and nothing is added.
  await dialog.getByLabel(/^Name/).fill('elsewhere');
  await dialog.getByLabel(/^Folder/).fill(join(state().vault, 'no-such-folder-here'));
  await dialog.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(page.getByRole('alert').getByText(/there is no such folder/)).toBeVisible();
  await expect(dialog.getByText('elsewhere')).toHaveCount(0);

  // A real folder is added (the same one under another name: the dialog only lists it).
  await dialog.getByLabel(/^Folder/).fill(state().vault);
  await dialog.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(page.getByRole('status').getByText('Vault added.')).toBeVisible();
  await expect(dialog.getByText('elsewhere')).toBeVisible();

  // Forgotten again; the files stay.
  await dialog.getByRole('button', { name: 'Forget: elsewhere' }).click();
  await expect(page.getByRole('status').getByText(/Vault forgotten/)).toBeVisible();
  await expect(dialog.getByText('elsewhere')).toHaveCount(0);
  expect(readFileSync(join(state().vault, 'lib.nvim', 'ROADMAP', 'tasks', 'alpha.md'), 'utf8')).toContain('title: Alpha');
  await dialog.getByRole('button', { name: 'Close' }).click();
  await expect(dialog).toHaveCount(0);
  expect(await violations(page)).toEqual([]);
  // The refused folder is a 400 the browser logs by itself; nothing else may be there.
  expect((consoleProblems.get(page) ?? []).filter((m) => !m.includes('status of 400'))).toEqual([]);
});

test('another vault is chosen: the page loads again and shows its tasks, and the first one can be chosen back', async ({ page }) => {
  await watchViolations(page);
  await pair(page);
  await showList(page);
  const second = join(state().vault, '..', 'second-vault');
  rmSync(second, { recursive: true, force: true });
  const tasks = join(second, 'solo.nvim', 'ROADMAP', 'tasks');
  mkdirSync(tasks, { recursive: true });
  writeFileSync(
    join(tasks, 'solo-task.md'),
    ['---', 'title: Solo task of the second vault', 'status: open', 'kind: task', 'prio: 2', 'created: 2026-01-01', 'updated: 2026-01-01', '---', '', 'Solo.', ''].join('\n'),
  );

  await page.getByRole('menuitem', { name: 'Vaults', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Manage vaults ...' }).click();
  const dialog = page.getByRole('dialog', { name: 'Vaults' });
  await dialog.getByLabel(/^Name/).fill('second');
  await dialog.getByLabel(/^Folder/).fill(second);
  await dialog.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(page.getByRole('status').getByText('Vault added.')).toBeVisible();

  // Chosen: the page loads again; only the tasks of the second vault are there.
  await dialog.getByRole('button', { name: 'Read this one' }).click();
  await expect(page.getByRole('menubar')).toBeVisible();
  await showList(page);
  await expect(page.locator('button.row', { hasText: 'solo.nvim/solo-task' })).toBeVisible();
  await expect(page.locator('button.row', { hasText: 'lib.nvim/alpha' })).toHaveCount(0);
  await page.getByRole('menuitem', { name: 'Vaults', exact: true }).click();
  await expect(page.getByRole('menuitemradio', { name: /^second/ })).toHaveAttribute('aria-checked', 'true');

  // And back: the first vault is the one that is read again, with its tasks.
  await page.getByRole('menuitemradio').first().click();
  await expect(page.getByRole('menubar')).toBeVisible();
  await showList(page);
  await expect(page.locator('button.row', { hasText: /lib\.nvim\/alpha(?![-\w])/ })).toBeVisible();
  await expect(page.locator('button.row', { hasText: 'solo.nvim/solo-task' })).toHaveCount(0);

  // A vault that was chosen is not forgotten while it is read; the other goes.
  await page.getByRole('menuitem', { name: 'Vaults', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Manage vaults ...' }).click();
  await dialog.getByRole('button', { name: 'Forget: second' }).click();
  await expect(page.getByRole('status').getByText(/Vault forgotten/)).toBeVisible();
  await dialog.getByRole('button', { name: 'Close' }).click();
  expect(await violations(page)).toEqual([]);
});

test('a number of the overview opens its tasks, in views that can be switched, with the key v and the mouse', async ({ page }) => {
  await watchViolations(page);
  await pair(page);
  await chooseView(page, 'View', 'Today');
  const tile = page.locator('button.tile[data-count="blocked"]');
  await expect(tile).toBeVisible();
  const number = Number(await tile.locator('.num').innerText());
  expect(number).toBeGreaterThan(0);

  // A click opens the tasks; the count in the heading is the number on the tile.
  await tile.click();
  await expect(tile).toHaveAttribute('aria-expanded', 'true');
  const panel = page.getByRole('region', { name: 'blocked' });
  await expect(panel.getByRole('heading', { level: 2 })).toHaveText(`blocked · ${number}`);
  await expect(panel.locator('li')).toHaveCount(number);
  await expectAccessible(page, 'the tasks behind a number');

  // The views are switched with the mouse ...
  await panel.getByRole('radio', { name: 'By area' }).check();
  const counts = await panel.locator('summary .muted').allInnerTexts();
  expect(counts.length).toBeGreaterThan(0);
  expect(counts.map((c) => Number(c.slice(1, -1))).reduce((a, b) => a + b, 0)).toBe(number);

  // ... and with the key v on the number itself (blocked can also be cut up by its blocker).
  await panel.getByRole('radio', { name: 'List' }).check();
  await tile.focus();
  await page.keyboard.press('v');
  await expect(panel.getByRole('radio', { name: 'By blocker' })).toBeChecked();
  await page.keyboard.press('v');
  await expect(panel.getByRole('radio', { name: 'By priority' })).toBeChecked();

  // The choice is kept for this number only.
  await expect(page.locator('button.tile[data-count="doing"]')).toHaveAttribute('aria-expanded', 'false');
  await page.reload();
  await expect(page.getByRole('menubar')).toBeVisible();
  await page.locator('button.tile[data-count="blocked"]').click();
  await expect(page.getByRole('region', { name: 'blocked' }).getByRole('radio', { name: 'By priority' })).toBeChecked();

  // Escape closes the tasks and gives the focus back to the number.
  await page.getByRole('region', { name: 'blocked' }).getByRole('radio', { name: 'By priority' }).focus();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('region', { name: 'blocked' })).toHaveCount(0);
  await expect(page.locator('button.tile[data-count="blocked"]')).toBeFocused();

  // The key on a number that is closed opens it in the view it has; it does not skip one.
  await page.locator('button.tile[data-count="doing"]').focus();
  await page.keyboard.press('v');
  const doing = page.getByRole('region', { name: 'doing' });
  await expect(doing.getByRole('radio', { name: 'List' })).toBeChecked();

  // A task of the list is opened in the list, selected.
  const first = doing.locator('li').first();
  const id = (await first.locator('code').innerText()).trim();
  await first.getByRole('button').click();
  await expect(page.locator('aside.detail .id')).toHaveText(id);
  expect(await violations(page)).toEqual([]);
  expect(consoleProblems.get(page)).toEqual([]);
});

test('a task is made with a text: the file holds it as written, and the detail shows it', async ({ page }) => {
  await watchViolations(page);
  await pair(page);
  await showList(page);

  await page.keyboard.press('c');
  const capture = page.getByRole('dialog', { name: 'New task' });
  await capture.getByLabel('Title').fill('Task from a note');
  await capture.locator('select').first().selectOption('lib.nvim');
  await capture.getByLabel(/^Text/).fill('The first line of the note.\n\n- one\n- two');
  await expectAccessible(page, 'the capture dialog with a text field');
  await capture.getByRole('button', { name: 'Create' }).click();
  await expect(page.getByRole('status').getByText('Saved.')).toBeVisible();
  const id = (await page.locator('aside.detail .id').innerText()).trim();
  const file = join(state().vault, 'lib.nvim', 'ROADMAP', 'tasks', `${id.split('/')[1]}.md`);
  const text = readFileSync(file, 'utf8');
  expect(text).toContain('\nThe first line of the note.\n\n- one\n- two\n');
  expect(text).not.toContain('## Kontext');
  await expect(page.locator('aside.detail .prose, aside.detail pre.body')).toContainText('The first line of the note.');
  await expect(page.locator('aside.detail').getByText('Task from a note').first()).toBeVisible();
  expect(await violations(page)).toEqual([]);
  expect(consoleProblems.get(page)).toEqual([]);
});

test('the text of a task is edited in the detail: written whole, taken back by undo, and a change in between is a conflict that keeps the draft', async ({ page }) => {
  await watchViolations(page);
  await pair(page);
  await showList(page);

  await page.keyboard.press('c');
  const capture = page.getByRole('dialog', { name: 'New task' });
  await capture.getByLabel('Title').fill('Task whose text is edited');
  await capture.locator('select').first().selectOption('lib.nvim');
  await capture.getByLabel(/^Text/).fill('The old text.');
  await capture.getByRole('button', { name: 'Create' }).click();
  await expect(page.getByRole('status').getByText('Saved.')).toBeVisible();
  const id = (await page.locator('aside.detail .id').innerText()).trim();
  const detail = page.locator('aside.detail');
  const file = join(state().vault, 'lib.nvim', 'ROADMAP', 'tasks', `${id.split('/')[1]}.md`);

  await detail.getByRole('button', { name: 'Edit text' }).click();
  const box = detail.getByRole('textbox', { name: /Text of the task/ });
  await expect(box).toHaveValue('The old text.');
  await expectAccessible(page, 'the detail with the text editor');
  await box.fill('The new text.\n\n- with a list');
  await detail.getByRole('button', { name: 'Save text' }).click();
  await expect(page.getByRole('status').getByText('Saved.').last()).toBeVisible();
  await expect(box).toHaveCount(0);
  await expect(detail.locator('.prose, pre.body')).toContainText('The new text.');
  expect(readFileSync(file, 'utf8')).toContain('\nThe new text.\n\n- with a list\n');
  expect(readFileSync(file, 'utf8')).not.toContain('The old text.');

  // The undo brings the old text back.
  await page.getByRole('status').getByRole('button', { name: 'Undo' }).click();
  await expect(detail.locator('.prose, pre.body')).toContainText('The old text.');
  expect(readFileSync(file, 'utf8')).toContain('\nThe old text.\n');

  // The file changes while the draft is open: the save is a conflict, the file keeps the other change, the draft stays.
  await detail.getByRole('button', { name: 'Edit text' }).click();
  await detail.getByRole('textbox', { name: /Text of the task/ }).fill('My draft.');
  // Escape does not throw a draft away that holds typing; the button does.
  await detail.getByRole('textbox', { name: /Text of the task/ }).press('Escape');
  await expect(detail.getByRole('textbox', { name: /Text of the task/ })).toHaveValue('My draft.');
  writeFileSync(file, readFileSync(file, 'utf8').replace('The old text.', 'Changed elsewhere.'));
  await detail.getByRole('button', { name: 'Save text' }).click();
  await expect(page.getByRole('alert').getByText(/Not accepted|changed/i).last()).toBeVisible();
  expect(readFileSync(file, 'utf8')).toContain('Changed elsewhere.');
  await expect(detail.getByRole('textbox', { name: /Text of the task/ })).toHaveValue('My draft.');
  await detail.getByRole('button', { name: 'Cancel' }).click();
  await expect(detail.getByRole('textbox', { name: /Text of the task/ })).toHaveCount(0);
  expect(await violations(page)).toEqual([]);
  expect(consoleProblems.get(page)).toEqual([]);
});

test('a finished task is brought back by the undo of the finish and from the reminder, and the backlog loses its row', async ({ page }) => {
  await watchViolations(page);
  await pair(page);
  await showList(page);

  await capture(page, 'Finished and back again');
  const id = (await page.locator('aside.detail .id').innerText()).trim();
  const slug = id.split('/')[1] ?? '';
  const open = join(state().vault, 'lib.nvim', 'ROADMAP', 'tasks', `${slug}.md`);
  const readme = join(state().vault, 'lib.nvim', 'Backlog', 'README.md');
  expect(existsSync(open)).toBe(true);

  // Finish: the file leaves ROADMAP, the README gets a row.
  await page.locator('aside.detail').getByRole('button', { name: 'Finish ...' }).click();
  const done = page.getByRole('dialog', { name: 'Finish this task?' });
  await done.getByRole('button', { name: 'Finish', exact: true }).click();
  await expect(done).toHaveCount(0);
  await expect(page.locator('button.row', { hasText: id })).toHaveCount(0);
  expect(existsSync(open)).toBe(false);
  expect(readFileSync(readme, 'utf8')).toContain('Finished and back again');

  // The undo of the finish brings it back: open again, the row gone.
  await page.getByRole('status').getByRole('button', { name: 'Undo' }).click();
  await expect(page.getByRole('status').getByText('Undone.')).toBeVisible();
  await expect(page.locator('button.row', { hasText: id })).toBeVisible();
  expect(existsSync(open)).toBe(true);
  expect(readFileSync(open, 'utf8')).toContain('status: open');
  expect(readFileSync(readme, 'utf8')).not.toContain('Finished and back again');

  // Finish again with a reminder: the reminder of a finished task has a button to bring it back.
  await page.locator('button.row', { hasText: id }).click();
  await page.locator('aside.detail').getByRole('button', { name: 'Finish ...' }).click();
  await done.getByLabel('Remind me about the result').selectOption('+0d');
  await done.getByRole('button', { name: 'Finish', exact: true }).click();
  await expect(done).toHaveCount(0);
  await chooseView(page, 'View', 'Today');
  const card = page.getByRole('region', { name: 'To look at again' });
  await card.getByRole('button', { name: `Reopen: ${id}` }).click();
  await expect(page.getByRole('region', { name: 'To look at again' })).toHaveCount(0);
  expect(existsSync(open)).toBe(true);
  expect(readFileSync(open, 'utf8')).not.toContain('remind:');
  await showList(page);
  await expect(page.locator('button.row', { hasText: id })).toBeVisible();
  expect(await violations(page)).toEqual([]);
  expect(consoleProblems.get(page)).toEqual([]);
});

test('a task is opened in Neovim by the hub: the page names the task, the hub the file', async ({ page }) => {
  await watchViolations(page);
  await pair(page);
  await showList(page);
  await open(page, 'lib.nvim/alpha');
  const log = join(state().config, '..', 'editor.log');
  rmSync(log, { force: true });

  await page.locator('aside.detail').getByRole('button', { name: 'Open in Neovim' }).click();
  await expect(page.getByRole('status').getByText('Opened in Neovim.')).toBeVisible();
  await expect.poll(() => (existsSync(log) ? readFileSync(log, 'utf8') : '')).toContain('alpha.md');
  const opened = readFileSync(log, 'utf8').trim().split('\n');
  expect(opened).toHaveLength(1);
  // The file is the one inside the vault (links resolved), and the page never saw its path.
  expect(opened[0]?.replace(/\\/g, '/')).toMatch(/lib\.nvim\/ROADMAP\/tasks\/alpha\.md$/);
  expect(await page.locator('body').innerText()).not.toContain(opened[0] ?? 'x');
  expect(await violations(page)).toEqual([]);
  expect(consoleProblems.get(page)).toEqual([]);
});

test('a note that is being typed survives a change of the vault that arrives meanwhile', async ({ page }) => {
  await pair(page);
  await showList(page);
  await open(page, 'lib.nvim/beta');
  const detail = page.locator('aside.detail');
  const box = detail.getByRole('textbox', { name: /Add a note/ });
  await box.fill('half a thought');

  // Somebody else changes the file: the list is read again and the detail with it.
  const file = join(state().vault, 'lib.nvim', 'ROADMAP', 'tasks', 'beta.md');
  const text = readFileSync(file, 'utf8');
  writeFileSync(file, text.replace(/^title: (.*)$/m, 'title: $1 TOUCHED'));
  await expect(detail.locator('.task-title')).toContainText('TOUCHED', { timeout: 8000 });
  await expect(box).toHaveValue('half a thought');

  // Another task: the draft belongs to the one it was typed for, so it goes.
  await page.locator('button.row', { hasText: 'lib.nvim/gamma' }).click();
  await expect(detail.locator('.id')).toHaveText('lib.nvim/gamma');
  await expect(detail.getByRole('textbox', { name: /Add a note/ })).toHaveValue('');
  writeFileSync(file, text);
});

test('the inbox draws a page of rows, shows more on request and keeps the selected row drawn', async ({ page }) => {
  await watchViolations(page);
  const dir = join(state().vault, 'lib.nvim', 'ROADMAP', 'tasks');
  const files: string[] = [];
  // More unsorted tasks than one page takes, made the way another tool would make them.
  for (let n = 1; n <= 130; n++) {
    const file = join(dir, `inbox-page-e2e-${String(n).padStart(3, '0')}.md`);
    writeFileSync(file, `---\ntitle: Inbox page e2e ${String(n).padStart(3, '0')}\nstatus: open\n---\n`);
    files.push(file);
  }
  try {
    await pair(page);
    await showList(page);
    await page.keyboard.press('g');
    await page.keyboard.press('i');
    const inbox = page.locator('section.inbox');
    await expect(inbox).toBeVisible();
    const more = inbox.getByRole('button', { name: /Show more/ });
    // The count says how many there are; the page draws 100 of them.
    await expect(more).toBeVisible();
    await expect(inbox.locator('.row')).toHaveCount(100);
    await expect(inbox.locator('.count')).toContainText(/to sort/);
    expect(await violations(page)).toEqual([]);

    // The keys walk past the page: the selected row is drawn, and the button counts what is still left.
    for (let n = 0; n < 104; n++) await page.keyboard.press('j');
    await expect(inbox.locator('.row')).toHaveCount(105);
    await expect(inbox.locator('.row[aria-current="true"]')).toHaveCount(1);

    // "Show more" draws another page (or the rest), and the button goes when nothing is left.
    await more.click();
    expect(await inbox.locator('.row').count()).toBeGreaterThan(105);
    await expect(inbox.locator('.row[aria-current="true"]')).toHaveCount(1);
  } finally {
    for (const file of files) rmSync(file, { force: true });
  }
  expect(consoleProblems.get(page)).toEqual([]);
});

test('the findings of the check stay for the tasks that did not change and go only for the one that did', async ({ page }) => {
  await watchViolations(page);
  await pair(page);
  await showList(page);
  // The index is made stale on purpose: other tests regenerate it, and this one must not depend on what they left.
  const indexFile = join(state().vault, 'lib.nvim', 'ROADMAP', 'TASKS.md');
  const indexText = existsSync(indexFile) ? readFileSync(indexFile, 'utf8') : null;
  writeFileSync(indexFile, `${indexText ?? ''}
<!-- edited by hand -->
`);
  try {
    await checkFindingsStay(page);
  } finally {
    if (indexText === null) rmSync(indexFile, { force: true });
    else writeFileSync(indexFile, indexText);
  }
});

async function checkFindingsStay(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Check ...' }).click();
  const dialog = page.getByRole('dialog', { name: 'Check the vault' });
  await dialog.getByRole('button', { name: 'Check now' }).click();
  await expect(dialog.getByRole('status')).toContainText(/Checked at [0-9]/, { timeout: 30_000 });
  // A finding about a file, not a task (the index): it has no version to go by and stands.
  await expect(dialog.locator('ul.findings li', { hasText: 'index-stale' }).first()).toBeVisible();
  await dialog.getByRole('button', { name: 'Close' }).click();
  const flag = (id: string) => page.locator('button.row', { hasText: id }).locator('.tag.bad', { hasText: '⚑' });
  await expect(flag('lib.nvim/beta')).toBeVisible();
  await expect(flag('lib.nvim/broken')).toBeVisible();
  // beta is written by someone else (Neovim, a key of the inbox): only its findings are in question.
  const file = join(state().vault, 'lib.nvim', 'ROADMAP', 'tasks', 'beta.md');
  const text = readFileSync(file, 'utf8');
  writeFileSync(file, text + '\nChanged after the check.\n');
  try {
    await expect(flag('lib.nvim/beta')).toHaveCount(0);
    await expect(flag('lib.nvim/broken')).toBeVisible();
    await page.getByRole('button', { name: 'Check ...' }).click();
    await expect(dialog.getByRole('status')).toContainText('1 task(s) changed since this check');
    await expect(dialog.locator('ul.findings li.stale', { hasText: 'lib.nvim/beta' })).toBeVisible();
    await expect(dialog.locator('ul.findings li:not(.stale)', { hasText: 'lib.nvim/broken' }).first()).toBeVisible();
    await expect(dialog.locator('ul.findings li', { hasText: 'index-stale' }).first()).toBeVisible();
    await expectAccessible(page, 'check after a change');
  } finally {
    writeFileSync(file, text);
  }
  expect(consoleProblems.get(page)).toEqual([]);
}

test('help: the about dialog names the build and the engine, and the report carries no path', async ({ page }) => {
  await watchViolations(page);
  await pair(page);
  await showList(page);

  await page.getByRole('menuitem', { name: 'Help', exact: true }).click();
  await page.getByRole('menuitem', { name: 'About ...' }).click();
  const dialog = page.getByRole('dialog', { name: 'About tasks-desktop' });
  await expect(dialog).toBeVisible();
  // The version of the hub and the commit of the real engine, as the hub tells them.
  await expect(dialog.getByText(/^\d+\.\d+\.\d+$/)).toBeVisible();
  await expect(dialog.getByText('Engine (tasks.nvim)')).toBeVisible();
  const report = await dialog.getByLabel('Report', { exact: true }).inputValue();
  expect(report).toMatch(/^tasks-desktop \d+\.\d+\.\d+/);
  expect(report).toMatch(/Engine: tasks\.nvim \S+, commit [0-9a-f]{7,40}, Neovim \d/);
  expect(report).toMatch(/Tested with: tasks\.nvim [0-9a-f]{40}, lib\.nvim [0-9a-f]{40}/);
  expect(report).toContain('What happened:');
  // Nothing of this machine: not the vault, not the config folder, not the temp folder, not the user's name.
  for (const secret of [state().vault, state().config, tmpdir(), process.env['USERNAME'] ?? process.env['USER'] ?? '\u0000']) {
    expect(report).not.toContain(secret.replace(/\\/g, '/'));
    expect(report).not.toContain(secret);
  }
  // The form is a link the person follows: a new issue, the report in its body, nothing sent by the page.
  const href = await dialog.getByRole('link', { name: 'Open the form' }).getAttribute('href');
  expect(href).not.toBeNull();
  const url = new URL(href ?? '');
  expect(url.origin + url.pathname).toBe('https://github.com/StefanBartl/tasks-desktop/issues/new');
  expect(url.searchParams.get('body')).toBe(report);
  await expectAccessible(page, 'the about dialog');

  // Escape closes it; "Report a problem" opens it again with the keyboard on the link to the form.
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await page.getByRole('menuitem', { name: 'Help', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Report a problem ...' }).click();
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('link', { name: 'Open the form' })).toBeFocused();
  await dialog.getByRole('button', { name: 'Close' }).click();
  await expect(dialog).toHaveCount(0);
  expect(await violations(page)).toEqual([]);
  expect(consoleProblems.get(page)).toEqual([]);
});
