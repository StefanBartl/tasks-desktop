// The main flows of the page in the web variant: the same fixture vault and the same hostile documents as the hub-based
// suite (ui/e2e/app.spec.ts), the page the built file opened from disk, the engine in its worker, the folder a fake one.
// What reads and shows is here; what writes is writes.spec.ts, what keeps data in the browser is classes.spec.ts.
//
// Every test also holds the page to the two rules of the web variant: no request leaves the page, and no rule of its own
// policy (CSP) is broken.

import { expect, test, type Locator, type Page } from '@playwright/test';
import { expectAccessible } from '../e2e/a11y';
import { HOSTILE } from '../e2e/hub';
import { closeFloat, editOnDisk, openVault, vaultFiles, violations, watchPage, type Watch } from './page';

test.use({ locale: 'en-US' });

/** A YAML double-quoted string, as the hub-based suite writes the titles of its hostile tasks. */
const quoted = (title: string): string => `"${title.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;

/** The fixture vault and the hostile tasks the hub-based suite adds to lib.nvim. */
function vaultWithHostileTasks(): Record<string, string> {
  const files = vaultFiles();
  for (const h of HOSTILE) {
    files[`lib.nvim/ROADMAP/tasks/${h.slug}.md`] = [
      '---',
      `title: ${quoted(h.title)}`,
      'status: open',
      'kind: task',
      'prio: 2',
      'effort: S',
      'created: 2026-01-01',
      'updated: 2026-01-01',
      ...(h.front ?? []),
      '---',
      '',
      h.body,
      '',
    ].join('\n');
  }
  return files;
}

/** Open the page on the vault; the returned watch holds what the page must never do. */
async function start(page: Page, files: Record<string, string> = vaultWithHostileTasks()): Promise<Watch> {
  const seen = await watchPage(page);
  // The start page: the tile of the next task is there once the app has read the vault (the tasks it names depend on the vault).
  await openVault(page, files, 'Next task');
  return seen;
}

/** The same vault again after a reload (the fake folder is made anew by the page's init script). */
async function reopen(page: Page): Promise<void> {
  await page.reload();
  await page.getByRole('button', { name: /Choose folder/ }).click();
  await page.getByRole('menubar').waitFor({ timeout: 30_000 });
}

async function chooseView(page: Page, menu: string, item: string): Promise<void> {
  await closeFloat(page);
  await page.getByRole('menuitem', { name: menu, exact: true }).click();
  await page.getByRole('menuitemradio', { name: item, exact: true }).click();
}

async function showList(page: Page): Promise<void> {
  await chooseView(page, 'View', 'List');
  await expect(page.locator('button.row').first()).toBeVisible();
}

/** Open a task from the list: the detail of THIS task, read, in the float over the list (another one is closed first). */
async function open(page: Page, id: string): Promise<void> {
  const float = page.locator('dialog.peek[open]');
  await closeFloat(page);
  await page.locator('button.row', { hasText: id }).first().click();
  await expect(float).toBeVisible();
  await expect(page.locator('aside.detail .id')).toHaveText(id);
  await expect(page.locator('aside.detail .muted', { hasText: /Reading the task/ })).toHaveCount(0);
  await expect(page.locator('aside.detail .prose, aside.detail pre.body')).toBeVisible();
}

/** What every test ends with: nothing left the page, nothing of its policy was broken, nothing was said on the console. */
async function expectQuiet(page: Page, seen: Watch): Promise<void> {
  expect(seen.requests).toEqual([]);
  expect(await violations(page)).toEqual([]);
  expect(seen.errors).toEqual([]);
}

test('the start page shows the overview at the top right, tiles can be put away and brought back, and the choice stays', async ({ page }) => {
  const seen = await start(page);
  await expect(page.getByText('Next task')).toBeVisible();

  // The counts stand to the right of the work and in view without scrolling.
  const overview = page.locator('aside.overview');
  await expect(overview).toBeVisible();
  const box = await overview.boundingBox();
  const size = page.viewportSize();
  expect(box && size && box.x > size.width / 2 && box.y < size.height / 2).toBe(true);

  // A tile can be put away; it stays away after a reload (the choice is in the browser's storage, read from file://).
  await page.getByRole('button', { name: 'Hide this tile' }).first().click();
  await expect(overview).toHaveCount(0);
  await reopen(page);
  await expect(page.getByText('Next task')).toBeVisible();
  await expect(overview).toHaveCount(0);
  const hiddenTiles = page.getByRole('button', { name: /Hidden tiles \(1\)/ });
  await expect(hiddenTiles).toHaveText('1');
  await hiddenTiles.click();
  await expect(overview).toBeVisible();
  await expectQuiet(page, seen);
});

test('the list has the tasks of the vault, a task opens with its text and fields, and the selection is kept', async ({ page }) => {
  const seen = await start(page);
  await showList(page);
  // The fixture's tasks and the hostile ones added to it.
  expect(await page.locator('button.row').count()).toBeGreaterThanOrEqual(19);
  for (const id of ['lib.nvim/alpha', 'lib.nvim/beta', 'cascade.nvim/eta', 'cascade.nvim/iota']) {
    await expect(page.locator('button.row', { hasText: id }).first()).toBeVisible();
  }

  await open(page, 'lib.nvim/alpha');
  const detail = page.locator('aside.detail');
  // The title is text, whatever it holds.
  await expect(detail.locator('.task-title')).toContainText('<script>alert(1)</script> & "quotes"');
  await expect(detail.locator('.prose')).toContainText('The body of alpha.');
  await expect(detail).toContainText('lib.nvim/ROADMAP/tasks/alpha.md');
  await expect(page.locator('button.row[aria-current="true"]')).toContainText('lib.nvim/alpha');
  // The plan inside the body is read as steps.
  await expect(detail).toContainText('first');

  // Another task replaces it, and the arrow keys walk the list.
  await open(page, 'lib.nvim/beta');
  await expect(detail.locator('.task-title')).toContainText('Beta waits for alpha');
  await expect(page.locator('button.row[aria-current="true"]')).toContainText('lib.nvim/beta');
  await expectQuiet(page, seen);
});

test('a change in the folder arrives, and the selection stays', async ({ page }) => {
  const seen = await start(page);
  await showList(page);
  await open(page, 'lib.nvim/beta');
  const path = 'lib.nvim/ROADMAP/tasks/beta.md';
  const text = await page.evaluate((p) => (window as unknown as { __disk: { files(): Record<string, string> } }).__disk.files()[p], path);
  await editOnDisk(page, path, (text ?? '').replace(/^title: (.*)$/m, 'title: $1 CHANGED'));
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(page.locator('aside.detail .task-title')).toContainText('CHANGED', { timeout: 15_000 });
  await expect(page.locator('button.row[aria-current="true"]')).toContainText('lib.nvim/beta');
  await expectQuiet(page, seen);
});

test('hostile titles and bodies run nothing and become text, and nothing is requested', async ({ page }) => {
  const dialogs: string[] = [];
  page.on('dialog', (d) => {
    dialogs.push(d.message());
    void d.dismiss();
  });
  const seen = await start(page);
  await showList(page);

  // Titles with markup are rows of text.
  const row = page.locator('button.row', { hasText: 'xss-title-img' });
  await expect(row.locator('.title')).toContainText('<img src=x onerror=window.__xss=1>');
  await expect(page.locator('button.row img, button.row svg')).toHaveCount(0);

  for (const id of ['xss-title-img', 'xss-title-svg', 'xss-body-html', 'xss-body-links']) {
    await open(page, `lib.nvim/${id}`);
    await expect(page.locator('aside.detail pre, aside.detail .prose')).toBeVisible();
    // No element of the attacker's making anywhere in the page.
    await expect(page.locator('main script, main img, main iframe, main object, main embed, main svg')).toHaveCount(0);
  }
  // The links of the body: only what is allowed, with a safe rel.
  const hrefs = await page.locator('aside.detail .prose a').evaluateAll((as) => as.map((a) => [a.getAttribute('href'), a.getAttribute('rel')]));
  expect(hrefs).toEqual([['https://example.org/page', 'noopener noreferrer nofollow']]);

  // Markup in the fields around the title stays text, in every field.
  for (const id of ['xss-body-more', 'xss-frontmatter']) {
    await open(page, `lib.nvim/${id}`);
    await expect(page.locator('main script, main img, main iframe, main form, main style')).toHaveCount(0);
  }
  await open(page, 'lib.nvim/xss-frontmatter');
  await expect(page.locator('aside.detail')).toContainText('<img src=x onerror=window.__xss=19>');
  expect(await page.locator('aside.detail a').evaluateAll((as) => as.map((a) => a.getAttribute('href')))).toEqual([]);

  expect(await page.evaluate(() => (window as unknown as { __xss?: unknown }).__xss)).toBeUndefined();
  expect(dialogs).toEqual([]);
  // The image of the body points at a tracker: the page has no network, so it asks for nothing (a request would be listed).
  await expectQuiet(page, seen);
});

test('characters that hide or reverse text are shown', async ({ page }) => {
  const seen = await start(page);
  await showList(page);
  await open(page, 'lib.nvim/bidi-title');
  await expect(page.locator('aside.detail .task-title')).toContainText('⟦U+202E⟧');
  await expect(page.locator('aside.detail')).toContainText('⟦U+200B⟧');
  await expect(page.locator('aside.detail .warn')).toBeVisible();
  await expect(page.locator('aside.detail .id')).toHaveText('lib.nvim/bidi-title');
  await expectQuiet(page, seen);
});

test('the search clears with one press, and the reset of all filters takes the words away', async ({ page }) => {
  const seen = await start(page);
  await showList(page);
  const search = page.getByRole('searchbox', { name: 'Search id and title' });
  const clear = page.getByRole('button', { name: 'Clear the search' });
  const reset = page.getByRole('button', { name: 'Clear all filters' });
  const count = page.locator('p.count [role="status"]');
  await expect(count).not.toHaveText('');
  const all = await count.textContent();
  await expect(clear).toHaveCount(0);
  await expect(reset).toHaveCount(0);

  // Words narrow the list; the button in the field and the reset come with them.
  await search.fill('lib.nvim/alpha');
  await expect(count).not.toHaveText(all!);
  await expect(page.locator('button.row')).toHaveCount(2); // alpha and its twin
  await expect(clear).toBeVisible();
  await expect(reset).toBeVisible();

  // Enter on the button empties the field and the focus is back in it.
  await search.focus();
  await page.keyboard.press('Tab');
  await expect(clear).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(search).toHaveValue('');
  await expect(search).toBeFocused();
  await expect(count).toHaveText(all!);

  // The second Escape empties the field (the first closes the hint).
  await search.fill('lib.nvim/alpha');
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
  await expect(search).toHaveValue('');

  // The reset takes the words away together with a chosen area.
  await search.fill('lib.nvim/alpha');
  await page.getByRole('button', { name: /^Areas/ }).click();
  await page.getByRole('group', { name: 'Areas' }).getByRole('checkbox', { name: 'lib.nvim', exact: true }).check();
  await page.keyboard.press('Escape');
  await reset.click();
  await expect(search).toHaveValue('');
  await expect(page.locator('ul.active')).toHaveCount(0);
  await expect(count).toHaveText(all!);
  await expectQuiet(page, seen);
});

test('a word only the text of a task has finds it with the place, an area narrows the hit, and a word nobody has is said', async ({ page }) => {
  const seen = await start(page);
  await showList(page);
  const box = page.getByPlaceholder('Search id and title');
  await box.fill('tracker.invalid');
  // No title or id has the word; the texts are read once through the engine.
  const hit = page.locator('section.hits button.hit', { hasText: 'lib.nvim/xss-body-links' });
  await expect(hit).toBeVisible({ timeout: 15_000 });
  await expect(hit.locator('mark')).toContainText('tracker.invalid');
  // Text only: the match is not an element of the attacker's.
  await expect(page.locator('section.hits img, section.hits script, section.hits a')).toHaveCount(0);
  await hit.click();
  await expect(page.locator('dialog.peek[open] aside.detail .id')).toHaveText('lib.nvim/xss-body-links');
  await closeFloat(page);

  // The area that was chosen holds for the text as well; a second area added, any of them counts.
  await box.fill('tracker.invalid');
  await expect(hit).toBeVisible();
  await page.getByRole('button', { name: 'Areas' }).click();
  await page.getByRole('checkbox', { name: 'cascade.nvim' }).check();
  await expect(hit).toHaveCount(0);
  await page.getByRole('checkbox', { name: 'lib.nvim' }).check();
  await expect(hit).toBeVisible();
  await page.getByRole('button', { name: 'Clear selection' }).click();
  await page.keyboard.press('Escape');
  await expect(hit).toBeVisible();

  await box.fill('zzzqqqxxx');
  await expect(page.getByText('Nothing in the texts either.')).toBeVisible({ timeout: 10_000 });
  await expectQuiet(page, seen);
});

test('filters: a choice of several areas says how they combine and does not move, tags combine with all of them, chips say or and and', async ({ page }) => {
  const seen = await start(page);
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
  const popupAfter = await popup.boundingBox();
  expect({ x: popupAfter?.x, y: popupAfter?.y, width: popupAfter?.width }).toEqual({ x: popupBefore?.x, y: popupBefore?.y, width: popupBefore?.width });
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

  // The words are text of the chips: or within a field, and between fields.
  await page.getByRole('button', { name: /^Status/ }).first().click();
  await page.getByRole('group', { name: 'Status' }).getByRole('checkbox', { name: 'open', exact: true }).check();
  await page.keyboard.press('Escape');
  const words = (list: Locator) => list.locator('li').evaluateAll((lis) => lis.map((li) => li.querySelector('.join')?.textContent ?? ''));
  const chips = page.getByRole('list', { name: 'Filters that are on' }).first();
  await expect.poll(() => words(chips)).toEqual(['', 'or', 'and', 'and', '']);

  // What is left is the tasks that carry the tag and are open: alpha has both.
  await expect(page.locator('button.row', { hasText: 'lib.nvim/alpha' }).first()).toBeVisible();
  await expect(page.locator('button.row', { hasText: 'lib.nvim/beta' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Clear all filters' }).click();
  await expect(page.locator('ul.active')).toHaveCount(0);
  await expectQuiet(page, seen);
});

test('the plan view: the stages, the graph with an arrow for each dependency, the keys walk the tasks, and the choice stays over a reload', async ({ page }) => {
  const seen = await start(page);
  await chooseView(page, 'View', 'Plan');
  await expect(page.getByRole('region', { name: 'Stages' })).toBeVisible();
  const choice = page.getByRole('group', { name: 'Show the plan as' });
  await choice.getByRole('button', { name: 'Graph' }).click();
  await expect(choice.getByRole('button', { name: 'Graph' })).toHaveAttribute('aria-pressed', 'true');
  const graph = page.getByRole('region', { name: 'The plan as a graph' });
  await expect(graph).toBeVisible();
  const node = (id: string) => graph.locator(`[data-node="${id}"]`);

  // The fixture: beta and iota wait for alpha (blocked_by), cyc-a and cyc-b for each other.
  await expect(node('lib.nvim/alpha')).toBeVisible();
  const rowOf = async (id: string) => node(id).evaluate((el) => el.closest('[data-row]')?.getAttribute('data-row'));
  const alphaRow = Number(await rowOf('lib.nvim/alpha'));
  expect(Number(await rowOf('lib.nvim/beta'))).toBeGreaterThan(alphaRow);
  expect(Number(await rowOf('cascade.nvim/iota'))).toBeGreaterThan(alphaRow);
  expect(await rowOf('lib.nvim/cyc-a')).toBe('cycle');
  await expect(graph.locator('[data-row="cycle"]')).toContainText('lib.nvim/cyc-');
  // An arrow for each dependency, from the task waited for to the one that waits.
  await expect(graph.locator('path[data-edge="lib.nvim/alpha>lib.nvim/beta"]')).toHaveAttribute('data-kind', 'blocked_by');
  await expect(graph.locator('path[data-edge="lib.nvim/alpha>cascade.nvim/iota"]')).toHaveCount(1);

  // One tab stop; the arrow keys walk: down from alpha to a task of a later row.
  await expect(graph.locator('[data-node][tabindex="0"]')).toHaveCount(1);
  await node('lib.nvim/alpha').focus();
  await page.keyboard.press('ArrowDown');
  const below = await page.evaluate(() => document.activeElement?.closest('[data-row]')?.getAttribute('data-row'));
  expect(Number(below)).toBeGreaterThan(alphaRow);

  // The dependencies as a table, and a click opens a task.
  await graph.getByText(/^The dependencies as a list/).click();
  await expect(graph.locator('details.edges table').locator('tr', { hasText: 'Beta waits for alpha' }).first()).toContainText('hard (blocked_by)');
  await node('lib.nvim/beta').click();
  await expect(page.locator('aside.detail .id')).toHaveText('lib.nvim/beta');

  // The choice stays over a reload.
  await reopen(page);
  await chooseView(page, 'View', 'Plan');
  await expect(page.getByRole('region', { name: 'The plan as a graph' })).toBeVisible();
  await expectQuiet(page, seen);
});

test('the graph of a task lists what it needs and what waits for it, from the engine', async ({ page }) => {
  const seen = await start(page);
  await showList(page);
  await open(page, 'cascade.nvim/iota');
  await page.locator('aside.detail').getByRole('button', { name: 'What do I need for this?' }).click();
  const graph = page.locator('section.graph');
  await expect(graph).toBeVisible();
  await expect(graph.getByRole('heading', { name: 'What cascade.nvim/iota needs' })).toBeFocused();
  await expect(graph.getByRole('status')).toContainText('2 tasks');
  const nodes = graph.locator('ol.nodes > li');
  await expect(nodes).toHaveCount(2);
  await expect(nodes.nth(0)).toContainText('cascade.nvim/iota');
  await expect(nodes.nth(1)).toContainText('lib.nvim/alpha');
  await expect(nodes.nth(0)).toContainText('waits for: lib.nvim/alpha');
  // The arrow keys move between the nodes.
  await nodes.nth(0).getByRole('button').focus();
  await page.keyboard.press('ArrowDown');
  await expect(nodes.nth(1).getByRole('button')).toBeFocused();
  // The other direction: nothing waits for iota.
  await graph.getByRole('button', { name: 'Unlocks' }).click();
  await expect(graph.getByRole('status')).toContainText('1 task');
  await expectQuiet(page, seen);
});

test('the check runs as a job in the engine and its findings reach the list and the detail', async ({ page }) => {
  const seen = await start(page);
  await showList(page);
  await page.getByRole('button', { name: 'Check ...' }).click();
  const dialog = page.getByRole('dialog', { name: 'Check the vault' });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('status')).toContainText('No check has run yet.');
  await dialog.getByRole('button', { name: 'Check now' }).click();
  // The engine's findings, with the task each is about; the fixture has broken tasks.
  await expect(dialog.getByRole('status')).toContainText(/Errors: \d+, warnings: \d+, task files: \d+/, { timeout: 30_000 });
  const findings = dialog.locator('ul.findings li');
  await expect(findings.first()).toBeVisible();
  await expect(findings.filter({ hasText: 'lib.nvim/broken' }).first()).toContainText('bad-');
  // The jump goes to the task in the list, and the detail names the findings.
  await findings.filter({ hasText: 'lib.nvim/broken' }).first().getByRole('button', { name: 'lib.nvim/broken' }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.locator('aside.detail .id')).toHaveText('lib.nvim/broken');
  await expect(page.locator('aside.detail').getByRole('heading', { name: 'Findings of the check' })).toBeVisible();
  await expect(page.locator('button.row', { hasText: 'lib.nvim/broken' }).locator('.tag.bad', { hasText: '⚑' })).toBeVisible();
  await expectQuiet(page, seen);
});

test('the board shows the columns of the statuses with the tasks of the vault', async ({ page }) => {
  const seen = await start(page);
  await chooseView(page, 'View', 'Board');
  const board = page.getByRole('group', { name: 'Board' });
  await expect(board).toBeVisible();
  await expect(board.locator('.card', { hasText: 'lib.nvim/alpha' }).first()).toBeVisible();
  await expect(board.locator('.card', { hasText: 'cascade.nvim/eta' }).first()).toBeVisible();
  await expectQuiet(page, seen);
});

for (const scheme of ['light', 'dark'] as const) {
  test(`no accessibility violations in ${scheme}: today, list, detail, the plan, the board and the command palette`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: scheme });
    const seen = await start(page);
    await expect(page.getByText('Next task')).toBeVisible();
    await expect(page.locator('.tile').first()).toBeVisible();
    await expectAccessible(page, `today (${scheme})`);

    await showList(page);
    await open(page, 'lib.nvim/alpha');
    await expectAccessible(page, `the list with a task (${scheme})`);

    // Content that scrolls: a long code line and a wide table.
    await open(page, 'lib.nvim/wide-content');
    await expect(page.locator('aside.detail .prose table')).toBeVisible();
    await expectAccessible(page, `a wide table (${scheme})`);

    await chooseView(page, 'View', 'Plan');
    await expect(page.getByRole('region', { name: 'Stages' })).toBeVisible();
    await expectAccessible(page, `the plan (${scheme})`);

    await chooseView(page, 'View', 'Board');
    await expect(page.getByRole('group', { name: 'Board' })).toBeVisible();
    await expectAccessible(page, `the board (${scheme})`);
    await page.keyboard.press('Control+k');
    await expect(page.getByRole('dialog', { name: 'Command palette' })).toBeVisible();
    await expectAccessible(page, `the command palette (${scheme})`);
    await page.keyboard.press('Escape');
    await expectQuiet(page, seen);
  });
}

test('the German page has no violations either, and the name of the app stays', async ({ page }) => {
  const seen = await start(page);
  await page.getByRole('menuitem', { name: 'Options' }).click();
  await page.getByRole('menuitemradio', { name: 'Deutsch' }).click();
  await expect(page.getByRole('menuitem', { name: 'Ansicht' })).toBeVisible();
  await expect(page.locator('.kit-brand')).toHaveText('Tasks');
  await expect(page.getByRole('menubar').getByRole('menuitem')).toHaveText(['Arbeit', 'Projekt', 'Ansicht', 'Optionen', 'Hilfe']);
  await page.getByRole('menuitem', { name: 'Ansicht', exact: true }).click();
  await page.getByRole('menuitemradio', { name: 'Liste', exact: true }).click();
  await expect(page.locator('button.row').first()).toBeVisible();
  await expectAccessible(page, 'the German list');
  await expectQuiet(page, seen);
});
