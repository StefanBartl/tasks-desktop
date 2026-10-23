import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Locator, type Page, type Route } from '@playwright/test';
import { expectAccessible, violations, watchViolations } from './a11y';
import { STATE } from './global';
import { pairingLink, removeFile } from './hub';

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
 * answer). A key or a drag while a write is on its way is not sent (it is refused with a toast), and the board or the inbox may already show the
 * change before the answer is there (the hub's event of the changed file can come first; CI, 5da9dd1 and a098dff).
 * Without a card and without the title there is nothing that could tell, and the wait would pass at once: that is red.
 */
async function settled(page: Page): Promise<void> {
  const cards = page.locator('.card');
  const title = detailTitle(page);
  // The tab of the views says it on the open view (`aria-busy` while a write is on its way).
  const view = page.locator('section.open[aria-busy]');
  await expect(cards.or(title).or(view).first(), 'settled() needs a card, the title of the detail or an open view').toBeAttached();
  await expect(page.locator('.card:not([draggable="true"])')).toHaveCount(0, { timeout: WRITE_BUDGET });
  await expect(title.and(page.locator(':disabled'))).toHaveCount(0, { timeout: WRITE_BUDGET });
  await expect(page.locator('section.open[aria-busy="true"]')).toHaveCount(0, { timeout: WRITE_BUDGET });
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

/**
 * `g v` opens the tab of the views; pressed again until it is there (right after the pairing the page may not take
 * the keys yet, as `capture` knows).
 */
async function openViewsByKey(page: Page, ready: Locator): Promise<void> {
  await expect(async () => {
    if (!(await ready.isVisible())) {
      await page.locator('main').focus();
      await page.keyboard.press('g');
      await page.keyboard.press('v');
    }
    await expect(ready).toBeVisible({ timeout: 1000 });
  }).toPass({ timeout: 10000 });
}

/** The file of the saved view titled `title` in `area` of the test vault, or null when there is none. */
function viewFile(area: string, title: string): string | null {
  const dir = join(state().vault, area, 'ROADMAP', 'views');
  if (!existsSync(dir)) return null;
  for (const name of readdirSync(dir)) {
    const text = readFileSync(join(dir, name), 'utf8');
    if (text.includes(`title: ${title}\n`) || text.includes(`title: "${title}"`)) return join(dir, name);
  }
  return null;
}

test('a saved view is made in the tab of the views, kept as a file of the vault, there after a reload; renamed, deleted and back with undo', async ({ page }) => {
  await pair(page);
  // `g v` opens the tab (the keys of the page, not a field).
  const make = page.getByRole('button', { name: 'New view' });
  await openViewsByKey(page, make);
  await expect(make).toBeEnabled();
  await make.click();
  const form = page.getByRole('form', { name: 'New view' });
  await form.getByLabel('Name').fill('E2e view v001');
  await form.getByLabel('Kept in area').selectOption('lib.nvim');
  await form.getByLabel('Group by').selectOption({ label: 'Priority' });
  await write(page, () => form.getByRole('button', { name: 'Create view' }).click());
  // The file is the engine's: in the area chosen, grouped by the field chosen.
  await expect.poll(() => viewFile('lib.nvim', 'E2e view v001'), { timeout: WRITE_BUDGET }).not.toBeNull();
  const file = viewFile('lib.nvim', 'E2e view v001')!;
  expect(readFileSync(file, 'utf8')).toContain('group_by: prio');
  const open = page.getByRole('region', { name: 'E2e view v001' });
  // The groups are the engine's values of the field: the tasks of the fixture have priority 2.
  await expect(open.locator('section[data-group="2"]')).toBeVisible();
  await expectAccessible(page, 'the tab of the views');

  // Read again from the vault after a reload: the page opens on the tab and the view.
  await page.reload();
  await expect(page.getByRole('combobox', { name: 'Saved view', exact: true })).toHaveValue(/^lib\.nvim\//);
  await expect(page.getByRole('region', { name: 'E2e view v001' })).toBeVisible();

  // A name being typed is kept when the views are read again (here after another change of the view).
  const region = page.getByRole('region', { name: 'E2e view v001' });
  await region.getByLabel('Name').fill('E2e view v001 typed');
  const shown = nextAnswer(page);
  await region.getByLabel('Show as').selectOption({ label: 'List' });
  await shown;
  await expect.poll(() => readFileSync(file, 'utf8'), { timeout: WRITE_BUDGET }).toContain('display: list');
  await expect(region.getByRole('button', { name: /^P2/ })).toBeVisible();
  await expect(region.getByLabel('Name')).toHaveValue('E2e view v001 typed');

  // A name that is empty is refused where it was typed, not also in the form of a new view.
  await page.getByRole('button', { name: 'New view' }).click();
  await region.getByLabel('Name').fill('   ');
  await page.getByRole('button', { name: 'Rename' }).click();
  await expect(page.getByRole('alert').filter({ hasText: 'The name may not be empty.' })).toHaveCount(1);
  await page.getByRole('button', { name: 'Cancel' }).click();

  // Renamed: the same file, the new title.
  const renamed = nextAnswer(page);
  await page.getByRole('region', { name: 'E2e view v001' }).getByLabel('Name').fill('E2e view v001 renamed');
  await page.getByRole('button', { name: 'Rename' }).click();
  await renamed;
  await expect.poll(() => readFileSync(file, 'utf8'), { timeout: WRITE_BUDGET }).toContain('E2e view v001 renamed');

  // Deleted, and back with undo (the engine's inverse, the view as it was).
  const gone = nextAnswer(page);
  await page.getByRole('button', { name: 'Delete view' }).click();
  await gone;
  await expect.poll(() => existsSync(file), { timeout: WRITE_BUDGET }).toBe(false);
  await expect(page.getByRole('region', { name: 'E2e view v001 renamed' })).toHaveCount(0);
  const back = nextAnswer(page);
  await page.getByRole('button', { name: 'Undo' }).click();
  await back;
  await expect.poll(() => existsSync(file), { timeout: WRITE_BUDGET }).toBe(true);
  await expect(page.getByRole('region', { name: 'E2e view v001 renamed' })).toBeVisible();
  // Leave the vault as the other tests know it.
  const cleaned = nextAnswer(page);
  await page.getByRole('button', { name: 'Delete view' }).click();
  await cleaned;
  await expect.poll(() => existsSync(file), { timeout: WRITE_BUDGET }).toBe(false);
});

test('a task moved between the groups of a view writes the field: by key first, a refused one leaves the file, one drag with the mouse', async ({ page }) => {
  await pair(page);
  await showList(page);
  await capture(page, 'E2e drag v001 one');
  await capture(page, 'E2e drag v001 two');
  // The view takes the filter of the list: just these two tasks.
  await page.getByRole('searchbox', { name: /search/i }).first().fill('E2e drag v001');
  await expect(page.locator('.rows .line')).toHaveCount(2);
  const make = page.getByRole('button', { name: 'New view' });
  await openViewsByKey(page, make);
  await expect(make).toBeEnabled();
  await make.click();
  const form = page.getByRole('form', { name: 'New view' });
  await form.getByLabel('Name').fill('E2e drag view v001');
  await form.getByLabel('Kept in area').selectOption('lib.nvim');
  await form.getByLabel('Group by').selectOption({ label: 'Tags' });
  await write(page, () => form.getByRole('button', { name: 'Create view' }).click());
  const open = page.getByRole('region', { name: 'E2e drag view v001' });
  const tasks = join(state().vault, 'lib.nvim', 'ROADMAP', 'tasks');
  const one = join(tasks, 'e2e-drag-v001-one.md');
  const two = join(tasks, 'e2e-drag-v001-two.md');
  const card = (group: string, id: string) => open.locator(`section[data-group="${group}"] [data-view-item="lib.nvim/${id}"]`);
  // Nothing is on its way when the button of a new view can be pressed again.
  // The groups are the engine's tags of the open tasks (other tests add some), the group of none last: read their order.
  const order = await open.locator('section[data-group]').evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset['group'] ?? ''));
  expect(order.at(-1)).toBe('');
  expect(order.length).toBeGreaterThanOrEqual(4);
  const [first, second] = [order.at(-2)!, order.at(-3)!];
  const live = open.locator('p[aria-live="polite"]');

  // The keys first: Shift+h moves the card to the group before.
  await card('', 'e2e-drag-v001-one').focus();
  await write(page, () => page.keyboard.press('Shift+h'));
  await expect.poll(() => readFileSync(one, 'utf8'), { timeout: WRITE_BUDGET }).toContain(`tags: [${first}]`);
  await expect(card(first, 'e2e-drag-v001-one')).toBeFocused();
  await expect(live).toHaveText(`E2e drag v001 one: now in ${first}`);

  // From one tag to another: the tag it leaves goes, the one it enters comes.
  await write(page, () => page.keyboard.press('Shift+h'));
  await expect.poll(() => readFileSync(one, 'utf8'), { timeout: WRITE_BUDGET }).toContain(`tags: [${second}]`);
  await expect(live).toHaveText(`E2e drag v001 one: now in ${second}`);

  // Refused: the file changes after the page showed it, so the engine refuses the move and the file keeps its tag;
  // nothing is announced as moved.
  await page.route('**/api/tasks/ops', async (route) => {
    writeFileSync(one, readFileSync(one, 'utf8') + '\nChanged by someone else.\n');
    await route.continue();
  });
  await card(second, 'e2e-drag-v001-one').focus();
  await write(page, () => page.keyboard.press('Shift+h'));
  await page.unroute('**/api/tasks/ops');
  await expect(page.getByRole('alert').getByText(/changed/i)).toBeVisible();
  expect(readFileSync(one, 'utf8')).toContain(`tags: [${second}]`);
  expect(readFileSync(one, 'utf8')).toContain('Changed by someone else.');
  await expect(live).toHaveText(`E2e drag v001 one: now in ${second}`);
  // At once the same card again: the hub read the changed file before it answered the refusal, so the list the page
  // read after it holds the new version and this move goes through (it was refused the same way before).
  await card(second, 'e2e-drag-v001-one').focus();
  await write(page, () => page.keyboard.press('Shift+l'));
  await expect.poll(() => readFileSync(one, 'utf8'), { timeout: WRITE_BUDGET }).toContain(`tags: [${first}]`);
  await expect(live).toHaveText(`E2e drag v001 one: now in ${first}`);

  // One drag with the mouse: the second task onto the group next to the group of none.
  await write(page, () =>
    drag(page, open.locator('section[data-group=""] li[data-item="lib.nvim/e2e-drag-v001-two"]'), open.locator(`section[data-group="${first}"]`)),
  );
  await expect.poll(() => readFileSync(two, 'utf8'), { timeout: WRITE_BUDGET }).toContain(`tags: [${first}]`);
  await expectAccessible(page, 'a view grouped by tags');

  // A copy by key, the keyboard's Ctrl and drag (WCAG 2.5.7): Shift+Alt+h adds the tag of the group before and keeps the
  // one it leaves; the card is then in both groups, and undo takes the copy back.
  await card(first, 'e2e-drag-v001-two').focus();
  await write(page, () => page.keyboard.press('Shift+Alt+h'));
  const tagsOfTwo = () => (readFileSync(two, 'utf8').match(/^tags: \[(.*)\]$/m)?.[1] ?? '').split(', ').sort();
  await expect.poll(tagsOfTwo, { timeout: WRITE_BUDGET }).toEqual([first, second].sort());
  await expect(live).toHaveText(`E2e drag v001 two: also in ${second}`);
  await expect(card(second, 'e2e-drag-v001-two')).toBeFocused();
  await expect(card(first, 'e2e-drag-v001-two')).toBeVisible();
  await expectAccessible(page, 'a tag copied by key in a view');
  await write(page, () => page.getByRole('button', { name: 'Undo' }).click());
  await expect.poll(tagsOfTwo, { timeout: WRITE_BUDGET }).toEqual([first]);

  // The menu of a group by key: Shift+F10 on a card opens the menu of its group (the heading of a column takes no focus).
  await card(first, 'e2e-drag-v001-two').focus();
  await page.keyboard.press('Shift+F10');
  await expect(page.getByRole('menu', { name: 'Open as a view' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(card(first, 'e2e-drag-v001-two')).toBeFocused();

  // Leave the vault as the other tests know it: the view goes (the two tasks have names no other test uses).
  const gone = nextAnswer(page);
  await page.getByRole('button', { name: 'Delete view' }).click();
  await gone;
});

test('the context menu opens a selection as a view to try: by key from a row, Escape gives the focus back, a group by the mouse, saved only when asked', async ({ page }) => {
  await pair(page);
  await showList(page);
  const viewsDir = join(state().vault, 'lib.nvim', 'ROADMAP', 'views');
  const files = () => (existsSync(viewsDir) ? readdirSync(viewsDir).length : 0);
  const before = files();
  const row = page.locator('button.row').filter({ has: page.locator('.id', { hasText: /^lib\.nvim\/alpha$/ }) });
  const menu = page.getByRole('menu', { name: 'Open as a view' });

  // By key: Shift+F10 on the row opens the menu with the focus on its first entry; Escape closes it and gives the
  // focus back to the row.
  await row.focus();
  await page.keyboard.press('Shift+F10');
  await expect(menu).toBeVisible();
  await expect(menu.getByRole('menuitem', { name: 'Columns' })).toBeFocused();
  await expectAccessible(page, 'the context menu');
  await page.keyboard.press('ArrowDown');
  await expect(menu.getByRole('menuitem', { name: 'List' })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(menu).toHaveCount(0);
  await expect(row).toBeFocused();

  // An entry by key: the area of the task as a list, a view to try - shown on the tab, no file written.
  await page.keyboard.press('Shift+F10');
  await expect(menu).toBeVisible();
  await page.keyboard.press('l');
  await expect(menu.getByRole('menuitem', { name: 'List' })).toBeFocused();
  await page.keyboard.press('Enter');
  const tried = page.getByRole('region', { name: 'lib.nvim', exact: true });
  await expect(tried).toBeVisible();
  // The menu and its row are gone: the focus is on the view that was opened.
  await expect(tried.getByRole('heading', { name: 'lib.nvim', level: 2 })).toBeFocused();
  await expect(tried.getByText('Not saved')).toBeVisible();
  await expect(tried.locator('[data-view-item="lib.nvim/alpha"]')).toBeVisible();
  await expect(tried.locator('[data-view-item^="cascade.nvim/"]')).toHaveCount(0);
  expect(files()).toBe(before);

  // A group by the mouse: the right click on the heading of a group opens the same view narrowed to the group.
  await tried.locator('section[data-group="open"] h3 button').click({ button: 'right' });
  await expect(menu).toBeVisible();
  await menu.getByRole('menuitem', { name: 'Columns' }).click();
  const narrowed = page.getByRole('region', { name: 'lib.nvim: open', exact: true });
  await expect(narrowed).toBeVisible();
  await expect(narrowed.locator('section[data-group="open"]')).toBeVisible();
  await expect(narrowed.locator('section[data-group="doing"] [data-view-item]')).toHaveCount(0);
  expect(files()).toBe(before);

  // Saved only when asked: the form of a new view takes its name, field and selection.
  await narrowed.getByRole('button', { name: 'Save as view' }).click();
  const form = page.getByRole('form', { name: 'New view' });
  await expect(form.getByLabel('Name')).toHaveValue('lib.nvim: open');
  await form.getByLabel('Kept in area').selectOption('lib.nvim');
  await write(page, () => form.getByRole('button', { name: 'Create view' }).click());
  await expect.poll(files, { timeout: WRITE_BUDGET }).toBe(before + 1);
  const file = viewFile('lib.nvim', 'lib.nvim: open')!;
  expect(readFileSync(file, 'utf8')).toMatch(/sel_statuses: \[open\]/);
  expect(readFileSync(file, 'utf8')).toMatch(/sel_areas: \[lib\.nvim\]/);
  await expect(page.getByRole('region', { name: 'lib.nvim: open', exact: true }).getByText('Not saved')).toHaveCount(0);
  // Leave the vault as the other tests know it.
  const gone = nextAnswer(page);
  await page.getByRole('button', { name: 'Delete view' }).click();
  await gone;
  await expect.poll(files, { timeout: WRITE_BUDGET }).toBe(before);

  // The plan chosen in the Plan view: the menu opens on the choice, Tab closes it and goes on from the choice, Escape
  // gives the focus back to the choice (not to the label around it).
  await chooseView(page, 'View', 'Plan');
  const choice = page.getByRole('combobox', { name: 'Plan' });
  await choice.selectOption({ index: 1 });
  await choice.focus();
  await page.keyboard.press('Shift+F10');
  await expect(menu).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(menu).toHaveCount(0);
  await expect(choice).toBeFocused();
  await page.keyboard.press('Shift+F10');
  await expect(menu).toBeVisible();
  await page.keyboard.press('Tab');
  await expect(menu).toHaveCount(0);
  await expect(choice).not.toBeFocused();
});

test('a view as a matrix: the count of a cell is its tasks, a click opens it, a card moves by key and by drag, both fields in one write', async ({ page }) => {
  await pair(page);
  await showList(page);
  await capture(page, 'Viewgrid v001 one');
  await capture(page, 'Viewgrid v001 two');
  await page.getByRole('searchbox', { name: /search/i }).first().fill('Viewgrid v001');
  await expect(page.locator('.rows .line')).toHaveCount(2);
  const make = page.getByRole('button', { name: 'New view' });
  await openViewsByKey(page, make);
  await make.click();
  const form = page.getByRole('form', { name: 'New view' });
  await form.getByLabel('Name').fill('E2e matrix view v001');
  await form.getByLabel('Kept in area').selectOption('lib.nvim');
  await form.getByLabel('Group by').selectOption({ label: 'Status' });
  await form.getByLabel('Show as').selectOption({ label: 'Matrix' });
  await form.getByLabel('Rows').selectOption({ label: 'Priority' });
  await write(page, () => form.getByRole('button', { name: 'Create view' }).click());
  const file = viewFile('lib.nvim', 'E2e matrix view v001')!;
  expect(readFileSync(file, 'utf8')).toMatch(/display: matrix/);
  expect(readFileSync(file, 'utf8')).toMatch(/group_by2: prio/);
  const open = page.getByRole('region', { name: 'E2e matrix view v001', exact: true });
  const tasks = join(state().vault, 'lib.nvim', 'ROADMAP', 'tasks');
  const one = join(tasks, 'viewgrid-v001-one.md');
  const two = join(tasks, 'viewgrid-v001-two.md');

  // The two new tasks are open and have no priority: their cell counts two, and the click shows them.
  const cell = open.getByRole('button', { name: 'not set · open: 2 tasks, show them' });
  await expect(cell).toBeVisible();
  await cell.click();
  // One name for the matrix: its box, not a second one on its table.
  await expect(open.getByRole('region', { name: 'Matrix of E2e matrix view v001', exact: true })).toHaveCount(1);
  expect(await open.locator('table').getAttribute('aria-label')).toBeNull();
  const list = open.getByRole('region', { name: 'not set · open', exact: true });
  await expect(list.locator('[data-matrix-item]')).toHaveCount(2);
  await expectAccessible(page, 'a view as a matrix');

  // The columns are the engine's open statuses: the one right of open is where Shift+l goes.
  const headers = (await open.locator('thead th').allInnerTexts()).slice(1);
  const right = headers[headers.indexOf('open') + 1]!;
  expect(right).toBeTruthy();

  // The keys first: Shift+k a row up (none is the last row, 3 the one above), Shift+l a column to the right.
  await list.locator('[data-matrix-item="lib.nvim/viewgrid-v001-one"]').focus();
  await write(page, () => page.keyboard.press('Shift+k'));
  await expect.poll(() => readFileSync(one, 'utf8'), { timeout: WRITE_BUDGET }).toMatch(/^prio: 3$/m);
  // The opened cell follows the card, and so does the focus.
  await expect(open.locator('[data-matrix-item="lib.nvim/viewgrid-v001-one"]')).toBeFocused();
  await write(page, () => page.keyboard.press('Shift+l'));
  await expect.poll(() => readFileSync(one, 'utf8'), { timeout: WRITE_BUDGET }).toMatch(new RegExp(`^status: ${right}$`, 'm'));
  expect(readFileSync(one, 'utf8')).toMatch(/^prio: 3$/m);

  // One drag with the mouse: the other card onto the cell of priority 1 and the status right of open - both fields.
  await open.getByRole('button', { name: 'not set · open: 1 task, show it' }).click();
  await write(page, () =>
    drag(
      page,
      open.locator('li:has([data-matrix-item="lib.nvim/viewgrid-v001-two"])'),
      open.locator(`td[data-cell='${JSON.stringify(['1', right])}']`),
    ),
  );
  await expect.poll(() => readFileSync(two, 'utf8'), { timeout: WRITE_BUDGET }).toMatch(/^prio: 1$/m);
  expect(readFileSync(two, 'utf8')).toMatch(new RegExp(`^status: ${right}$`, 'm'));

  // Leave the vault as the other tests know it: the view goes (the two tasks have names no other test uses).
  const gone = nextAnswer(page);
  await page.getByRole('button', { name: 'Delete view' }).click();
  await gone;
});

test('the board is the built-in view of the views: g b shows it in their bar, it has no delete, a view made there is shown, the choice goes back', async ({ page }) => {
  // A file in the folder of the views that is no view: the views tab names it, the board does not.
  const broken = join(state().vault, 'lib.nvim', 'ROADMAP', 'views', 'broken-e2e-builtin.md');
  mkdirSync(join(state().vault, 'lib.nvim', 'ROADMAP', 'views'), { recursive: true });
  writeFileSync(broken, 'no frontmatter, no view\n');
  await pair(page);
  const choice = page.getByRole('combobox', { name: 'Saved view', exact: true });
  const problems = page.getByText(/Files that are no view/);

  // No view saved yet: the choice says nothing is chosen, so the board is a choice that changes something.
  const make = page.getByRole('button', { name: 'New view' });
  await openViewsByKey(page, make);
  await expect(problems).toBeVisible();
  await expect(choice).toHaveValue('');
  await choice.selectOption('@board');
  await expect(page.getByRole('group', { name: 'Board' })).toBeVisible();
  await expect(problems).toHaveCount(0);
  removeFile(broken);
  // g b: the board, inside the bar of the views, chosen as the built-in view.
  await expect(async () => {
    await page.locator('main').focus();
    await page.keyboard.press('g');
    await page.keyboard.press('b');
    await expect(page.getByRole('group', { name: 'Board' })).toBeVisible({ timeout: 1000 });
  }).toPass({ timeout: 10000 });
  await expect(choice).toHaveValue('@board');
  await expect(page.getByRole('button', { name: 'Delete view' })).toHaveCount(0);
  await expectAccessible(page, 'the board in the bar of the views');

  // A view made from there is shown (the board is left), and the choice brings the board back.
  await page.getByRole('button', { name: 'New view' }).click();
  const form = page.getByRole('form', { name: 'New view' });
  await form.getByLabel('Name').fill('E2e builtin v001');
  await form.getByLabel('Kept in area').selectOption('lib.nvim');
  await write(page, () => form.getByRole('button', { name: 'Create view' }).click());
  await expect(page.getByRole('region', { name: 'E2e builtin v001', exact: true })).toBeVisible();
  await expect(page.getByRole('group', { name: 'Board' })).toHaveCount(0);
  await choice.selectOption('@board');
  await expect(page.getByRole('group', { name: 'Board' })).toBeVisible();
  await expect(page.getByRole('menuitemradio', { name: 'Board', exact: true })).toHaveCount(0);
  await page.getByRole('menuitem', { name: 'View', exact: true }).click();
  await expect(page.getByRole('menuitemradio', { name: 'Board', exact: true })).toHaveAttribute('aria-checked', 'true');
  await page.keyboard.press('Escape');

  // Leave the vault as the other tests know it.
  await choice.selectOption({ label: 'E2e builtin v001' });
  await expect(page.getByRole('region', { name: 'E2e builtin v001', exact: true })).toBeVisible();
  const gone = nextAnswer(page);
  await page.getByRole('button', { name: 'Delete view' }).click();
  await gone;
  await expect.poll(() => viewFile('lib.nvim', 'E2e builtin v001'), { timeout: WRITE_BUDGET }).toBeNull();
});

test('a view by area: a card moved to another area is a question to the engine first, giving up leaves the file, the confirmation moves it', async ({ page }) => {
  const from = join(state().vault, 'lib.nvim', 'ROADMAP', 'tasks', 'areaview-v001.md');
  writeFileSync(from, `---\ntitle: Areaview v001\nstatus: open\nkind: task\n---\n\nTo be moved to another area in a view.\n`);
  await pair(page);
  await showList(page);
  await page.getByRole('searchbox', { name: /search/i }).first().fill('Areaview v001');
  await expect(page.locator('.rows .line')).toHaveCount(1);
  const make = page.getByRole('button', { name: 'New view' });
  await openViewsByKey(page, make);
  await make.click();
  const form = page.getByRole('form', { name: 'New view' });
  await form.getByLabel('Name').fill('Areaview view v001');
  await form.getByLabel('Kept in area').selectOption('lib.nvim');
  await form.getByLabel('Group by').selectOption({ label: 'Area' });
  await write(page, () => form.getByRole('button', { name: 'Create view' }).click());
  const open = page.getByRole('region', { name: 'Areaview view v001', exact: true });
  const card = (area: string) => open.locator(`section[data-group="${area}"] [data-view-item="${area}/areaview-v001"]`);
  await expect(card('lib.nvim')).toBeVisible();
  // The area to the right of lib.nvim, as the engine orders the areas.
  const order = await open.locator('section[data-group]').evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset['group'] ?? ''));
  const to = order[order.indexOf('lib.nvim') + 1]!;
  expect(to).toBeTruthy();
  const moved = join(state().vault, to, 'ROADMAP', 'tasks', 'areaview-v001.md');
  removeFile(moved);

  // By key: Shift+l asks the engine (a dry run), the dialog says what the move does; giving up leaves the file.
  await card('lib.nvim').focus();
  await page.keyboard.press('Shift+l');
  const dialog = page.getByRole('dialog', { name: `Move to ${to}?` });
  await expect(dialog).toBeVisible();
  await expectAccessible(page, 'the move of a card of a view to another area');
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(dialog).toHaveCount(0);
  expect(existsSync(from)).toBe(true);
  expect(existsSync(moved)).toBe(false);
  // The dialog gives the focus back to the card it was opened from.
  await expect(card('lib.nvim')).toBeFocused();

  // Again, and confirmed: the file is moved to the area, the card is in its group, with the focus and said.
  await page.keyboard.press('Shift+l');
  await expect(dialog).toBeVisible();
  await write(page, () => dialog.getByRole('button', { name: new RegExp(`${to.replace('.', '\\.')}/areaview-v001`) }).click());
  await expect.poll(() => existsSync(moved), { timeout: WRITE_BUDGET }).toBe(true);
  expect(existsSync(from)).toBe(false);
  await expect(card(to)).toBeFocused();
  await expect(open.locator('p[aria-live="polite"]')).toHaveText(`Areaview v001: now in ${to}`);

  // Leave the vault as the other tests know it.
  const gone = nextAnswer(page);
  await page.getByRole('button', { name: 'Delete view' }).click();
  await gone;
  removeFile(moved);
});

test('the board says why it cannot make a view when the engine names no fields', async ({ page }) => {
  // The engine does not answer the fields: the button of a new view stays greyed out, and the board says why.
  await page.route('**/api/tasks/groupings', (route) =>
    route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ code: 'engine_busy', message: 'busy' }) }),
  );
  await pair(page);
  await expect(async () => {
    await page.locator('main').focus();
    await page.keyboard.press('g');
    await page.keyboard.press('b');
    await expect(page.getByRole('group', { name: 'Board' })).toBeVisible({ timeout: 1000 });
  }).toPass({ timeout: 10000 });
  await expect(page.getByRole('button', { name: 'New view' })).toBeDisabled();
  await expect(page.getByRole('alert').filter({ hasText: 'The engine did not name the fields to group by.' })).toBeVisible();
});

