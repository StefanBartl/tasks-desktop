// The data classes in the web variant (plan step 9): the `areas.json` of the folder decides which areas the page may keep
// in IndexedDB and let leave in an export, and an area it does not name decides nothing, so nothing of it is kept. The
// folder is a fake one; the page is the built file opened from disk, as for the other tests of this folder.

import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import {
  editOnDisk,
  fakePicker,
  idbWrites,
  openVault,
  sawText,
  spyOnIndexedDb,
  storedList,
  vaultFiles,
  violations,
  watchPage,
  watchText,
} from './page';

test.use({ locale: 'en-US' });

/** Words of the fixture vault that only a cascade.nvim task (or a reference to one) carries. */
const CASCADE = ['Eta tests', 'Zeta builds', 'Iota waits across areas', 'Theta was blocked', 'cascade.nvim'];

const classes = (areas: Record<string, string>, extra: Record<string, unknown> = {}): string =>
  JSON.stringify({ schema: 1, areas: Object.fromEntries(Object.entries(areas).map(([name, cls]) => [name, { class: cls }])), ...extra });

async function showList(page: Page): Promise<void> {
  await page.getByRole('menuitem', { name: /^(View|Ansicht)$/ }).click();
  await page.getByRole('menuitemradio', { name: /^(List|Liste)$/ }).click();
  await expect(page.locator('button.row').first()).toBeVisible();
}

/**
 * Ask for the list as a JSON file until the page has read the classes (the first answer is "not read yet"), and return
 * the file and the words the page said. This is also how a test knows that the page has decided what to keep: the
 * decision comes in the same step as the classes.
 */
async function exportJson(page: Page): Promise<{ ids: string[]; said: string }> {
  const button = page.locator('.filters details.export summary');
  const popup = page.getByRole('group', { name: 'Ways to export' });
  let ids: string[] = [];
  await expect(async () => {
    await button.click();
    const [download] = await Promise.all([
      page.waitForEvent('download', { timeout: 2000 }),
      popup.getByRole('button', { name: 'Save as JSON ...' }).click(),
    ]);
    const path = await download.path();
    ids = (JSON.parse(readFileSync(path, 'utf8')) as { tasks: { id: string }[] }).tasks.map((t) => t.id);
  }).toPass({ timeout: 20_000 });
  const said = (await page.locator('[role="status"], [role="alert"]').allTextContents()).join(' | ');
  return { ids, said };
}

test('an area without a class never reaches IndexedDB, and its tasks stay in the app when the list is exported', async ({ page }) => {
  const seen = await watchPage(page);
  await spyOnIndexedDb(page);
  // No areas.json: every area is unclassified.
  await openVault(page, vaultFiles());
  await showList(page);
  await expect(page.locator('button.row')).not.toHaveCount(0);
  const shown = await page.locator('button.row').count();

  // Nothing is exported: the page read the classes (an export before that is "not read yet"), and all of it stays.
  const button = page.locator('.filters details.export summary');
  const popup = page.getByRole('group', { name: 'Ways to export' });
  await expect(async () => {
    await button.click();
    await popup.getByRole('button', { name: 'Save as JSON ...' }).click();
    await expect(page.getByText(new RegExp(`Nothing exported: the ${shown} tasks shown are of private or unclassified areas`))).toBeVisible({ timeout: 1500 });
  }).toPass({ timeout: 20_000 });

  // Never written to the list store, not even for a moment; nothing there at the end either.
  const writes = (await idbWrites(page)).filter((w) => w.store === 'list');
  expect(writes.filter((w) => w.op === 'put' || w.op === 'add')).toEqual([]);
  expect(await storedList(page)).toBeNull();
  expect(seen.requests).toEqual([]);
  expect(seen.errors).toEqual([]);
  expect(await violations(page)).toEqual([]);
});

test('only the areas the file releases are kept, with nothing of the others in the record', async ({ page }) => {
  const seen = await watchPage(page);
  await spyOnIndexedDb(page);
  const files = vaultFiles();
  // lib.nvim may be kept, cascade.nvim is private, the other areas of the vault are not named.
  files['areas.json'] = classes({ 'lib.nvim': 'internal', 'cascade.nvim': 'private' });
  await openVault(page, files);

  await expect.poll(() => storedList(page), { timeout: 20_000 }).not.toBeNull();
  const list = (await storedList(page))!;
  expect(list.tasks.length).toBeGreaterThan(5);
  expect([...new Set(list.tasks.map((t) => t.area))]).toEqual(['lib.nvim']);
  const record = JSON.stringify(list);
  for (const word of CASCADE) expect(record, word).not.toContain(word);
  // The same in what was ever written, not only in what is left.
  for (const write of (await idbWrites(page)).filter((w) => w.store === 'list' && w.op === 'put')) {
    for (const word of CASCADE) expect(write.json, word).not.toContain(word);
  }
  // The record belongs to the folder it was made for.
  expect(typeof list.folder).toBe('string');

  // The page still shows every area to the person; the export takes only what is released.
  await showList(page);
  await expect(page.locator('button.row', { hasText: 'cascade.nvim/eta' })).toBeVisible();
  const { ids, said } = await exportJson(page);
  expect(ids.length).toBeGreaterThan(5);
  expect(ids.every((id) => id.startsWith('lib.nvim/'))).toBe(true);
  expect(said).toMatch(/tasks saved; \d+ of private or unclassified areas stay in the app/);
  expect(seen.errors).toEqual([]);
  expect(seen.requests).toEqual([]);
});

test('a default class in the file releases the areas it does not name, and an entry still wins', async ({ page }) => {
  await spyOnIndexedDb(page);
  const files = vaultFiles();
  files['areas.json'] = classes({ 'cascade.nvim': 'private' }, { default: 'public' });
  await openVault(page, files);
  await expect.poll(() => storedList(page), { timeout: 20_000 }).not.toBeNull();
  const list = (await storedList(page))!;
  expect([...new Set(list.tasks.map((t) => t.area))]).toEqual(['lib.nvim']);
});

test('a file changed on the disk changes what is kept: the area made private leaves the record', async ({ page }) => {
  await spyOnIndexedDb(page);
  const files = vaultFiles();
  files['areas.json'] = classes({ 'lib.nvim': 'internal', 'cascade.nvim': 'public' });
  await openVault(page, files);
  await expect.poll(async () => [...new Set(((await storedList(page)) ?? { tasks: [] }).tasks.map((t) => t.area))].sort(), { timeout: 20_000 }).toEqual(['cascade.nvim', 'lib.nvim']);

  // Someone makes cascade.nvim private in the folder; the page reads the folder again when the window is focused.
  const before = (await idbWrites(page)).length;
  await editOnDisk(page, 'areas.json', classes({ 'lib.nvim': 'internal', 'cascade.nvim': 'private' }));
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect
    .poll(async () => [...new Set(((await storedList(page)) ?? { tasks: [] }).tasks.map((t) => t.area))].sort(), { timeout: 20_000 })
    .toEqual(['lib.nvim']);
  const record = JSON.stringify(await storedList(page));
  for (const word of CASCADE) expect(record, word).not.toContain(word);
  // Not only the end state: the change of the file makes two refreshes that overlap (the classes moved, and the tasks may
  // have), and the second is built from the classes of before unless the cache looks again. At most one list of the old
  // classes may be written after the change (the one that was already under way); a second one is the page writing a task
  // of a private area to IndexedDB for a moment.
  await page.waitForTimeout(1500);
  const after = (await idbWrites(page)).slice(before).filter((w) => w.store === 'list');
  const stale = after.filter((w) => w.op === 'put' && w.json.includes('cascade.nvim'));
  expect(stale.length, after.map((w) => `${w.op}${w.json.includes('cascade.nvim') ? ' cascade' : ''}`).join(', ')).toBeLessThanOrEqual(1);

  // And the file is gone: nothing is classified, nothing stays.
  await editOnDisk(page, 'areas.json', classes({}));
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect.poll(() => storedList(page), { timeout: 20_000 }).toBeNull();
});

test('a file that is not valid releases nothing: no record, and the export keeps every task in the app', async ({ page }) => {
  await spyOnIndexedDb(page);
  const files = vaultFiles();
  // The class twice: a browser's JSON parser would take the last one (public), the Rust hub refuses the file.
  files['areas.json'] = '{"schema":1,"areas":{"lib.nvim":{"class":"private","class":"public"},"cascade.nvim":{"class":"public"}}}';
  await openVault(page, files);
  await showList(page);
  const shown = await page.locator('button.row').count();
  const button = page.locator('.filters details.export summary');
  const popup = page.getByRole('group', { name: 'Ways to export' });
  await expect(async () => {
    await button.click();
    await popup.getByRole('button', { name: 'Save as JSON ...' }).click();
    await expect(page.getByText(new RegExp(`Nothing exported: the ${shown} tasks shown are of private or unclassified areas`))).toBeVisible({ timeout: 1500 });
  }).toPass({ timeout: 20_000 });
  expect((await idbWrites(page)).filter((w) => w.store === 'list' && (w.op === 'put' || w.op === 'add'))).toEqual([]);
  expect(await storedList(page)).toBeNull();
});

// -- what the page shows first after a reload, and per folder -------------------------------------------------------------

/** The areas of the list that is kept now, sorted. */
const keptAreas = async (page: Page): Promise<string[]> =>
  [...new Set(((await storedList(page)) ?? { tasks: [] }).tasks.map((t) => t.area))].sort();