test('the ranges of the fields are asked of the hub once, and the property form offers the ones the engine names', async ({ page }) => {
  const asked: string[] = [];
  page.on('request', (r) => {
    if (new URL(r.url()).pathname === '/api/tasks/enums') asked.push(r.url());
  });
  await pair(page);
  await showList(page);
  await open(page, 'lib.nvim/alpha');
  const kind = page.locator('aside.detail').getByLabel('Kind');
  await expect(kind).toBeVisible();
  // The engine names these five (its hello.enums); the page has no list of its own to disagree with.
  await expect(kind.locator('option')).toHaveText(['(none)', 'feature', 'task', 'bug', 'idea', 'research']);
  expect(asked).toHaveLength(1);
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

for (const scheme of ['light', 'dark'] as const) {
  test(`the search clears with one press: its own button, Escape and the reset of all filters (${scheme})`, async ({
    page,
  }) => {
    await page.emulateMedia({ colorScheme: scheme });
    await pair(page);
    await showList(page);
    const search = page.getByRole('searchbox', { name: 'Search id and title' });
    const clear = page.getByRole('button', { name: 'Clear the search' });
    const reset = page.getByRole('button', { name: 'Clear all filters' });
    const count = page.locator('p.count [role="status"]');
    await expect(count).not.toHaveText('');
    const all = await count.textContent();
    // Nothing to clear: neither button is there.
    await expect(clear).toHaveCount(0);
    await expect(reset).toHaveCount(0);

    // Words alone narrow the list: the button in the field and the reset of all filters come with them.
    await search.fill('lib.nvim/alpha');
    await expect(count).not.toHaveText(all!);
    await expect(clear).toBeVisible();
    await expect(clear).toHaveAttribute('title', 'Clear the search');
    await expect(reset).toBeVisible();
    await expectAccessible(page, `the list with words in the search (${scheme})`);

    // The keyboard reaches the button from the field; Enter empties it and the focus is back in the field (whose hint
    // the focus from the keyboard shows).
    const tip = page.locator('#hint-tip');
    await search.focus();
    await page.keyboard.press('Tab');
    await expect(clear).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(search).toHaveValue('');
    await expect(search).toBeFocused();
    await expect(count).toHaveText(all!);
    await expect(clear).toHaveCount(0);
    await expect(reset).toHaveCount(0);
    await expect(tip).toBeVisible();

    // With the hint open the first Escape closes the hint only and the words stay; the second empties the field.
    await search.fill('lib.nvim/alpha');
    await expect(clear).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(tip).toBeHidden();
    await expect(search).toHaveValue('lib.nvim/alpha');
    await page.keyboard.press('Escape');
    await expect(search).toHaveValue('');
    await expect(search).toBeFocused();
    await expect(count).toHaveText(all!);

    // Chrome empties a search box on Escape by itself, Firefox does not: an Escape made by the page has no action of
    // the browser, so only the page's own handling empties the field here. One within a composition leaves it.
    await search.fill('lib.nvim/alpha');
    const escape = (composing: boolean): Promise<boolean> =>
      search.evaluate((el, isComposing) => {
        const e = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true, isComposing });
        el.dispatchEvent(e);
        return e.defaultPrevented;
      }, composing);
    expect(await escape(true)).toBe(false);
    await expect(search).toHaveValue('lib.nvim/alpha');
    expect(await escape(false)).toBe(true);
    await expect(search).toHaveValue('');

    // A click on the button: the same, and the focus that stays in the field shows no hint.
    await search.fill('lib.nvim/alpha');
    await expect(tip).toBeHidden();
    await clear.click();
    await expect(search).toHaveValue('');
    await expect(search).toBeFocused();
    await expect(tip).toBeHidden();

    // The reset of all filters takes the words away together with a chosen area.
    await search.fill('lib.nvim/alpha');
    await page.getByRole('button', { name: /^Areas/ }).click();
    await page.getByRole('group', { name: 'Areas' }).getByRole('checkbox', { name: 'lib.nvim', exact: true }).check();
    await page.keyboard.press('Escape');
    await reset.click();
    await expect(search).toHaveValue('');
    await expect(page.locator('ul.active')).toHaveCount(0);
    await expect(count).toHaveText(all!);
    expect(await violations(page)).toEqual([]);
    expect(consoleProblems.get(page)).toEqual([]);
  });
}

test('a choice of several areas says how they combine and does not move under the pointer', async ({ page }) => {
  await pair(page);
  await showList(page);
  const areas = page.getByRole('button', { name: /^Areas/ });
  await areas.click();
  const popup = page.getByRole('group', { name: 'Areas' });
  await expect(popup.getByText(/any of the ones chosen \(OR\)/)).toBeVisible();
  const before = await areas.boundingBox();
  const popupBefore = await popup.boundingBox();
  // The label grows ("Areas: cascade.nvim") and shrinks ("Areas: 2"): the button and the popup stay where they were.
  await popup.getByRole('checkbox', { name: 'cascade.nvim' }).check();
  await popup.getByRole('checkbox', { name: 'lib.nvim' }).check();
  expect(await areas.boundingBox()).toEqual(before);
  // The popup grows downwards (the button that clears the choice comes in) but stays where it was.
  const popupAfter = await popup.boundingBox();
  expect({ x: popupAfter?.x, y: popupAfter?.y, width: popupAfter?.width }).toEqual({
    x: popupBefore?.x,
    y: popupBefore?.y,
    width: popupBefore?.width,
  });
  await expect(popup).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(areas).toHaveText(/Areas: 2/);
  // Tags: a task holds several, so the choice offers "all of them" and the chip says so.
  await page.getByText('More filters', { exact: false }).first().click();
  await page.getByRole('button', { name: /^Tag/ }).click();
  const tags = page.getByRole('group', { name: 'Tag' });
  await tags.getByRole('checkbox', { name: /^ui/ }).check();
  await tags.getByRole('radio', { name: 'all of them (AND)' }).check();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('button', { name: /Tag \(all\): ui/ })).toBeVisible();
  expect(await violations(page)).toEqual([]);
  expect(consoleProblems.get(page)).toEqual([]);
});

test('the chips of the filter say how they combine: or within a field, and between fields, in the list and the strip', async ({
  page,
}) => {
  await pair(page);
  await showList(page);
  await page.getByRole('button', { name: /^Areas/ }).click();
  const areas = page.getByRole('group', { name: 'Areas' });
  await areas.getByRole('checkbox', { name: 'cascade.nvim' }).check();
  await areas.getByRole('checkbox', { name: 'lib.nvim' }).check();
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: /^Status/ }).first().click();
  await page.getByRole('group', { name: 'Status' }).getByRole('checkbox', { name: 'open', exact: true }).check();
  await page.keyboard.press('Escape');
  // The words are text of the chips: a screen reader hears them with the value.
  const words = (list: Locator) => list.locator('li').evaluateAll((lis) => lis.map((li) => li.querySelector('.join')?.textContent ?? ''));
  const listChips = page.getByRole('list', { name: 'Filters that are on' }).first();
  await expect.poll(() => words(listChips)).toEqual(['', 'or', 'and', '']);
  await expect(listChips.locator('li').nth(1)).toHaveText(/^or\s*Area/);
  // The strip over the other views says the same.
  await chooseView(page, 'View', 'Board');
  const strip = page.getByTestId('filter-note').getByRole('list');
  await expect.poll(() => words(strip)).toEqual(['', 'or', 'and', '', '']);
  expect(await violations(page)).toEqual([]);
  expect(consoleProblems.get(page)).toEqual([]);
});

test('the columns of the list take the width they are dragged to, and a cut text shows whole on the pointer', async ({ page }) => {
  await pair(page);
  await showList(page);
  const edge = page.getByRole('separator', { name: 'Width of the column ID' });
  const firstId = page.locator('button.row .id').first();
  const before = (await firstId.boundingBox())!.width;
  const box = (await edge.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 80, box.y + box.height / 2, { steps: 5 });
  await page.mouse.up();
  const after = (await firstId.boundingBox())!.width;
  expect(after).toBeGreaterThan(before + 60);
  // Remembered: a reload keeps the width.
  await page.reload();
  await expect(page.locator('button.row').first()).toBeVisible();
  expect(Math.abs((await page.locator('button.row .id').first().boundingBox())!.width - after)).toBeLessThan(2);
  // The keyboard moves the edge too, and Enter gives the default back.
  const again = page.getByRole('separator', { name: 'Width of the column ID' });
  await again.focus();
  await page.keyboard.press('Enter');
  expect(Math.abs((await page.locator('button.row .id').first().boundingBox())!.width - before)).toBeLessThan(2);
  // The marks start from the width of the marks of the rows, not from the width of their name in the head: one press
  // narrows them by one step.
  const metaWidths = () =>
    page.locator('button.row .meta').evaluateAll((els) => Math.max(...els.map((e) => e.getBoundingClientRect().width)));
  const widest = await metaWidths();
  expect(widest).toBeGreaterThan(100);
  const marksEdge = page.getByRole('separator', { name: 'Width of the column Marks' });
  await marksEdge.focus();
  expect(Math.abs(Number(await marksEdge.getAttribute('aria-valuenow')) - widest)).toBeLessThan(2);
  await page.keyboard.press('ArrowRight');
  expect(Math.abs((await metaWidths()) - (widest - 16))).toBeLessThan(3);
  await page.keyboard.press('Enter');
  // The marks on the right: dragged narrow, the title of the row with the widest marks gets the room.
  const widestRow = await page
    .locator('button.row .meta')
    .evaluateAll((els) => {
      const widths = els.map((e) => e.getBoundingClientRect().width);
      return widths.indexOf(Math.max(...widths));
    });
  const title = page.locator('button.row .title').nth(widestRow);
  const titleBefore = (await title.boundingBox())!.width;
  const marks = page.getByRole('separator', { name: 'Width of the column Marks' });
  await marks.focus();
  for (let i = 0; i < 4; i += 1) await page.keyboard.press('ArrowRight');
  expect((await title.boundingBox())!.width).toBeGreaterThan(titleBefore);
  // A title that is cut shows all of it in the hint popup.
  await page.getByRole('separator', { name: 'Width of the column ID' }).focus();
  for (let i = 0; i < 30; i += 1) await page.keyboard.press('ArrowRight');
  const cut = page.locator('button.row .title').filter({ hasText: /.{20,}/ }).first();
  await cut.hover();
  const full = (await cut.textContent()) ?? '';
  await expect(page.locator('#hint-tip')).toHaveText(full);
  expect(await violations(page)).toEqual([]);
  expect(consoleProblems.get(page)).toEqual([]);
});

test('the warnings of the plan are folded when the page opens, and the stages fold one step at a time and stay so', async ({
  page,
}) => {
  await watchViolations(page);
  await pair(page);
  await chooseView(page, 'View', 'Plan');
  // The warnings: their head with the count, the list only on a press.
  const warnings = page.getByRole('group', { name: 'Warnings of the plan' });
  await expect(warnings.locator('summary')).toHaveText(/Warnings of the plan \(\d+\)/);
  const cycle = warnings.getByText('lib.nvim/cyc-a', { exact: false }).first();
  await expect(cycle).toBeHidden();
  await warnings.locator('summary').click();
  await expect(cycle).toBeVisible();

  const stages = page.getByRole('region', { name: 'Stages' });
  const first = stages.locator('.stage').first();
  const key = await first.getAttribute('data-stage');
  const name = key === 'cycle' ? 'Without a stage' : `Stage ${key}`;
  const tasks = first.locator('li');
  const height = (await first.boundingBox())!.height;
  await expect(tasks.first()).toBeVisible();
  // Open, then its head only, then a narrow strip, then open again.
  await first.getByRole('button', { name: `Fold ${name}`, exact: true }).click();
  await expect(tasks).toHaveCount(0);
  expect((await first.boundingBox())!.height).toBeLessThan(height);
  const width = (await first.boundingBox())!.width;
  await first.getByRole('button', { name: `Fold ${name} to a narrow strip` }).click();
  expect((await first.boundingBox())!.width).toBeLessThan(width / 2);
  expect(await violations(page)).toEqual([]);
  // Kept over a reload.
  await page.reload();
  await expect(page.getByRole('region', { name: 'Stages' }).locator('.stage').first()).toBeVisible();
  await expect(page.locator(`.stage[data-stage="${key}"]`)).toHaveClass(/narrow/);
  await page.locator(`.stage[data-stage="${key}"]`).getByRole('button', { name: `Open ${name}` }).click();
  await expect(page.locator(`.stage[data-stage="${key}"] li`).first()).toBeVisible();
  // The button for all of them folds every stage, and the next press makes them narrow strips.
  await page.getByRole('button', { name: 'Fold all stages', exact: true }).click();
  await expect(page.locator('.stages li')).toHaveCount(0);
  await page.getByRole('button', { name: 'Fold all stages to a narrow strip' }).click();
  await expect(page.locator('.stage:not(.narrow)')).toHaveCount(0);
  await page.getByRole('button', { name: 'Open all stages' }).click();
  await expect(page.locator('.stage.folded')).toHaveCount(0);
  expect(consoleProblems.get(page)).toEqual([]);
});

test('a column of the board folds to its head and to a narrow strip, the others take its room, and it stays so', async ({
  page,
}) => {
  await watchViolations(page);
  await pair(page);
  await chooseView(page, 'View', 'Board');
  const column = (name: string) => page.getByRole('region', { name, exact: true });
  const open = column('open');
  await expect(open.locator('.card').first()).toBeVisible();
  const parkedX = (await column('parked').boundingBox())!.x;
  await open.getByRole('button', { name: 'Fold open', exact: true }).click();
  await expect(open.locator('.card')).toHaveCount(0);
  await open.getByRole('button', { name: 'Fold open to a narrow strip' }).click();
  // The narrow column gives its width to the others: the column after it moves up beside it.
  expect((await open.boundingBox())!.width).toBeLessThan(80);
  expect((await column('parked').boundingBox())!.x).toBeLessThan(parkedX - 100);
  expect(await violations(page)).toEqual([]);
  await page.reload();
  await expect(page.getByRole('region', { name: 'open', exact: true })).toHaveClass(/narrow/);
  await page.getByRole('region', { name: 'open', exact: true }).getByRole('button', { name: 'Open open' }).click();
  await expect(page.getByRole('region', { name: 'open', exact: true }).locator('.card').first()).toBeVisible();
  expect(consoleProblems.get(page)).toEqual([]);
});

test('h and l on the board pass a folded column: the selection never lands on a card that is not drawn', async ({ page }) => {
  await pair(page);
  await chooseView(page, 'View', 'Board');
  const column = (name: string) => page.getByRole('region', { name, exact: true });
  await expect(column('blocked').locator('.card').first()).toBeVisible();
  await column('decision').getByRole('button', { name: 'Fold decision', exact: true }).click();
  await expect(column('decision').locator('.card')).toHaveCount(0);
  await column('doing').locator('.card').first().click();
  await expect(column('doing').locator('[aria-current="true"]')).toHaveCount(1);
  await page.keyboard.press('l');
  // Past the folded column to the next one that shows its cards.
  await expect(column('blocked').locator('[aria-current="true"]')).toHaveCount(1);
  await page.keyboard.press('h');
  await expect(column('doing').locator('[aria-current="true"]')).toHaveCount(1);
});

test('a tile of today and the list take the size their grip is dragged to, keep it, and give it back', async ({
  page,
}) => {
  await watchViolations(page);
  await pair(page);
  await chooseView(page, 'View', 'Today');
  const tile = page.getByRole('region', { name: 'Waits for you' });
  await expect(tile).toBeVisible();
  const toggle = tile.getByRole('button', { name: 'Change the size of Waits for you' });
  await expect(toggle).toHaveAttribute('aria-pressed', 'false');
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-pressed', 'true');
  // The grip is the browser's, in the lower right corner.
  const before = (await tile.boundingBox())!;
  await page.mouse.move(before.x + before.width - 3, before.y + before.height - 3);
  await page.mouse.down();
  await page.mouse.move(before.x + before.width + 60, before.y + before.height + 90, { steps: 6 });
  await page.mouse.up();
  const after = (await tile.boundingBox())!;
  expect(after.height).toBeGreaterThan(before.height + 60);
  expect(await violations(page)).toEqual([]);
  // Kept over a reload, without the grip.
  await page.reload();
  const again = page.getByRole('region', { name: 'Waits for you' });
  await expect(again).toBeVisible();
  expect(Math.abs((await again.boundingBox())!.height - after.height)).toBeLessThan(2);
  const toggleAgain = again.getByRole('button', { name: 'Change the size of Waits for you' });
  await expect(toggleAgain).toHaveAttribute('aria-pressed', 'false');
  // The size of the layout back.
  await toggleAgain.click();
  await again.getByRole('button', { name: 'Give Waits for you the size of the layout back' }).click();
  expect(Math.abs((await again.boundingBox())!.height - before.height)).toBeLessThan(2);

  // The keyboard: the arrow keys on the size button move the lower right corner, one step per press.
  await toggleAgain.focus();
  const keyed = (await again.boundingBox())!;
  for (let i = 0; i < 3; i += 1) await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowLeft');
  await expect.poll(async () => Math.round((await again.boundingBox())!.height - keyed.height)).toBe(48);
  expect(Math.round((await again.boundingBox())!.width - keyed.width)).toBe(-16);
  // The grip stops at the smallest size a block is kept at: it does not shrink further and jump back on release.
  const small = (await again.boundingBox())!;
  await page.mouse.move(small.x + small.width - 3, small.y + small.height - 3);
  await page.mouse.down();
  await page.mouse.move(small.x - 400, small.y - 400, { steps: 6 });
  const held = (await again.boundingBox())!;
  await page.mouse.up();
  expect(held.width).toBeGreaterThanOrEqual(160 - 1);
  expect(held.height).toBeGreaterThanOrEqual(80 - 1);
  const released = (await again.boundingBox())!;
  expect(Math.abs(released.height - held.height)).toBeLessThan(2);
  expect(Math.abs(released.width - held.width)).toBeLessThan(2);

  // The list: made lower, it scrolls in itself.
  await showList(page);
  const sizeList = page.getByRole('button', { name: 'Change the size of the list' });
  await sizeList.click();
  const list = page.locator('.sizing').first();
  // The grip is at the lower end of the list, below the fold of the window.
  await list.evaluate((el) => el.scrollIntoView({ block: 'end' }));
  const box = (await list.boundingBox())!;
  await page.mouse.move(box.x + box.width - 3, box.y + box.height - 3);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width - 3, box.y + box.height - 200, { steps: 6 });
  await page.mouse.up();
  expect((await list.boundingBox())!.height).toBeLessThan(box.height - 40);
  await page.reload();
  await expect(page.locator('button.row').first()).toBeVisible();
  const kept = await page.evaluate(() => JSON.parse(localStorage.getItem('tasks-desktop.sizes') ?? '{}') as object);
  expect(Object.keys(kept)).toContain('list');
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
  // The name of the app is a name: it stays "Tasks" in German. The menus: the appearance is in the view,
  // the vaults in the project, and the language is in the options.
  await expect(page.locator('.brand')).toHaveText('Tasks');
  const bar = page.getByRole('menubar').getByRole('menuitem');
  await expect(bar).toHaveText(['Tasks', 'Projekt', 'Ansicht', 'Optionen', 'Hilfe']);
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
  const order = () => page.locator('section[data-tile]:has(button.grip)').evaluateAll((els) =>
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

  // A tap does the same as the arrow key (a touch screen cannot drag): the down button of the first block, then the
  // menu entry of the View menu puts the standard order back.
  await page.locator(`section[data-tile="${before[0]}"] button[data-nudge="down"]`).click();
  await expect.poll(order).toEqual(after);
  await page.locator(`section[data-tile="${before[0]}"] button[data-nudge="up"]`).click();
  await expect.poll(order).toEqual(before);
  await page.locator(`section[data-tile="${before[0]}"] button[data-nudge="down"]`).click();
  await expect.poll(order).toEqual(after);
  await page.getByRole('menuitem', { name: 'View' }).click();
  await page.getByRole('menuitem', { name: 'Reset the order of the tiles' }).click();
  await expect.poll(order).toEqual(before);
  await page.getByRole('menuitem', { name: 'View' }).click();
  await expect(page.getByRole('menuitem', { name: 'Reset the order of the tiles' })).toBeDisabled();
});