/** The vault with a task of cascade.nvim given another title, so that a task drawn from the cache can be told from the one read. */
function retitled(files: Record<string, string>, extra: Record<string, string> = {}): Record<string, string> {
  const path = 'cascade.nvim/ROADMAP/tasks/eta.md';
  return { ...files, ...extra, [path]: (files[path] as string).replace('title: Eta tests', 'title: Eta retitled') };
}

/** Load the page again on `files` (a new fake folder of the page's init script) and choose the folder. */
async function reloadOnto(page: Page, files: Record<string, string>, name?: string): Promise<void> {
  await fakePicker(page, files, name);
  await watchText(page, 'Eta tests');
  await page.reload();
  await page.getByRole('button', { name: /Choose folder/ }).click();
  await page.getByText('Eta retitled').first().waitFor({ timeout: 30_000 });
}

test('the first picture after a reload is cut by the classes of the file as it is now', async ({ page }) => {
  const seen = await watchPage(page);
  await spyOnIndexedDb(page);
  const files = vaultFiles();
  files['areas.json'] = classes({ 'lib.nvim': 'internal', 'cascade.nvim': 'public' });
  await openVault(page, files);
  await showList(page);
  await expect.poll(() => keptAreas(page), { timeout: 20_000 }).toEqual(['cascade.nvim', 'lib.nvim']);
  const folder = (await storedList(page))!.folder;

  // The page is closed; meanwhile cascade.nvim is made private in the folder. The first picture of the next start is
  // drawn from the list in IndexedDB, before the folder is read: it must not show that area.
  await reloadOnto(page, retitled(files, { 'areas.json': classes({ 'lib.nvim': 'internal', 'cascade.nvim': 'private' }) }));
  expect(await sawText(page, 'Eta tests'), 'a task of the area made private was drawn from the cache').toBe(false);
  // The same folder, and nothing of the area stays.
  await expect.poll(() => keptAreas(page), { timeout: 20_000 }).toEqual(['lib.nvim']);
  expect((await storedList(page))!.folder).toBe(folder);
  const record = JSON.stringify(await storedList(page));
  for (const word of CASCADE) expect(record, word).not.toContain(word);
  expect(seen.errors).toEqual([]);
  expect(seen.requests).toEqual([]);
});

test('the first picture after a reload is the list of the same folder, as it was kept', async ({ page }) => {
  // The other side of the test above, so that it cannot pass because no first picture is ever drawn: with the classes
  // unchanged the cached list is shown, a task read from the folder is not there yet.
  await spyOnIndexedDb(page);
  const files = vaultFiles();
  files['areas.json'] = classes({ 'lib.nvim': 'internal', 'cascade.nvim': 'public' });
  await openVault(page, files);
  await showList(page);
  await expect.poll(() => keptAreas(page), { timeout: 20_000 }).toEqual(['cascade.nvim', 'lib.nvim']);
  await reloadOnto(page, retitled(files));
  expect(await sawText(page, 'Eta tests'), 'the cached list was not the first picture').toBe(true);
});

test('the list kept for one folder is not the first picture of another', async ({ page }) => {
  await spyOnIndexedDb(page);
  const files = vaultFiles();
  files['areas.json'] = classes({ 'lib.nvim': 'internal', 'cascade.nvim': 'public' });
  await openVault(page, files);
  await showList(page);
  await expect.poll(() => keptAreas(page), { timeout: 20_000 }).toEqual(['cascade.nvim', 'lib.nvim']);
  const first = (await storedList(page))!.folder;

  // Another folder, with the same classes (so only the folder keeps the list from being shown), opened in the same browser.
  await reloadOnto(page, retitled(files), 'other-vault');
  expect(await sawText(page, 'Eta tests'), 'the list of the other folder was drawn first').toBe(false);
  await expect.poll(async () => (await storedList(page))!.folder, { timeout: 20_000 }).not.toBe(first);
});

test('forgetting a folder takes its list out of the browser', async ({ page }) => {
  await spyOnIndexedDb(page);
  const files = vaultFiles();
  files['areas.json'] = classes({ 'lib.nvim': 'internal', 'cascade.nvim': 'public' });
  await openVault(page, files);
  await expect.poll(() => keptAreas(page), { timeout: 20_000 }).toEqual(['cascade.nvim', 'lib.nvim']);

  // The next start offers the folder among those used before.
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Used before' })).toBeVisible();
  expect(await storedList(page), 'the list is still there before the folder is forgotten').not.toBeNull();
  await page.getByRole('button', { name: 'Forget' }).click();
  await expect(page.getByRole('heading', { name: 'Used before' })).toHaveCount(0);
  await expect.poll(() => storedList(page), { timeout: 10_000 }).toBeNull();
});