test('Tasks, Next task opens the task that the tile Next task shows, not the pick of an agent', async ({ page }) => {
  await pair(page);
  const id = (await page.locator('section[data-tile="next"] p.id code').textContent())?.trim() ?? '';
  expect(id).not.toBe('');
  await page.getByRole('menuitem', { name: 'Tasks', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Next task', exact: true }).click();
  await expect(page.locator('aside.detail')).toContainText(id);
  await expect(page.locator('button.row[aria-current="true"], button.row.selected').first()).toBeVisible();
});

test('the explanations of the vault and of the graph are reachable with the keyboard: one info button each', async ({ page }) => {
  await pair(page);
  const tip = page.locator('#hint-tip');

  // The vaults dialog: the "read now" tag explained on hover now has an info button beside the title.
  await page.getByRole('menuitem', { name: 'Project', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Manage vaults ...' }).click();
  const dialog = page.getByRole('dialog', { name: 'Vaults' });
  const vaultInfo = dialog.getByRole('button', { name: /Explanation/ });
  await vaultInfo.focus();
  await expect(tip).toHaveText(/The vault the hub reads now/);
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);

  // The graph of a task: one stop with the words of the directions, the count, a circle, the wait line.
  await showList(page);
  await page.locator('button.row').first().click();
  await page.getByRole('button', { name: 'What do I need for this?' }).click();
  const graph = page.locator('section.graph');
  await expect(graph).toBeVisible();
  const graphInfo = graph.getByRole('button', { name: /Explanation/ });
  await graphInfo.focus();
  await expect(tip).toContainText('has to wait for');
  await expect(graphInfo).toHaveAccessibleDescription(/longest chain/);
});

test('the start page has a small summary of today: tasks finished, made and changed', async ({ page }) => {
  await pair(page);
  const card = page.locator('section[data-tile="daily"]');
  await expect(card).toBeVisible();
  await expect(card.getByRole('heading', { name: /Today/ })).toBeVisible();
  const figure = async (name: string): Promise<number> => {
    const text = (await card.locator(`li[data-figure="${name}"] .num`).textContent())?.trim() ?? '';
    return Number(text);
  };
  await expect.poll(async () => Number.isNaN(await figure('finished'))).toBe(false);
  const before = { finished: await figure('finished'), created: await figure('created') };

  // A task that is made now is new today ...
  await page.keyboard.press('c');
  const dialog = page.getByRole('dialog', { name: 'New task' });
  await expect(dialog).toBeVisible();
  const title = `Daily figures ${Date.now()}`;
  await dialog.getByLabel('Title').fill(title);
  await dialog.locator('select').first().selectOption('lib.nvim');
  await dialog.getByRole('button', { name: 'Create' }).click();
  await expect(dialog).toHaveCount(0);
  // Making a task shows it in the list: back to the start page.
  await page.getByRole('menuitem', { name: 'View', exact: true }).click();
  await page.getByRole('menuitemradio', { name: 'Today', exact: true }).click();
  await expect.poll(() => figure('created')).toBe(before.created + 1);

  // ... and finished today when it is finished (the engine counts the Backlog).
  await showList(page);
  await page.locator('button.row', { hasText: title }).first().click();
  await page.locator('aside.detail').getByRole('button', { name: 'Finish ...' }).click();
  const done = page.getByRole('dialog', { name: 'Finish this task?' });
  await done.getByRole('button', { name: 'Finish', exact: true }).click();
  await expect(done).toHaveCount(0);
  await page.getByRole('menuitem', { name: 'View', exact: true }).click();
  await page.getByRole('menuitemradio', { name: 'Today', exact: true }).click();
  await expect.poll(() => figure('finished')).toBe(before.finished + 1);

  // The tile can be hidden like the others, and comes back.
  await card.getByRole('button', { name: /Hide/ }).click();
  await expect(card).toHaveCount(0);
  await page.getByRole('button', { name: /Hidden tiles/ }).click();
  await expect(card).toBeVisible();
});

test('the tile Today turns to a week, a month and days that are named, counts what was chosen, and leaves as an image and as a page to print', async ({ page }) => {
  await pair(page);
  const card = page.locator('section[data-tile="daily"]');
  await expect(card).toBeVisible();
  const range = card.locator('[data-range]');
  const today = (await range.textContent())?.trim() ?? '';
  expect(today).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  // Today is the last period: there is no page after it.
  await expect(card.locator('button[data-turn="next"]')).toBeDisabled();

  // The week: Monday to Sunday around today, and back one week.
  await card.locator('button[data-popup="period"]').click();
  await card.getByRole('radio', { name: 'Week' }).check();
  await expect(card.getByRole('heading', { level: 2 })).toContainText('Week');
  await expect(range).toHaveText(/^\d{4}-\d{2}-\d{2} – \d{4}-\d{2}-\d{2}$/);
  const thisWeek = (await range.textContent()) ?? '';
  await card.locator('button[data-turn="prev"]').click();
  const lastWeek = (await range.textContent()) ?? '';
  expect(lastWeek).not.toBe(thisWeek);
  await expect(card.locator('button[data-turn="next"]')).toBeEnabled();
  await card.locator('button[data-turn="next"]').click();
  await expect(range).toHaveText(thisWeek);

  // The month, and days that are named.
  await card.getByRole('radio', { name: 'Month' }).check();
  await expect(range).toHaveText(/^\d{4}-\d{2}-01 – /);
  await card.getByRole('radio', { name: 'Period' }).check();
  await card.locator('input[data-date="from"]').fill('2026-01-01');
  await card.locator('input[data-date="to"]').fill('2026-01-31');
  await expect(range).toHaveText('2026-01-01 – 2026-01-31');
  await card.locator('button[data-turn="prev"]').click();
  await expect(range).toHaveText('2025-12-01 – 2025-12-31');

  // The choice stays when the page is read again.
  await page.reload();
  await expect(page.locator('section[data-tile="daily"] [data-range]')).toHaveText('2025-12-01 – 2025-12-31');
  const again = page.locator('section[data-tile="daily"]');

  // What is counted: three at first, eight to choose from, each one ticked or unticked.
  await expect(again.locator('li[data-figure]')).toHaveCount(3);
  await again.locator('button[data-popup="metrics"]').click();
  await expect(again.locator('input[data-metric]')).toHaveCount(8);
  await again.locator('input[data-metric="quick"]').check();
  await again.locator('input[data-metric="commits"]').check();
  await again.locator('input[data-metric="changed"]').uncheck();
  await expect(again.locator('li[data-figure]')).toHaveCount(4);
  await expect(again.locator('li[data-figure="changed"]')).toHaveCount(0);
  await expect(again.locator('li[data-figure="quick"] .num')).toHaveText(/^(≥ )?\d+$/);
  for (const metric of await again.locator('input[data-metric]').all()) await metric.uncheck();
  await expect(again.getByText('Nothing is chosen to be counted.')).toBeVisible();
  for (const name of ['finished', 'created']) await again.locator(`input[data-metric="${name}"]`).check();

  // Out as an image: a PNG that the browser saves.
  await again.locator('button[data-popup="print"]').click();
  const download = page.waitForEvent('download');
  await again.locator('button[data-action="png"]').click();
  const file = await download;
  expect(file.suggestedFilename()).toBe('tasks-2025-12-01_2025-12-31.png');

  // Out as a page for the printer: the dialog is replaced by a stub that reads what is on the page at that moment.
  await page.evaluate(() => {
    (window as unknown as { __printed?: string }).__printed = undefined;
    window.print = () => {
      const el = document.getElementById('daily-print');
      (window as unknown as { __printed?: string }).__printed = `${document.documentElement.classList.contains('print-daily')}|${el?.innerText ?? ''}`;
      window.dispatchEvent(new Event('afterprint'));
    };
  });
  await again.locator('button[data-popup="print"]').click();
  await again.locator('button[data-action="print"]').click();
  const printed = await page.evaluate(() => (window as unknown as { __printed?: string }).__printed ?? '');
  expect(printed).toContain('true|');
  expect(printed).toContain('2025-12-01 – 2025-12-31');
  expect(printed).toMatch(/finished\s*(\d+|–)/);
  // The page for the printer is gone when the dialog is: nothing is left of it, and the page is as it was.
  await expect(page.locator('#daily-print')).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.classList.contains('print-daily'))).toBe(false);

  // Escape closes the open popup and not the page behind it.
  await again.locator('button[data-popup="metrics"]').click();
  await expect(again.locator('input[data-metric]').first()).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(again.locator('input[data-metric]')).toHaveCount(0);
});

test('the tile does not show the finished figure of one period under the days of the next while that one is on its way', async ({ page }) => {
  let today = '';
  const doc = (total: number) =>
    JSON.stringify({ kind: 'tasks.finished', total, offset: 0, limit: 100, items: [], undated: 0, incomplete: [], stats: { effort_days: 0, without_effort: 0, by_area: [], by_kind: [], by_prio: [] } });
  await page.route('**/api/tasks/finished*', async (route) => {
    const since = new URL(route.request().url()).searchParams.get('since');
    // Today answers at once with 7; every other day answers 0, but late.
    if (since === today) return route.fulfill({ status: 200, contentType: 'application/json', body: doc(7) });
    await new Promise((r) => setTimeout(r, 1500));
    return route.fulfill({ status: 200, contentType: 'application/json', body: doc(0) });
  });
  await watchViolations(page);
  await page.addInitScript((token) => sessionStorage.setItem('tasks-desktop.session', token), state().token);
  await page.goto('/');
  const card = page.locator('section[data-tile="daily"]');
  await expect(card).toBeVisible();
  today = ((await card.locator('[data-range]').textContent()) ?? '').trim();
  // The first answer for today may have gone before the day was known: ask again by turning back and forth.
  await card.locator('button[data-turn="prev"]').click();
  await card.locator('button[data-turn="next"]').click();
  const finished = card.locator('li[data-figure="finished"] .num');
  await expect(finished).toHaveText('7');
  await card.locator('button[data-turn="prev"]').click();
  // The day before is on its way: a dash, not the 7 of today.
  await expect(finished).toHaveText('–', { timeout: 1000 });
  await expect(finished).toHaveText('0');
});

test('every entry of the header explains itself on hover: the five menus and the connection', async ({ page }) => {
  await pair(page);
  const tip = page.locator('#hint-tip');
  const entries = [
    [page.getByRole('menuitem', { name: 'Tasks', exact: true }), /Create, find and edit tasks/],
    [page.getByRole('menuitem', { name: 'Project', exact: true }), /vault, the plan and the export/],
    [page.getByRole('menuitem', { name: 'View', exact: true }), /Switch the view/],
    [page.getByRole('menuitem', { name: 'Options', exact: true }), /language and how the page behaves/],
    [page.getByRole('menuitem', { name: 'Help', exact: true }), /About this app/],
    [page.locator('header .conn'), /gets every change of the vault at once/],
  ] as const;
  for (const [entry, words] of entries) {
    await entry.hover();
    await expect(tip).toBeVisible();
    await expect(tip).toHaveText(words);
    await page.mouse.move(0, 400);
    await expect(tip).toBeHidden();
  }
  // Every entry of the bar is on the list above: a menu added without a hint fails here.
  await expect(page.getByRole('menubar').getByRole('menuitem')).toHaveCount(5);
});

test('the controls of the list and the headings of the tiles explain themselves on hover', async ({ page }) => {
  await pair(page);
  const tip = page.locator('#hint-tip');
  await page.getByRole('heading', { name: 'Next task', exact: true }).hover();
  await expect(tip).toHaveText(/the engine would take next/);
  await showList(page);
  // A control that sits in the kit (the area filter) is explained by the span around it.
  const areas = page.getByRole('button', { name: /^Areas/ });
  await areas.hover();
  await expect(tip).toHaveText(/folders of the vault/);
  // A screen reader hears it with the button itself, and the keyboard gets the same popup.
  await expect(areas).toHaveAccessibleDescription(/folders of the vault/);
  await areas.focus();
  await expect(tip).toHaveText(/folders of the vault/);
  const pairs = [
    [page.locator('input[type="search"]').first(), /words of their title or id/],
    [page.locator('.count [role="status"]'), /How many tasks the filters leave/],
    [page.locator('label.sort'), /order of the list/],
    [page.locator('summary', { hasText: 'More filters' }), /narrow the list/],
    [page.getByRole('button', { name: 'Mark all shown' }), /Mark every task shown/],
  ] as const;
  for (const [element, words] of pairs) {
    await page.mouse.move(0, 400);
    await element.hover();
    await expect(tip).toHaveText(words);
  }
});

test('the menus are Tasks, Project, View, Options and Help, with sections and the shortcuts of the keys', async ({ page }) => {
  await pair(page);
  await showList(page);
  const bar = page.getByRole('menubar').getByRole('menuitem');
  await expect(bar).toHaveText(['Tasks', 'Project', 'View', 'Options', 'Help']);

  // Tasks: sections, shortcuts as the keys have them, and the actions work.
  await page.getByRole('menuitem', { name: 'Tasks', exact: true }).click();
  const menu = page.getByRole('menu');
  for (const heading of ['Create', 'Find', 'Edit']) await expect(menu.getByText(heading, { exact: true })).toBeVisible();
  await expect(menu.getByRole('menuitem', { name: /New task/ })).toHaveAttribute('aria-keyshortcuts', 'C');
  await expect(menu.getByRole('menuitem', { name: /Find a task/ })).toHaveAttribute('aria-keyshortcuts', '/');
  await expect(menu.getByRole('menuitem', { name: /Command palette/ })).toHaveAttribute('aria-keyshortcuts', 'Control+K');
  // Nothing is selected yet: there is no ID to copy.
  await expect(menu.getByRole('menuitem', { name: /Copy the ID/ })).toBeDisabled();
  await menu.getByRole('menuitem', { name: /Find a task/ }).click();
  await expect(page.locator('input[type="search"], input[role="searchbox"]').first()).toBeFocused();

  // A task that is selected can have its ID copied.
  await page.locator('button.row').first().click();
  await page.getByRole('menuitem', { name: 'Tasks', exact: true }).click();
  await expect(page.getByRole('menuitem', { name: /Copy the ID/ })).toBeEnabled();
  await page.getByRole('menuitem', { name: /Copy the ID/ }).click();
  await expect(page.getByRole('status').getByText(/Task ID copied|clipboard is not available/)).toBeVisible();

  // Project: the vault section tells which vault and how big it is, and the old Vaults menu is gone.
  await page.getByRole('menuitem', { name: 'Project', exact: true }).click();
  const project = page.getByRole('menu');
  // The hint of the menu does not lie over its first items while it is open.
  await page.waitForTimeout(600);
  await expect(page.locator('#hint-tip')).toBeHidden();
  await expect(project.getByText('Vault', { exact: true })).toBeVisible();
  await expect(project.getByText(/\d+ areas, \d+ tasks/)).toBeVisible();
  await expect(project.getByRole('menuitem', { name: 'Read the vault again' })).toBeVisible();
  await page.keyboard.press('Escape');

  // View holds the theme, Options the language.
  await page.getByRole('menuitem', { name: 'View', exact: true }).click();
  await expect(page.getByRole('menuitemradio', { name: 'Dark' })).toBeVisible();
  await page.keyboard.press('Escape');
  await page.getByRole('menuitem', { name: 'Options', exact: true }).click();
  await expect(page.getByRole('menuitemradio', { name: 'Deutsch' })).toBeVisible();
  await expect(page.getByRole('menuitemradio', { name: 'Dark' })).toHaveCount(0);
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
  await expect(page.getByRole('menuitem', { name: 'Options' })).toBeFocused();
  await page.keyboard.press('ArrowRight');
  await expect(page.getByRole('menuitem', { name: 'Help' })).toBeFocused();

  expect(await violations(page)).toEqual([]);
  await page.getByRole('menuitem', { name: 'View', exact: true }).click();
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
  // A name of its own for each repeat (--repeat-each with the one worker shares the vault), of a fixed width: no
  // repeat's id is a part of another's.
  const tag = `r${String(test.info().repeatEachIndex).padStart(3, '0')}t${test.info().retry}`;
  const slug = `inbox-e2e-${tag}`;
  for (const n of [1, 2, 3]) await capture(page, `Inbox e2e ${tag} ${n}`);
  // g i opens the inbox: the new tasks lack everything.
  await page.keyboard.press('g');
  await page.keyboard.press('i');
  const inbox = page.locator('section.inbox');
  await expect(inbox).toBeVisible();
  for (const n of [1, 2, 3]) {
    await expect(inbox.locator('.row', { hasText: `${slug}-${n}` })).toContainText(/no priority.*no effort.*no who/);
  }
  await expectAccessible(page, 'inbox');
  const toast = page.getByRole('status');
  for (const n of [1, 2, 3]) {
    const row = inbox.locator('.row', { hasText: `lib.nvim/${slug}-${n}` });
    await row.click();
    await expect(page.locator('aside.detail .id')).toHaveText(`lib.nvim/${slug}-${n}`);
    // Priority, effort and who, each with one key; the row loses a chip after each, and leaves with the last. The hub's
    // event can show a change before the answer of its write is there: the next key waits until no write is on its way
    // (a key pressed meanwhile is refused with "Still saving", and the "Saved" of the step before would still be seen).
    await page.keyboard.press('2');
    await expect(toast.getByText('Saved')).toBeVisible();
    await expect(row).not.toContainText('no priority');
    await settled(page);
    await page.keyboard.press(n === 3 ? 'Shift+f' : 's');
    await expect(row).not.toContainText('no effort');
    await settled(page);
    await page.keyboard.press(n === 2 ? 'p' : 'm');
    await expect(row).toHaveCount(0);
    await settled(page);
  }
  // What the keys wrote is in the files.
  const text = (n: number) => readFileSync(join(state().vault, 'lib.nvim', 'ROADMAP', 'tasks', `${slug}-${n}.md`), 'utf8');
  expect(text(1)).toMatch(/prio: 2[\s\S]*effort: S[\s\S]*actor: me/);
  expect(text(2)).toMatch(/actor: pair/);
  expect(text(3)).toMatch(/effort: XL/);
  // u takes the last one back: the task is in the inbox again, without a who.
  await page.keyboard.press('u');
  await expect(toast.getByText('Undone.')).toBeVisible();
  await expect(inbox.locator('.row', { hasText: `lib.nvim/${slug}-3` })).toContainText('no who');
  expect(consoleProblems.get(page)).toEqual([]);
});

test('ten tasks are sorted in the inbox with the keyboard alone, from the search to the last key', async ({ page }) => {
  // Acceptance of P5: ten tasks triaged with the keyboard only (the list is opened with the menu; from the search on
  // there is no click and no pointer).
  const slugs = Array.from({ length: 10 }, (_, i) => `kbd-triage-e2e-${String(i).padStart(2, '0')}`);
  const file = (slug: string) => join(state().vault, 'lib.nvim', 'ROADMAP', 'tasks', `${slug}.md`);
  for (const slug of slugs) {
    writeFileSync(file(slug), `---\ntitle: Keyboard triage ${slug}\nstatus: open\nkind: task\n---\n\nUnsorted.\n`);
  }
  await watchViolations(page);
  await pair(page);
  await showList(page);
  // The search narrows the inbox too: '/' goes to the box, Tab leaves it, g i opens the inbox.
  await page.keyboard.press('/');
  await expect(page.getByRole('searchbox', { name: /search/i }).first()).toBeFocused();
  await page.keyboard.type('kbd-triage-e2e');
  await page.keyboard.press('Tab');
  await page.keyboard.press('g');
  await page.keyboard.press('i');
  const inbox = page.locator('section.inbox');
  await expect(inbox.locator('.row')).toHaveCount(10, { timeout: WRITE_BUDGET });
  await expectAccessible(page, 'the inbox narrowed by the search');
  // The inbox selects its first row; j and k move. Its first read of a task may wait behind the engine on a busy
  // machine (seen locally under load: more than the 5 s of an expect).
  await expect(page.locator('aside.detail .id')).toHaveText(`lib.nvim/${slugs[0]}`, { timeout: WRITE_BUDGET });
  await page.keyboard.press('j');
  await expect(page.locator('aside.detail .id')).toHaveText(`lib.nvim/${slugs[1]}`);
  await page.keyboard.press('k');
  await expect(page.locator('aside.detail .id')).toHaveText(`lib.nvim/${slugs[0]}`);
  // Each task: a priority, an effort and a who, one key each; with the last it leaves and the next takes its place.
  const prio = ['1', '2', '3'];
  const effort = ['a', 's', 'd', 'f'];
  const who = ['m', 'p', 'i'];
  for (const [n, slug] of slugs.entries()) {
    await expect(page.locator('aside.detail .id')).toHaveText(`lib.nvim/${slug}`);
    const keys = [prio[n % 3], effort[n % 4], who[n % 3]] as string[];
    for (const [k, key] of keys.entries()) {
      if (n === slugs.length - 1 && k === keys.length - 1) {
        // The last key empties the inbox: no detail is left to tell that the page settled, the answer does.
        const answer = nextAnswer(page);
        await page.keyboard.press(key);
        await answer;
      } else {
        await write(page, () => page.keyboard.press(key));
      }
    }
    await expect(inbox.locator('.row', { hasText: slug })).toHaveCount(0);
  }
  await expect(inbox.locator('.row')).toHaveCount(0);
  for (const [n, slug] of slugs.entries()) {
    const text = readFileSync(file(slug), 'utf8');
    expect(text, slug).toMatch(new RegExp(`^prio: ${n % 3 + 1}$`, 'm'));
    expect(text, slug).toMatch(new RegExp(`^effort: ${['XS', 'S', 'M', 'L'][n % 4]}$`, 'm'));
    expect(text, slug).toMatch(new RegExp(`^actor: ${['me', 'pair', 'cdx'][n % 3]}$`, 'm'));
  }
  expect(await violations(page)).toEqual([]);
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
  // The parts of the graph explain themselves (hover): the direction, the count, the status tag and the waits line.
  const tip = page.locator('#hint-tip');
  await graph.getByRole('button', { name: 'Unlocks' }).hover();
  await expect(tip).toContainText('The tasks that wait for this one');
  await page.mouse.move(0, 0);
  await expect(tip).toBeHidden();
  await graph.getByRole('status').locator('.count').hover();
  await expect(tip).toContainText('How many tasks are in this chain');
  // The popup may lie over the next element: the pointer leaves first (Escape would close the panel).
  await page.mouse.move(0, 0);
  await expect(tip).toBeHidden();
  await nodes.nth(0).locator('.waits').hover();
  await expect(tip).toContainText('The tasks of this list that this line waits for');
  await page.mouse.move(0, 0);
  await expect(tip).toBeHidden();
  await nodes.nth(1).locator('.tag').first().hover();
  await expect(tip).not.toBeEmpty();
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
  // The codes are explained with the keyboard too: one info button names every code that is listed, each with its rule.
  const codesInfo = dialog.getByRole('button', { name: /Explanation/ });
  await codesInfo.focus();
  await expect(page.locator('#hint-tip')).toContainText(/bad-[a-z-]+: /);
  await expect(codesInfo).toHaveAccessibleDescription(/bad-[a-z-]+: /);
  // The popup of a focused control stays until the focus leaves: it would lie over the findings.
  await codesInfo.blur();
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
  // A name of its own for each repeat, of a fixed width (as in the test of the single keys).
  const tag = `r${String(test.info().repeatEachIndex).padStart(3, '0')}t${test.info().retry}`;
  for (const n of [1, 2]) await capture(page, `Inbox keys ${tag} ${n}`);
  await page.keyboard.press('g');
  await page.keyboard.press('i');
  const inbox = page.locator('section.inbox');
  await expect(inbox).toBeVisible();
  const writes: string[] = [];
  page.on('request', (r) => {
    if (r.url().includes('/api/tasks/ops') && r.method() === 'POST') writes.push(r.url());
  });
  const row = inbox.locator('.row', { hasText: `lib.nvim/inbox-keys-${tag}-1` });
  await row.click();
  await expect(page.locator('aside.detail .id')).toHaveText(`lib.nvim/inbox-keys-${tag}-1`);
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
  // A key while the write is on its way is refused aloud (not kept for later): the card stays where it is.
  await page.keyboard.press('Shift+H');
  await expect(page.getByRole('alert').getByText('Still saving - try again in a moment.')).toBeVisible();
  release();
  await answer;
  await settled(page);
  await expect(column('decision').locator('.card', { hasText: name })).toHaveCount(1);
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

test('connections: the net of the areas beside the matrix, its lines by key, the number on each line', async ({ page }) => {
  await watchViolations(page);
  await pair(page);
  await chooseView(page, 'View', 'Connections');
  const net = page.getByRole('group', { name: 'The net of the areas: a line per pair, its number of links on it' });
  await expect(net).toBeVisible();
  // The line of the pair says what the cell of the matrix says, and carries the number (not colour alone).
  const line = net.getByRole('button', { name: 'Line cascade.nvim to lib.nvim: 2 links, open the list' });
  await expect(line).toBeVisible();
  await expect(line.locator('text')).toHaveText('2');
  // The names of the areas stand inside the drawing, not over the matrix beside it.
  const matrix = (await page.locator('#cross-matrix-title ~ .side .scroll').boundingBox())!;
  await expect
    .poll(async () => {
      const svg = (await net.boundingBox())!;
      const names = await net.locator('.node text').evaluateAll((els) => els.map((e) => e.getBoundingClientRect().toJSON() as DOMRect));
      return names.every((n) => n.left >= svg.x - 0.5 && n.right <= svg.x + svg.width + 0.5 && (n.left >= matrix.x + matrix.width || n.right <= matrix.x));
    })
    .toBe(true);
  await expectAccessible(page, 'the net of the areas');
  // By key: the line takes the focus, Enter opens the pair and the focus goes to it.
  const row = page.locator('.pairs > li', { hasText: 'cascade.nvim ↔ lib.nvim' });
  await line.focus();
  await page.keyboard.press('Enter');
  await expect(row.getByText('waits for')).toBeVisible();
  await expect(row.locator('summary')).toBeFocused();
  expect(await violations(page)).toEqual([]);
});

test('a view grouped by whether a task connects areas: the engine takes it, the tasks the links name are in their group', async ({ page }) => {
  await pair(page);
  const make = page.getByRole('button', { name: 'New view' });
  await openViewsByKey(page, make);
  await make.click();
  const form = page.getByRole('form', { name: 'New view' });
  await form.getByLabel('Name').fill('E2e cross v001');
  await form.getByLabel('Kept in area').selectOption('lib.nvim');
  await form.getByLabel('Group by').selectOption({ label: 'Connects areas' });
  await form.getByLabel('Take the filter of the list').uncheck();
  await write(page, () => form.getByRole('button', { name: 'Create view' }).click());
  const file = viewFile('lib.nvim', 'E2e cross v001')!;
  expect(readFileSync(file, 'utf8')).toContain('group_by: cross');
  const open = page.getByRole('region', { name: 'E2e cross v001', exact: true });
  // cascade.nvim/theta names lib.nvim in a ref: it touches two areas; lib.nvim/beta touches only its own.
  await expect(open.locator('section[data-group="several"] [data-view-item="cascade.nvim/theta"]')).toBeVisible();
  await expect(open.locator('section[data-group="one"] [data-view-item="lib.nvim/beta"]')).toBeVisible();
  await expect(open.locator('section[data-group="several"] h3')).toContainText('touches several areas');
  // Read only: no grip, no keys that write.
  await expect(open.locator('section[data-group="one"] .grip')).toHaveCount(0);
  await expectAccessible(page, 'a view grouped by connection');
  // Leave the vault as the other tests know it.
  const gone = nextAnswer(page);
  await page.getByRole('button', { name: 'Delete view' }).click();
  await gone;
});

test('a view file that comes from outside (a pull) is in the views without a reload, changed and gone again', async ({ page }) => {
  await pair(page);
  const make = page.getByRole('button', { name: 'New view' });
  await openViewsByKey(page, make);
  const choose = page.getByRole('combobox', { name: /^Saved view/ });
  await expect(choose).toBeVisible();
  const dir = join(state().vault, 'lib.nvim', 'ROADMAP', 'views');
  const file = join(dir, 'e2e-pulled-v001.md');
  const text = (title: string) => `---\ntitle: ${title}\ndisplay: columns\ngroup_by: status\n---\n`;
  mkdirSync(dir, { recursive: true });
  try {
    // The hub reads the vault by itself only every 45 s: what comes sooner came by the watcher and the event.
    writeFileSync(file, text('E2e pulled v001'));
    await expect(choose.locator('option', { hasText: 'E2e pulled v001' })).toHaveCount(1, { timeout: WRITE_BUDGET });
    writeFileSync(file, text('E2e pulled v001 renamed'));
    await expect(choose.locator('option', { hasText: 'E2e pulled v001 renamed' })).toHaveCount(1, { timeout: WRITE_BUDGET });
    removeFile(file);
    await expect(choose.locator('option', { hasText: 'E2e pulled v001' })).toHaveCount(0, { timeout: WRITE_BUDGET });
  } finally {
    removeFile(file);
  }
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
  // The info buttons of the closed dialogs are in the page too: only the ones of the view count here.
  const info = page.locator('main .info').last();
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

/** The stages of `tasks plan` of the engine on the vault of the tests: per stage (`-`: none) its ids in plan order. */
function enginePlan(): { stage: string; ids: string[] }[] {
  const engine = process.env.TASKS_ENGINE_DIR;
  if (!engine) throw new Error('TASKS_ENGINE_DIR is not set');
  const tsv = execFileSync(
    'nvim',
    ['--headless', '-u', 'NONE', '-l', join(engine, 'scripts', 'tasks.lua'), 'plan', '--format=tsv', `--vault=${state().vault}`],
    { encoding: 'utf8' },
  );
  const out: { stage: string; ids: string[] }[] = [];
  for (const line of tsv.split(/\r?\n/)) {
    const [stage, id] = line.split('\t');
    if (!stage || !id) continue;
    const last = out[out.length - 1];
    if (last?.stage === stage) last.ids.push(id);
    else out.push({ stage, ids: [id] });
  }
  return out;
}

test('the plan view lists the stages as `tasks plan` of the engine does, in its order, and the stages add up to the counters', async ({
  page,
}) => {
  await watchViolations(page);
  await pair(page);
  await chooseView(page, 'View', 'Plan');
  const stages = page.getByRole('region', { name: 'Stages' });
  await expect(stages.locator('.stage').first()).toBeVisible();
  /** Per stage of the page: its number (`-`: none), the ids drawn, the total its heading names. */
  const shown = () =>
    stages.locator('.stage').evaluateAll((cards) =>
      cards.map((card) => {
        const heading = card.querySelector('h2')?.textContent ?? '';
        return {
          stage: /(\d+)/.exec(heading.replace(/\(\d+\)\s*$/, ''))?.[1] ?? '-',
          ids: [...card.querySelectorAll('li[data-id]')].map((li) => li.getAttribute('data-id') ?? ''),
          total: Number(/\((\d+)\)\s*$/.exec(heading.trim())?.[1] ?? -1),
        };
      }),
    );
  // The page draws long stages in portions and reads the vault the earlier tests changed: asked until it holds still.
  const expected = enginePlan();
  await expect
    .poll(async () => (await shown()).map(({ stage, ids }) => ({ stage, ids })), { timeout: WRITE_BUDGET })
    .toEqual(expected);
  const page_ = await shown();
  for (const s of page_) expect(s.total, `stage ${s.stage}`).toBe(s.ids.length);
  // The relative criterion that holds on any vault: the stages add up to the tasks the counters of the plan count.
  const counters = await page
    .getByRole('region', { name: 'The plan in numbers' })
    .locator('.chips > .chip strong')
    .allInnerTexts();
  const counted = counters.reduce((sum, n) => sum + Number(n), 0);
  expect(page_.reduce((sum, s) => sum + s.total, 0)).toBe(counted);
  expect(counted).toBe(expected.reduce((sum, s) => sum + s.ids.length, 0));
  expect(await violations(page)).toEqual([]);
  expect(consoleProblems.get(page)).toEqual([]);
});

test('the plan view shows the stages and the critical path, and opens a task', async ({ page }) => {
  await watchViolations(page);
  await pair(page);
  await chooseView(page, 'View', 'Plan');
  await expect(page.getByRole('region', { name: 'Stages' })).toBeVisible();
  await expect(page.getByRole('heading', { name: /^Stage 0/ })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Critical path' })).toBeVisible();
  // The explanation of this view starts with the stages, and its button says so (it is not the one of the list).
  await page.getByRole('button', { name: 'Explanation: the stages and the marks of a task' }).focus();
  await expect(page.locator('#hint-tip')).toContainText('every task stands in the earliest stage it can be in');
  await page.keyboard.press('Escape');
  expect(await violations(page)).toEqual([]);

  // A task of a stage opens in a popup over the plan, not in the list: the plan stays where it is.
  const first = page.getByRole('region', { name: 'Stages' }).locator('.stage li').getByRole('button').first();
  const title = (await first.innerText()).trim();
  await first.click();
  const popup = page.getByRole('dialog', { name: 'Task' });
  await expect(popup).toBeVisible();
  await expect(popup.locator('aside.detail .task-title')).toHaveText(title);
  await expectAccessible(page, 'the plan with a task in a popup');
  await expect(page.getByRole('region', { name: 'Stages' })).toBeAttached();
  // Escape closes it and the plan is still there; "Show in the list" is the way to the list.
  await page.keyboard.press('Escape');
  await expect(popup).toHaveCount(0);
  await expect(page.getByRole('region', { name: 'Stages' })).toBeVisible();
  await first.click();
  await popup.getByRole('button', { name: 'Show in the list' }).click();
  await expect(popup).toHaveCount(0);
  await expect(page.locator('.split aside.detail .task-title')).toHaveText(title);
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

  // Every task: the cycle of two tasks outside any plan is warned of, and no hint. The warnings are folded at first.
  await expect(select).toHaveValue('');
  await page.getByRole('group', { name: 'Warnings of the plan' }).locator('summary').click();
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
    for (const file of files) removeFile(file);
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
  await page.getByRole('menuitem', { name: 'Tasks', exact: true }).click();
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

test('the marked tasks are moved to another area in one batch: a dry run first, a taken slug stays with its reason, the files and the references follow, undo brings them back', async ({
  page,
}) => {
  await watchViolations(page);
  await pair(page);
  await showList(page);
  // A name of its own for each repeat (--repeat-each with the one worker shares the vault), of a fixed width: no
  // repeat's word is a part of another's.
  const tag = `r${String(test.info().repeatEachIndex).padStart(3, '0')}t${test.info().retry}`;
  const title = `Bulk move e2e ${tag}`;
  const slug = `bulk-move-e2e-${tag}`;
  for (const n of [1, 2, 3]) await capture(page, `${title} ${n}`);
  const file = (area: string, n: number) => join(state().vault, area, 'ROADMAP', 'tasks', `${slug}-${n}.md`);
  /** The id the `after` of a file names, written as a list or as one id. */
  const afterOf = (path: string) =>
    (readFileSync(path, 'utf8').split('\n').find((line) => line.startsWith('after: ')) ?? '')
      .slice('after: '.length)
      .replace('[', '')
      .replace(']', '');
  // The first waits for the second: the reference follows the move (and comes back with the undo).
  addFrontmatter(`${slug}-1`, `after: [lib.nvim/${slug}-2]`);
  // The slug of the third is taken in the other area: it cannot go there.
  const occupant = file('cascade.nvim', 3);
  writeFileSync(occupant, readFileSync(file('lib.nvim', 3), 'utf8').replace(/^title: .*$/m, 'title: Occupant of a slug'));
  try {
    // The search finds the occupant too (by its id): four rows, three marked.
    await page.getByRole('searchbox', { name: /search/i }).first().fill(slug);
    await expect(page.locator('.rows .line')).toHaveCount(4);
    // The page holds the new version of the first file when its relation shows (the version is what is checked on writing).
    await page.locator('button.row', { hasText: `${title} 1` }).click();
    await expect(page.locator('aside.detail').getByLabel('After')).toHaveValue(new RegExp(`${slug}-2`));
    // Marked in the order 2, 1, 3: the second's move rewrites the first, so the page has to move the first before it.
    for (const n of [2, 1, 3]) await page.getByRole('checkbox', { name: `Mark lib.nvim/${slug}-${n}` }).check();
    await expect(page.getByText('3 marked')).toBeVisible();
    const bar = page.getByRole('group', { name: 'Move the marked to the area' });
    await expect(bar.getByRole('button', { name: /^Move \d/ })).toHaveCount(0);

    // The dry run: nothing is written, each task is told.
    await bar.getByRole('combobox').selectOption('cascade.nvim');
    // The region of the answer is there before the answer (a screen reader says what is put into a region that was
    // there), and empty.
    const told = page.getByRole('status', { name: 'What the moves would do' });
    await expect(told).toHaveCount(1);
    await expect(told).toBeEmpty();
    // By the keyboard, and the focus stays on the button when it turns from "Check the moves" into "Move 2".
    await bar.getByRole('button', { name: 'Check the moves' }).focus();
    await page.keyboard.press('Enter');
    await expect(bar.getByRole('button', { name: 'Move 2' })).toBeFocused();
    await expect(told).toContainText(`lib.nvim/${slug}-1 becomes cascade.nvim/${slug}-1`);
    await expect(told).toContainText(`lib.nvim/${slug}-2 becomes cascade.nvim/${slug}-2 (1 place(s) follow)`);
    await expect(told).toContainText(`lib.nvim/${slug}-3 stays: cascade.nvim/${slug}-3 is an open task already`);
    await expectAccessible(page, 'the answer of the dry run of a bulk move');
    for (const n of [1, 2, 3]) expect(existsSync(file('lib.nvim', n))).toBe(true);
    expect(existsSync(file('cascade.nvim', 1))).toBe(false);

    // The answer belongs to the version of each marked task: one that is changed meanwhile voids it.
    addFrontmatter(`${slug}-3`, 'effort: S');
    await expect(bar.getByRole('button', { name: 'Check the moves' })).toBeVisible({ timeout: 15_000 });
    await expect(told).toBeEmpty();
    // The dry run takes its time with many tasks: while it is on its way the button says so, so it is asked once.
    let delaying = true;
    await page.route('**/api/tasks/ops', async (route) => {
      if (delaying) await new Promise((resolve) => setTimeout(resolve, 1_000));
      await route.continue().catch(() => undefined);
    });
    await bar.getByRole('button', { name: 'Check the moves' }).click();
    await expect(bar.getByRole('button', { name: 'Check the moves' })).toHaveAttribute('aria-busy', 'true');
    await expect(bar.getByRole('button', { name: 'Check the moves' })).toHaveAttribute('aria-disabled', 'true');
    await expect(told).toContainText(`lib.nvim/${slug}-1 becomes cascade.nvim/${slug}-1`);
    delaying = false;

    // The move: one request, the two that can go go, the third stays marked.
    let writes = 0;
    await page.route('**/api/tasks/ops', async (route) => {
      writes += 1;
      await route.continue();
    });
    await write(page, () => bar.getByRole('button', { name: 'Move 2' }).click());
    await expect(page.getByRole('status').getByText('Moved: 2.')).toBeVisible();
    expect(writes).toBe(1);
    for (const n of [1, 2]) {
      expect(existsSync(file('lib.nvim', n))).toBe(false);
      expect(existsSync(file('cascade.nvim', n))).toBe(true);
    }
    expect(existsSync(file('lib.nvim', 3))).toBe(true);
    expect(afterOf(file('cascade.nvim', 1))).toBe(`cascade.nvim/${slug}-2`);
    // The marks and the selection follow the new ids: nothing points at an id that is gone.
    await expect(page.locator('aside.detail .id')).toHaveText(`cascade.nvim/${slug}-1`);
    await expect(page.getByText('3 marked')).toBeVisible();
    await expect(page.getByRole('checkbox', { name: `Mark cascade.nvim/${slug}-2` })).toBeChecked();

    // Taken back: both files and the reference where they were, the selection with them.
    await write(page, () => page.getByRole('status').getByRole('button', { name: 'Undo' }).click());
    await expect(page.getByRole('status').getByText('Undone.')).toBeVisible();
    for (const n of [1, 2]) {
      expect(existsSync(file('lib.nvim', n))).toBe(true);
      expect(existsSync(file('cascade.nvim', n))).toBe(false);
    }
    expect(afterOf(file('lib.nvim', 1))).toBe(`lib.nvim/${slug}-2`);
    await expect(page.locator('aside.detail .id')).toHaveText(`lib.nvim/${slug}-1`);
    expect(await violations(page)).toEqual([]);
    expect(consoleProblems.get(page)).toEqual([]);
  } finally {
    removeFile(occupant);
  }
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
  await page.getByRole('menuitem', { name: 'Project', exact: true }).click();
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

  // The folder that is read already is refused under another name: two names never read one folder.
  await dialog.getByLabel(/^Folder/).fill(state().vault);
  await dialog.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(page.getByRole('alert').getByText(/reads this folder already/)).toBeVisible();
  await expect(dialog.getByText('elsewhere')).toHaveCount(0);

  // A real folder of its own is added.
  const own = join(state().vault, '..', 'own-vault-e2e');
  mkdirSync(own, { recursive: true });
  await dialog.getByLabel(/^Folder/).fill(own);
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
  // The refused folders are 400s the browser logs by itself; nothing else may be there.
  expect((consoleProblems.get(page) ?? []).filter((m) => !m.includes('status of 400'))).toEqual([]);
});

test('a new vault is made from an empty folder and added, and the folder of the vault is shown in the file manager', async ({ page }) => {
  await watchViolations(page);
  await pair(page);
  await showList(page);
  const fresh = join(state().vault, '..', 'new-vault-e2e');
  removeFile(fresh);
  const log = join(state().config, '..', 'editor.log');
  const shown = (): string[] => (existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter((l) => l.startsWith('reveal ')) : []);
  const before = shown().length;

  await page.getByRole('menuitem', { name: 'Project', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Show vault folder' }).click();
  await expect.poll(() => shown().length).toBe(before + 1);

  await page.getByRole('menuitem', { name: 'Project', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Manage vaults ...' }).click();
  const dialog = page.getByRole('dialog', { name: 'Vaults' });
  await dialog.getByLabel(/^Name/).fill('brand-new');
  await dialog.getByLabel(/^Folder/).fill(fresh);
  await dialog.getByRole('checkbox', { name: /Make this folder a new vault/ }).check();
  await expect(dialog.getByRole('button', { name: 'Make and add' })).toBeDisabled();
  await dialog.getByLabel(/^First area/).fill('first.nvim');
  await expectAccessible(page, 'the vaults dialog with the new vault form');
  await dialog.getByRole('button', { name: 'Make and add' }).click();
  await expect(page.getByRole('status').getByText('Vault made and added.')).toBeVisible();
  await expect(dialog.getByText('brand-new')).toBeVisible();
  expect(existsSync(join(fresh, 'first.nvim', 'ROADMAP', 'tasks'))).toBe(true);

  // A folder that has something in it is refused in the words of the hub, and nothing is added.
  await dialog.getByLabel(/^Name/).fill('twice');
  await dialog.getByLabel(/^Folder/).fill(fresh);
  await dialog.getByRole('checkbox', { name: /Make this folder a new vault/ }).check();
  await dialog.getByLabel(/^First area/).fill('other.nvim');
  await dialog.getByRole('button', { name: 'Make and add' }).click();
  await expect(page.getByRole('alert').getByText(/folder is not empty/)).toBeVisible();
  await expect(dialog.getByText('twice')).toHaveCount(0);
  expect(existsSync(join(fresh, 'other.nvim'))).toBe(false);

  await dialog.getByRole('button', { name: 'Forget: brand-new' }).click();
  await expect(dialog.getByText('brand-new')).toHaveCount(0);
  await dialog.getByRole('button', { name: 'Close' }).click();
  removeFile(fresh);
  expect(await violations(page)).toEqual([]);
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

  await page.getByRole('menuitem', { name: 'Project', exact: true }).click();
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
  await page.getByRole('menuitem', { name: 'Project', exact: true }).click();
  await expect(page.getByRole('menuitemradio', { name: /^second/ })).toHaveAttribute('aria-checked', 'true');

  // And back: the first vault is the one that is read again, with its tasks.
  await page.getByRole('menuitemradio').first().click();
  await expect(page.getByRole('menubar')).toBeVisible();
  await showList(page);
  await expect(page.locator('button.row', { hasText: /lib\.nvim\/alpha(?![-\w])/ })).toBeVisible();
  await expect(page.locator('button.row', { hasText: 'solo.nvim/solo-task' })).toHaveCount(0);

  // A vault that was chosen is not forgotten while it is read; the other goes.
  await page.getByRole('menuitem', { name: 'Project', exact: true }).click();
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

  // A task of the list opens in a popup over the overview, selected: the overview stays where it is.
  const first = doing.locator('li').first();
  const id = (await first.locator('code').innerText()).trim();
  await first.locator('button.link').click();
  const popup = page.getByRole('dialog', { name: 'Task' });
  await expect(popup.locator('aside.detail .id')).toHaveText(id);
  await expectAccessible(page, 'the overview with a task in a popup');
  await page.keyboard.press('Escape');
  await expect(popup).toHaveCount(0);
  await expect(doing).toBeVisible();
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
  removeFile(log);

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

test('a filter that is emptied leaves the page where it was: the selected row far down does not pull it away', async ({ page }) => {
  // 320 files, the engine's scan of them and axe over the whole list: more than the 30 s of a test on a busy runner.
  test.slow();
  // More than three hundred tasks, of a name of its own for each repeat and retry; they go again at the end (other
  // tests count). One of them has a word in its text only, for the hits of the text search.
  const info = test.info();
  const tag = `r${String(info.repeatEachIndex).padStart(3, '0')}t${info.retry}`;
  const word = `zebrajump${tag}`;
  const files = Array.from({ length: 320 }, (_, i) => {
    const n = String(i).padStart(3, '0');
    const path = join(state().vault, 'lib.nvim', 'ROADMAP', 'tasks', `jump-e2e-${tag}-${n}.md`);
    const text = n === '250' ? `Text with ${word}.` : 'Text.';
    writeFileSync(path, `---\ntitle: Jump e2e ${tag} ${n}\nstatus: open\nkind: task\n---\n\n${text}\n`);
    return path;
  });
  try {
    await watchViolations(page);
    await pair(page);
    await showList(page);
    const box = page.getByRole('searchbox', { name: /search/i }).first();
    await expect(async () => {
      await box.fill(`Jump e2e ${tag}`);
      await expect(page.locator('.rows .line')).toHaveCount(320, { timeout: 2000 });
    }).toPass({ timeout: WRITE_BUDGET });
    // One task far down the list, chosen in the narrowed list; then the search is emptied by the keyboard.
    await box.fill(`Jump e2e ${tag} 300`);
    await expect(page.locator('.rows .line')).toHaveCount(1);
    await page.locator('button.row', { hasText: `jump-e2e-${tag}-300` }).click();
    await expect(page.locator('aside.detail .id')).toHaveText(`lib.nvim/jump-e2e-${tag}-300`);
    await page.evaluate(() => window.scrollTo(0, 0));
    await box.focus();
    await page.keyboard.press('Control+a');
    await page.keyboard.press('Backspace');
    await expect(page.locator('.rows .line').nth(320)).toBeAttached();
    // Frames in which the rows are drawn: the page did not move, the field keeps the focus and is in view.
    await page.waitForTimeout(500);
    expect(await page.evaluate(() => window.scrollY)).toBe(0);
    await expect(box).toBeFocused();
    await expect(box).toBeInViewport();
    // The selection is kept, and j still brings its row into view.
    await expect(page.locator('aside.detail .id')).toHaveText(`lib.nvim/jump-e2e-${tag}-300`);
    await page.locator('button.row[aria-current="true"]').focus();
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.keyboard.press('j');
    await expect(page.locator('button.row[aria-current="true"]')).toBeInViewport();
    expect(await page.evaluate(() => window.scrollY)).toBeGreaterThan(0);
    await expectAccessible(page, 'the full list after a filter was emptied');

    // A hit of the text search is no row of the list: chosen there, it must not pull the page down once the search is
    // emptied and its row is drawn far below.
    await expect(async () => {
      await box.fill(word);
      await expect(page.locator('button.hit', { hasText: `jump-e2e-${tag}-250` })).toBeVisible({ timeout: 2000 });
    }).toPass({ timeout: WRITE_BUDGET });
    await page.locator('button.hit', { hasText: `jump-e2e-${tag}-250` }).click();
    await expect(page.locator('aside.detail .id')).toHaveText(`lib.nvim/jump-e2e-${tag}-250`);
    await page.evaluate(() => window.scrollTo(0, 0));
    await box.focus();
    await page.keyboard.press('Control+a');
    await page.keyboard.press('Backspace');
    await expect(page.locator('.rows .line').nth(320)).toBeAttached();
    await page.waitForTimeout(500);
    expect(await page.evaluate(() => window.scrollY)).toBe(0);
    await expect(box).toBeInViewport();

    // The inbox the same way: the 320 lack everything, so emptying the search brings them all back into it.
    await box.fill(`Jump e2e ${tag} 310`);
    await page.keyboard.press('Tab');
    await page.keyboard.press('g');
    await page.keyboard.press('i');
    const inbox = page.locator('section.inbox');
    await expect(inbox.locator('.row')).toHaveCount(1);
    await inbox.locator('.row', { hasText: `jump-e2e-${tag}-310` }).click();
    await expect(page.locator('aside.detail .id')).toHaveText(`lib.nvim/jump-e2e-${tag}-310`);
    // The inbox has no search box: the search is switched off with its chip, by the keyboard, and the focus stays on
    // the chips.
    await page.evaluate(() => window.scrollTo(0, 0));
    const chip = page.getByRole('button', { name: `Switch off: Search: Jump e2e ${tag} 310` });
    await chip.focus();
    await page.keyboard.press('Enter');
    await expect(inbox.locator('.row').nth(100)).toBeAttached();
    await page.waitForTimeout(500);
    // The note goes with its last chip and the focus with it to the main region (a shift of a line or two); the row of
    // the selected task far down is not brought into view.
    expect(await page.evaluate(() => window.scrollY)).toBeLessThan(200);
    await expect(inbox.locator('.row', { hasText: `jump-e2e-${tag}-310` })).not.toBeInViewport();

    // The board is drawn again for every change of the vault: a card chosen far down stays where it is when a file
    // changes elsewhere, and the page stays at the top.
    await page.keyboard.press('g');
    await page.keyboard.press('b');
    const cards = page.locator('.board [data-column="open"] .card');
    await expect(cards.nth(40)).toBeAttached();
    await cards.nth(40).click();
    await page.evaluate(() => window.scrollTo(0, 0));
    await expect(page.locator('.board [aria-current="true"]')).not.toBeInViewport();
    const events = page.waitForResponse((r) => new URL(r.url()).pathname === '/api/tasks/snapshot', { timeout: WRITE_BUDGET });
    writeFileSync(files[0]!, readFileSync(files[0]!, 'utf8').replace('Text.', 'Text, changed elsewhere.'));
    await events;
    await page.waitForTimeout(500);
    expect(await page.evaluate(() => window.scrollY)).toBe(0);
  } finally {
    for (const file of files) removeFile(file);
    // The hub has let them go before the next test counts its rows (not asked when the test ended by its timeout:
    // the page is gone then, and the error of the test is the one to see).
    if (!page.isClosed()) await expect
      .poll(
        () =>
          page.evaluate(async (prefix) => {
            const token = sessionStorage.getItem('tasks-desktop.session');
            const r = await fetch('/api/tasks/snapshot', { headers: { authorization: `Bearer ${token}` } });
            const doc = (await r.json()) as { tasks: { id: string }[] };
            return doc.tasks.filter((t) => t.id.startsWith(prefix)).length;
          }, `lib.nvim/jump-e2e-${tag}-`),
        { timeout: WRITE_BUDGET },
      )
      .toBe(0);
  }
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
    for (const file of files) removeFile(file);
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
    if (indexText === null) removeFile(indexFile);
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

test('the strip of the filter: switching off a chip puts the focus on the next chip, also behind the search chip, and "Change it in the list" keeps it on the page', async ({
  page,
}) => {
  await watchViolations(page);
  await pair(page);
  await showList(page);
  await page.getByRole('searchbox').fill('zzqq-no-task-has-this');
  await page.getByText('More filters', { exact: false }).first().click();
  const prioMin = page.locator('select[data-range="prio-min"]');
  const options = await prioMin.locator('option').evaluateAll((os) => os.map((o) => (o as HTMLOptionElement).value).filter((v) => v !== ''));
  expect(options.length).toBeGreaterThan(0);
  await prioMin.selectOption(options[options.length - 1]!);
  await page.locator('input[data-date="updated-from"]').fill('2999-01-01');

  await chooseView(page, 'View', 'Inbox');
  const note = page.getByTestId('filter-note');
  // The chip of the search comes first; the buttons of the other two are the ones counted here.
  const chips = note.getByRole('button', { name: /^Switch off: (?!Search)/ });
  await expect(chips).toHaveCount(2);
  await chips.first().click();
  await expect(chips).toHaveCount(1);
  // The focus is on the chip that took the place, not on the search chip in front of it and not on the page.
  await expect(chips.first()).toBeFocused();

  await note.getByRole('button', { name: 'Change it in the list' }).click();
  await expect(page.locator('main')).toBeFocused();
  expect(await violations(page)).toEqual([]);
  expect(consoleProblems.get(page)).toEqual([]);
});

test('the filter has at least / at most and spans of days, outlives a reload, and narrows every view', async ({ page }) => {
  await watchViolations(page);
  await pair(page);
  await showList(page);
  const count = page.locator('p.count').first();
  const shown = async (): Promise<number> => {
    const m = /(\d+) of (\d+)/.exec((await count.textContent()) ?? '');
    if (!m) throw new Error('no count');
    return Number(m[1]);
  };
  const all = await shown();
  expect(all).toBeGreaterThan(0);

  // Words in the search box narrow the other views too, so those say so (the words are no chip of the list).
  await page.getByRole('searchbox').fill('zzqq-no-task-has-this');
  await expect.poll(shown).toBe(0);
  await chooseView(page, 'View', 'Inbox');
  await expect(page.getByTestId('filter-note')).toContainText('Search: zzqq-no-task-has-this');
  await expect(page.locator('.inbox button.row')).toHaveCount(0);
  await page.getByTestId('filter-note').getByRole('button', { name: /^Switch off: Search/ }).click();
  await expect(page.getByTestId('filter-note')).toHaveCount(0);
  await expect(page.locator('main')).toBeFocused();
  await showList(page);
  expect(await shown()).toBe(all);

  // The phase counts of a chosen plan are those of the whole plan: read now, compared once the filter is on.
  await chooseView(page, 'View', 'Plan');
  const planSelect = page.locator('label.plan-select select');
  const planIds = await planSelect.locator('option').evaluateAll((os) =>
    os.map((o) => (o as HTMLOptionElement).value).filter((v) => v !== ''),
  );
  let phasesBefore: string | null = null;
  for (const id of planIds) {
    await planSelect.selectOption(id);
    if ((await page.locator('p.phases').count()) > 0) {
      phasesBefore = await page.locator('p.phases').innerText();
      break;
    }
  }
  expect(phasesBefore, 'the fixture vault has a plan with phases').not.toBeNull();
  await planSelect.selectOption('');
  await showList(page);
  await page.getByText('More filters', { exact: false }).first().click();

  // At least: the values the tasks have, in their order; the chip names the end.
  const prioMin = page.locator('select[data-range="prio-min"]');
  const options = await prioMin.locator('option').evaluateAll((os) => os.map((o) => (o as HTMLOptionElement).value).filter((v) => v !== ''));
  expect(options.length).toBeGreaterThan(0);
  await prioMin.selectOption(options[options.length - 1]!);
  const chips = page.getByRole('list', { name: 'Filters that are on' });
  await expect(chips).toContainText(`Priority: at least P${options[options.length - 1]}`);
  await prioMin.selectOption('');
  await expect(chips).toHaveCount(0);
  expect(await shown()).toBe(all);

  // A span of days: nothing was changed after the day the fixture was written.
  await page.locator('input[data-date="updated-from"]').fill('2999-01-01');
  await expect(chips).toContainText('Changed: from 2999-01-01');
  await expect.poll(shown).toBe(0);
  await expectAccessible(page, 'the list with a span of days on');

  // The filter is remembered: after a reload it is still on.
  await page.reload();
  await expect(page.getByRole('menubar')).toBeVisible();
  await showList(page).catch(() => undefined);
  await expect(page.getByRole('list', { name: 'Filters that are on' })).toContainText('Changed: from 2999-01-01');

  // The same filter holds in the plan, the board, the inbox and the overview: each says so and shows nothing of the tasks.
  const note = page.getByTestId('filter-note');
  for (const view of ['Plan', 'Board', 'Inbox', 'Today']) {
    await chooseView(page, 'View', view);
    await expect(note).toContainText('Filter on: 0 of');
    if (view === 'Plan') {
      // The plan with phases: its counts do not follow the filter (the strip says so).
      for (const pid of planIds) {
        await planSelect.selectOption(pid);
        if ((await page.locator('p.phases').count()) > 0) break;
      }
      await expect.poll(() => page.locator('p.phases').innerText()).toBe(phasesBefore);
      await planSelect.selectOption('');
    }
    if (view === 'Plan') {
      await expect(page.locator('.stages .stage li')).toHaveCount(0);
      // The strip says what the filter does not narrow here, and the empty plan is not "no task in this plan".
      await expect(note).toContainText('It narrows the stages below and nothing else');
      await expect(page.getByText('No task of this plan matches the filter.')).toBeVisible();
    }
    if (view === 'Board') await expect(page.locator('.cards .card')).toHaveCount(0);
    if (view === 'Inbox') {
      await expect(page.locator('.inbox button.row')).toHaveCount(0);
      await expect(page.getByText('No unsorted task matches the filter.')).toBeVisible();
      await expect(page.getByText('Everything is sorted')).toHaveCount(0);
    }
    await expectAccessible(page, `the ${view} with a filter on`);
  }
  await expect(page.locator('section[data-tile="waiting"] li')).toHaveCount(0);
  // A number of the overview opened: the engine counts more than are shown, and the filter is named as the cause.
  const tiles = page.locator('button.tile');
  let opened = 0;
  for (let i = 0; i < (await tiles.count()); i += 1) {
    const m = /^\s*(\d+)/.exec(await tiles.nth(i).innerText());
    if (!m || Number(m[1]) === 0) continue;
    await tiles.nth(i).click();
    await expect(page.locator('#count-panel p[role="status"]')).toContainText(/^0 shown of \d+: the filter hides /);
    await tiles.nth(i).click();
    opened += 1;
    break;
  }
  expect(opened, 'a number of the overview is above zero').toBe(1);
  await expect(page.locator('section[data-tile="cdx"]')).toHaveCount(0);

  // Switched off in the strip of the overview, the filter is gone everywhere.
  await note.getByRole('button', { name: 'Clear all filters' }).click();
  await expect(note).toHaveCount(0);
  // The strip is gone with the button that was pressed: the focus goes to the main area, not to the page.
  await expect(page.locator('main')).toBeFocused();
  await showList(page);
  expect(await shown()).toBe(all);
  expect(await violations(page)).toEqual([]);
});

test('a task of the overview is dropped on an area: the engine is asked first, and the file moves only on the confirmation', async ({ page }) => {
  const slug = 'drop-move-e2e';
  const from = join(state().vault, 'lib.nvim', 'ROADMAP', 'tasks', `${slug}.md`);
  const to = join(state().vault, 'cascade.nvim', 'ROADMAP', 'tasks', `${slug}.md`);
  removeFile(to);
  writeFileSync(from, `---\ntitle: Dropped task e2e\nstatus: doing\nkind: task\n---\n\nTo be moved by a drop.\n`);
  await watchViolations(page);
  await pair(page);
  await chooseView(page, 'View', 'Today');
  await page.locator('button.tile[data-count="doing"]').click();
  const panel = page.getByRole('region', { name: 'doing' });
  const row = panel.locator('li', { hasText: 'Dropped task e2e' });
  await expect(row).toBeVisible();

  const drag = (): Promise<void> => dropRowOnArea(page, row, panel, 'cascade.nvim');
  await drag();

  // The engine's dry run is shown; nothing is written yet, and giving up leaves the file.
  const dialog = page.getByRole('dialog', { name: 'Move to cascade.nvim?' });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText('Dropped task e2e')).toBeVisible();
  await expect(dialog.getByRole('button', { name: /^Move \(becomes cascade\.nvim\/drop-move-e2e\)/ })).toBeEnabled();
  expect(existsSync(from)).toBe(true);
  expect(existsSync(to)).toBe(false);
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(dialog).toHaveCount(0);
  expect(existsSync(from)).toBe(true);

  // Dropped again and confirmed: the file is in the other area, the old one is gone.
  await drag();
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: /^Move \(becomes cascade\.nvim\/drop-move-e2e\)/ }).click();
  await expect.poll(() => existsSync(to)).toBe(true);
  expect(existsSync(from)).toBe(false);
  // The way back is offered, as for every write.
  await expect(page.getByRole('status').getByRole('button', { name: 'Undo' })).toBeVisible();
  expect(await violations(page)).toEqual([]);
  removeFile(to);
});

/**
 * Drag `row` onto the area `area` of the panel with the real mouse. The areas show as places to drop only once the drag
 * has begun (one turn after `dragstart`), so the target is looked for after the first moves.
 */
async function dropRowOnArea(page: Page, row: Locator, panel: Locator, area: string): Promise<void> {
  const from = (await row.locator('code').boundingBox())!;
  await page.mouse.move(from.x + 5, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(from.x + 30, from.y + from.height / 2 + 8, { steps: 3 });
  const target = panel.locator(`.target[data-area="${area}"]`);
  await expect(target, 'the areas show once the drag began').toBeVisible();
  const to = (await target.boundingBox())!;
  await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 8 });
  await page.mouse.up();
}

test('marked tasks dropped together on an area are moved in one batch, after the engine said what each one would do', async ({ page }) => {
  const slugs = ['drop-batch-e2e-1', 'drop-batch-e2e-2'];
  const where = (area: string, slug: string): string => join(state().vault, area, 'ROADMAP', 'tasks', `${slug}.md`);
  for (const slug of slugs) {
    removeFile(where('cascade.nvim', slug));
    writeFileSync(where('lib.nvim', slug), `---\ntitle: Drop batch ${slug}\nstatus: doing\nkind: task\n---\n\nTo be moved with its twin.\n`);
  }
  await watchViolations(page);
  await pair(page);
  await showList(page);
  for (const slug of slugs) await page.getByRole('checkbox', { name: `Mark lib.nvim/${slug}` }).check();
  await chooseView(page, 'View', 'Today');
  await page.locator('button.tile[data-count="doing"]').click();
  const panel = page.getByRole('region', { name: 'doing' });
  await dropRowOnArea(page, panel.locator('li', { hasText: `Drop batch ${slugs[0]}` }), panel, 'cascade.nvim');

  // One question for both, a line for each, nothing written yet.
  const dialog = page.getByRole('dialog', { name: 'Move 2 marked tasks to cascade.nvim?' });
  await expect(dialog).toBeVisible();
  for (const slug of slugs) await expect(dialog.getByText(`lib.nvim/${slug} becomes cascade.nvim/${slug}`)).toBeVisible();
  for (const slug of slugs) expect(existsSync(where('lib.nvim', slug))).toBe(true);
  await dialog.getByRole('button', { name: 'Move 2' }).click();
  await expect.poll(() => slugs.every((slug) => existsSync(where('cascade.nvim', slug)))).toBe(true);
  for (const slug of slugs) expect(existsSync(where('lib.nvim', slug))).toBe(false);
  expect(await violations(page)).toEqual([]);
  for (const slug of slugs) removeFile(where('cascade.nvim', slug));
});

test('a task of the overview is given another area with the key m and a dialog, without a mouse', async ({ page }) => {
  const slug = 'drop-key-e2e';
  const from = join(state().vault, 'lib.nvim', 'ROADMAP', 'tasks', `${slug}.md`);
  const to = join(state().vault, 'cascade.nvim', 'ROADMAP', 'tasks', `${slug}.md`);
  removeFile(to);
  writeFileSync(from, `---\ntitle: Dropped by key e2e\nstatus: doing\nkind: task\n---\n\nTo be moved by the keys.\n`);
  await watchViolations(page);
  await pair(page);
  await chooseView(page, 'View', 'Today');
  await page.locator('button.tile[data-count="doing"]').click();
  const panel = page.getByRole('region', { name: 'doing' });
  await panel.getByRole('button', { name: 'Dropped by key e2e', exact: true }).focus();
  await page.keyboard.press('m');
  const dialog = page.getByRole('dialog', { name: 'Move to another area' });
  await expect(dialog).toBeVisible();
  await dialog.getByLabel('Area').selectOption('cascade.nvim');
  await dialog.getByRole('button', { name: 'Check the move' }).click();
  const confirm = page.getByRole('dialog', { name: 'Move to cascade.nvim?' }).getByRole('button', { name: /^Move \(becomes cascade\.nvim\/drop-key-e2e\)/ });
  await expect(confirm).toBeEnabled();
  expect(existsSync(from)).toBe(true);
  await confirm.click();
  await expect.poll(() => existsSync(to)).toBe(true);
  expect(existsSync(from)).toBe(false);
  expect(await violations(page)).toEqual([]);
  removeFile(to);
});

test('the button of a row opens the same choice of an area', async ({ page }) => {
  const slug = 'drop-button-e2e';
  const from = join(state().vault, 'lib.nvim', 'ROADMAP', 'tasks', `${slug}.md`);
  writeFileSync(from, `---\ntitle: Dropped by button e2e\nstatus: doing\nkind: task\n---\n\nx\n`);
  await pair(page);
  await chooseView(page, 'View', 'Today');
  await page.locator('button.tile[data-count="doing"]').click();
  const panel = page.getByRole('region', { name: 'doing' });
  await panel.getByRole('button', { name: `Move lib.nvim/${slug} to another area` }).click();
  const dialog = page.getByRole('dialog', { name: 'Move to another area' });
  await expect(dialog).toBeVisible();
  // The area it is in is not offered; giving up changes nothing.
  await expect(dialog.getByRole('option', { name: 'lib.nvim' })).toHaveCount(0);
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(dialog).toHaveCount(0);
  expect(existsSync(from)).toBe(true);
  removeFile(from);
});

test('a filter and an order are kept under a name, brought back from the list of names, and the name outlives a reload', async ({ page }) => {
  await watchViolations(page);
  await pair(page);
  await showList(page);
  const rows = page.locator('button.row');
  const all = await rows.count();

  // A filter (status doing) and an order are made, then kept under a name.
  await page.getByRole('button', { name: /^Status(: [0-9]+)?$/ }).click();
  await page.getByRole('checkbox', { name: 'doing', exact: true }).check();
  await page.keyboard.press('Escape');
  await page.locator('select[data-sort]').selectOption('prio-effort');
  await expect.poll(() => rows.count()).toBeLessThan(all);
  const kept = await rows.count();
  await page.getByText('Save as list ...').click();
  await page.getByLabel('Name of the list').fill('E2E doing by prio');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByRole('status').getByText('List E2E doing by prio saved.')).toBeVisible();
  await expect(page.locator('select[data-lists]')).toHaveValue('mine:E2E doing by prio');

  // Everything is shown again, in the plan order; the list brings the filter and the order back.
  await page.locator('select[data-sort]').selectOption('default');
  await page.getByRole('button', { name: 'Status: doing', exact: true }).click();
  await page.getByRole('checkbox', { name: 'doing', exact: true }).uncheck();
  await page.keyboard.press('Escape');
  await expect.poll(() => rows.count()).toBe(all);
  await expect(page.locator('select[data-lists]')).toHaveValue('');
  await page.locator('select[data-lists]').selectOption({ label: 'E2E doing by prio' });
  await expect.poll(() => rows.count()).toBe(kept);
  await expect(page.locator('select[data-sort]')).toHaveValue('prio-effort');

  // The name is still there after a reload; deleting it takes it away.
  await page.reload();
  await expect(page.getByRole('menubar')).toBeVisible();
  await expect(page.locator('select[data-lists] option', { hasText: 'E2E doing by prio' })).toHaveCount(1);
  await page.locator('select[data-lists]').selectOption({ label: 'E2E doing by prio' });
  await page.getByRole('button', { name: 'Delete the list E2E doing by prio' }).click();
  await expect(page.locator('select[data-lists] option', { hasText: 'E2E doing by prio' })).toHaveCount(0);
  expect(await violations(page)).toEqual([]);
});

test('the lists of the engine are offered next to the own ones and apply what the page can say, naming the rest', async ({ page }) => {
  await watchViolations(page);
  await pair(page);
  await showList(page);
  const lists = page.locator('select[data-lists]');
  // The built-in lists of the engine are there, in a group of their own.
  const group = lists.locator('optgroup[label="From the engine"]');
  await expect(group.locator('option', { hasText: 'small-and-important' })).toHaveCount(1);
  await expect(group.locator('option', { hasText: 'quick-wins' })).toHaveCount(1);

  // One is chosen: its status, its readiness and its order are on the page; only what the page cannot say is told
  // (readiness is no longer among it: the page has the states the engine means by it).
  await lists.selectOption({ label: 'small-and-important' });
  await expect(page.locator('select[data-sort]')).toHaveValue('prio-effort');
  await expect(page.getByRole('button', { name: 'Status: 2', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Switch off: State: ready' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Switch off: State: decision' })).toBeVisible();
  await expect(page.getByRole('alert').getByText(/readiness/)).toHaveCount(0);

  // The quick wins are the engine's own figure of the snapshot: a chip, the order, and nothing told.
  const all = await page.locator('button.row').count();
  await lists.selectOption({ label: 'quick-wins' });
  await expect(page.locator('select[data-sort]')).toHaveValue('roi');
  await expect(page.getByRole('button', { name: 'Switch off: Quick wins' })).toBeVisible();
  await expect(page.getByRole('alert').getByText(/not applied/)).toHaveCount(0);
  expect(await page.locator('button.row').count()).toBeLessThanOrEqual(all);
  // It is the engine's list, not one of the page: nothing is chosen as a list of the page, and there is nothing to delete.
  await expect(lists).toHaveValue('');
  await expect(page.getByRole('button', { name: /^Delete the list/ })).toHaveCount(0);
  expect(await violations(page)).toEqual([]);
});

test('the palette offers the lists, the page\'s own and the engine\'s, and a pick shows the list', async ({ page }) => {
  await watchViolations(page);
  await pair(page);
  await chooseView(page, 'View', 'Today');
  // The engine's built-in list is there at once; a list of the page is made in the list view.
  await showList(page);
  await page.getByRole('button', { name: /^Status(: [0-9]+)?$/ }).click();
  await page.getByRole('checkbox', { name: 'doing', exact: true }).check();
  await page.keyboard.press('Escape');
  await page.getByText('Save as list ...').click();
  await page.getByLabel('Name of the list').fill('E2E palette list');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByRole('status').getByText('List E2E palette list saved.')).toBeVisible();
  await chooseView(page, 'View', 'Today');

  await page.keyboard.press('Control+k');
  const palette = page.getByRole('dialog', { name: 'Command palette' });
  await expect(palette).toBeVisible();
  await page.keyboard.type('E2E palette');
  await expect(palette.getByText('List: E2E palette list')).toBeVisible();
  await page.keyboard.press('Enter');
  await expect(palette).toHaveCount(0);
  await expect(page.locator('button.row').first()).toBeVisible();
  await expect(page.getByRole('button', { name: 'Status: doing', exact: true })).toBeVisible();

  // The engine's list by its name.
  await chooseView(page, 'View', 'Today');
  await page.keyboard.press('Control+k');
  await page.keyboard.type('quick-wins');
  await expect(palette.getByText('List of the engine: quick-wins')).toBeVisible();
  await page.keyboard.press('Enter');
  await expect(page.locator('select[data-sort]')).toHaveValue('roi');
  expect(await violations(page)).toEqual([]);

  // Taken away again.
  await page.locator('select[data-lists]').selectOption({ label: 'E2E palette list' });
  await page.getByRole('button', { name: 'Delete the list E2E palette list' }).click();
});

test.describe('a finger', () => {
  test.use({ hasTouch: true });

  test('drags a row by its grip onto an area: the engine is asked first, and giving up leaves the file', async ({ page }) => {
    const slug = 'drop-touch-e2e';
    const from = join(state().vault, 'lib.nvim', 'ROADMAP', 'tasks', `${slug}.md`);
    const to = join(state().vault, 'cascade.nvim', 'ROADMAP', 'tasks', `${slug}.md`);
    removeFile(to);
    writeFileSync(from, `---\ntitle: Dropped by finger e2e\nstatus: doing\nkind: task\n---\n\nTo be moved by a finger.\n`);
    await watchViolations(page);
    await pair(page);
    await chooseView(page, 'View', 'Today');
    await page.locator('button.tile[data-count="doing"]').click();
    const panel = page.getByRole('region', { name: 'doing' });
    const row = panel.locator('li', { hasText: 'Dropped by finger e2e' });
    await expect(row).toBeVisible();

    const cdp = await page.context().newCDPSession(page);
    const touch = (type: 'touchStart' | 'touchMove' | 'touchEnd' | 'touchCancel', at?: { x: number; y: number }) =>
      cdp.send('Input.dispatchTouchEvent', { type, touchPoints: at ? [{ x: at.x, y: at.y }] : [] });
    const centre = async (target: ReturnType<typeof page.locator>) => {
      const box = (await target.boundingBox())!;
      return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    };

    // The finger goes down on the grip, moves a little (the areas show), then over the area and up.
    const grip = await centre(row.locator('.grip'));
    await touch('touchStart', grip);
    await touch('touchMove', { x: grip.x + 8, y: grip.y + 8 });
    const target = panel.locator('.target[data-area="cascade.nvim"]');
    await expect(target, 'the areas show once the finger drags').toBeVisible();
    const over = await centre(target);
    await touch('touchMove', over);
    await expect(target).toHaveClass(/over/);
    await touch('touchEnd');

    const dialog = page.getByRole('dialog', { name: 'Move to cascade.nvim?' });
    await expect(dialog).toBeVisible();
    expect(existsSync(from)).toBe(true);
    expect(existsSync(to)).toBe(false);
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(dialog).toHaveCount(0);
    expect(existsSync(from)).toBe(true);

    // A finger that lets go anywhere else drops nothing; the areas go away.
    const again = await centre(row.locator('.grip'));
    await touch('touchStart', again);
    await touch('touchMove', { x: again.x + 8, y: again.y + 8 });
    await expect(target).toBeVisible();
    await touch('touchEnd');
    await expect(target).toHaveCount(0);
    await expect(dialog).toHaveCount(0);

    // A tap on the title still opens the task (a drag did not begin).
    await row.locator('button.link').tap();
    await expect(page.getByRole('dialog', { name: 'Task' })).toBeVisible();
    expect(await violations(page)).toEqual([]);
    removeFile(from);
  });

  test('drags a card of a view by its grip into another group, and a card of a matrix cell onto another cell', async ({ page }) => {
    const tasks = join(state().vault, 'lib.nvim', 'ROADMAP', 'tasks');
    const file = join(tasks, 'fingerview-v001.md');
    writeFileSync(file, `---\ntitle: Fingerview v001\nstatus: open\nkind: task\n---\n\nTo be moved by a finger in a view.\n`);
    await watchViolations(page);
    await pair(page);
    await showList(page);
    await page.getByRole('searchbox', { name: /search/i }).first().fill('Fingerview v001');
    await expect(page.locator('.rows .line')).toHaveCount(1);
    const make = page.getByRole('button', { name: 'New view' });
    await openViewsByKey(page, make);
    await make.click();
    const form = page.getByRole('form', { name: 'New view' });
    await form.getByLabel('Name').fill('Fingerview view v001');
    await form.getByLabel('Kept in area').selectOption('lib.nvim');
    await form.getByLabel('Group by').selectOption({ label: 'Status' });
    await write(page, () => form.getByRole('button', { name: 'Create view' }).click());
    const open = page.getByRole('region', { name: 'Fingerview view v001', exact: true });
    const card = (group: string) => open.locator(`section[data-group="${group}"] li[data-item="lib.nvim/fingerview-v001"]`);
    await expect(card('open')).toBeVisible();

    const cdp = await page.context().newCDPSession(page);
    const touch = (type: 'touchStart' | 'touchMove' | 'touchEnd' | 'touchCancel', at?: { x: number; y: number }) =>
      cdp.send('Input.dispatchTouchEvent', { type, touchPoints: at ? [{ x: at.x, y: at.y }] : [] });
    const centre = async (target: ReturnType<typeof page.locator>) => {
      const box = (await target.boundingBox())!;
      return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    };

    // A short drag drops nothing.
    const grip = await centre(card('open').locator('.grip'));
    await touch('touchStart', grip);
    await touch('touchMove', { x: grip.x + 6, y: grip.y + 6 });
    await touch('touchEnd');
    await expect(card('open')).toBeVisible();
    expect(readFileSync(file, 'utf8')).toContain('status: open');

    // Down on the grip, a little aside, then over the group "doing" and up: the status is written.
    const again = await centre(card('open').locator('.grip'));
    await touch('touchStart', again);
    await touch('touchMove', { x: again.x + 8, y: again.y + 8 });
    const doing = open.locator('section[data-group="doing"]');
    await touch('touchMove', await centre(doing.locator('h3')));
    await expect(doing).toHaveClass(/target/);
    await write(page, () => touch('touchEnd'));
    await expect.poll(() => readFileSync(file, 'utf8'), { timeout: WRITE_BUDGET }).toContain('status: doing');
    await expect(card('doing')).toBeVisible();

    // As a matrix (rows by priority): the card of the opened cell onto the cell of priority 1 - both fields are read.
    await write(page, () => open.getByLabel('Show as').selectOption({ label: 'Matrix' }));
    await write(page, () => open.getByLabel('Rows').selectOption({ label: 'Priority' }));
    await open.getByRole('button', { name: 'not set · doing: 1 task, show it' }).click();
    const item = open.locator('li:has([data-matrix-item="lib.nvim/fingerview-v001"])');
    const down = await centre(item.locator('.grip'));
    await touch('touchStart', down);
    await touch('touchMove', { x: down.x + 8, y: down.y + 8 });
    const target = open.locator(`td[data-cell='${JSON.stringify(['1', 'doing'])}']`);
    await touch('touchMove', await centre(target));
    await expect(target).toHaveClass(/target/);
    await write(page, () => touch('touchEnd'));
    await expect.poll(() => readFileSync(file, 'utf8'), { timeout: WRITE_BUDGET }).toMatch(/^prio: 1$/m);
    expect(readFileSync(file, 'utf8')).toContain('status: doing');
    expect(await violations(page)).toEqual([]);

    // Leave the vault as the other tests know it.
    const gone = nextAnswer(page);
    await page.getByRole('button', { name: 'Delete view' }).click();
    await gone;
    removeFile(file);
  });

  test('drags a card of the board by its grip into another column: the status changes, a short drag drops nothing', async ({ page }) => {
    const slug = 'board-touch-e2e';
    const file = join(state().vault, 'lib.nvim', 'ROADMAP', 'tasks', `${slug}.md`);
    writeFileSync(file, `---\ntitle: Board finger e2e\nstatus: open\nkind: task\n---\n\nTo be moved by a finger.\n`);
    await watchViolations(page);
    await pair(page);
    await showList(page);
    await page.getByRole('searchbox', { name: /search/i }).first().fill('Board finger e2e');
    await chooseView(page, 'View', 'Board');
    const column = (name: string) => page.getByRole('region', { name, exact: true });
    const card = column('open').locator('.card', { hasText: 'Board finger e2e' });
    await expect(card).toBeVisible();

    const cdp = await page.context().newCDPSession(page);
    const touch = (type: 'touchStart' | 'touchMove' | 'touchEnd' | 'touchCancel', at?: { x: number; y: number }) =>
      cdp.send('Input.dispatchTouchEvent', { type, touchPoints: at ? [{ x: at.x, y: at.y }] : [] });
    const centre = async (target: ReturnType<typeof page.locator>) => {
      const box = (await target.boundingBox())!;
      return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    };

    // A short drag (the finger hardly moves) drops nothing: the column it is over is only where the page put it.
    const grip = await centre(card.locator('.grip'));
    await touch('touchStart', grip);
    await touch('touchMove', { x: grip.x + 6, y: grip.y + 6 });
    await touch('touchEnd');
    await expect(card).toBeVisible();
    expect(readFileSync(file, 'utf8')).toContain('status: open');

    // Down on the grip, a little aside, then over the column of "doing" and up.
    const again = await centre(card.locator('.grip'));
    await touch('touchStart', again);
    await touch('touchMove', { x: again.x + 8, y: again.y + 8 });
    const doing = column('doing');
    await expect(doing).toBeVisible();
    const over = await centre(doing.locator('h2'));
    await touch('touchMove', over);
    await expect(doing).toHaveClass(/target/);
    await touch('touchEnd');
    await expect(column('doing').locator('.card', { hasText: 'Board finger e2e' })).toBeVisible({ timeout: 15_000 });
    expect(readFileSync(file, 'utf8')).toContain('status: doing');

    // A tap on the card still selects it (a drag did not begin).
    await column('doing').locator('.card', { hasText: 'Board finger e2e' }).locator('.title').tap();
    await expect(page.locator('aside.detail')).toBeVisible();
    expect(await violations(page)).toEqual([]);
    removeFile(file);
  });
});
