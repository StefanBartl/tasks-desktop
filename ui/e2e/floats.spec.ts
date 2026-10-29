// The floats of the page: a task opens in a float over the list (no detail beside it), the float can be moved and
// sized with the mouse and the keyboard and keeps its place, it can be detached into a window of its own; the detail
// in it has a line per text field, a summary of several lines and the large Done button in its lower right corner.

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { expectAccessible, violations, watchViolations } from './a11y';
import { STATE } from './global';
import { removeFile } from './hub';

test.use({ locale: 'en-US' });

const state = (): { vault: string; token: string } => JSON.parse(readFileSync(STATE, 'utf8')) as { vault: string; token: string };

/** How long a test waits for a write to be answered (as app.spec.ts: the engine's 5 s and a call it may wait behind). */
const WRITE_BUDGET = 15_000;

async function pair(page: Page, path = '/'): Promise<string[]> {
  const problems: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error' || m.type() === 'warning') problems.push(`${m.type()}: ${m.text()}`);
  });
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  await watchViolations(page);
  await page.addInitScript((token) => sessionStorage.setItem('tasks-desktop.session', token), state().token);
  await page.goto(path);
  await expect(page.getByRole('menubar')).toBeVisible();
  return problems;
}

async function showList(page: Page): Promise<void> {
  await page.getByRole('menuitem', { name: 'View', exact: true }).click();
  await page.getByRole('menuitemradio', { name: 'List', exact: true }).click();
  await expect(page.locator('button.row').first()).toBeVisible();
}

const float = (page: Page): Locator => page.getByRole('dialog', { name: 'Task' });

/** Open a task of the list in its float and wait until its text is read. */
async function openTask(page: Page, id: string): Promise<Locator> {
  await page.locator('button.row', { hasText: id }).first().click();
  const f = float(page);
  await expect(f.locator('aside.detail .id')).toHaveText(id);
  await expect(f.locator('aside.detail .prose, aside.detail pre.body')).toBeVisible();
  return f;
}

async function box(locator: Locator): Promise<{ x: number; y: number; width: number; height: number }> {
  const b = await locator.boundingBox();
  expect(b).not.toBeNull();
  return b!;
}

/** Drag from the middle of `from` by dx/dy with real mouse steps. */
async function dragBy(page: Page, from: { x: number; y: number }, dx: number, dy: number): Promise<void> {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(from.x + dx / 2, from.y + dy / 2, { steps: 4 });
  await page.mouse.move(from.x + dx, from.y + dy, { steps: 4 });
  await page.mouse.up();
}

const kept = (page: Page): Promise<Record<string, { x: number; y: number; w?: number; h?: number }>> =>
  page.evaluate(() => JSON.parse(localStorage.getItem('tasks-desktop.floats') ?? '{}') as Record<string, { x: number; y: number; w?: number; h?: number }>);

for (const scheme of ['light', 'dark'] as const) {
  test(`the list opens a task in a float over it, not beside it (${scheme})`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: scheme });
    const problems = await pair(page);
    await showList(page);
    // Only the list: no detail beside it, and the list takes the width of the page.
    await expect(page.locator('aside.detail')).toHaveCount(0);
    const list = await box(page.locator('section.list'));
    const main = await box(page.locator('main'));
    expect(list.width).toBeGreaterThan(main.width * 0.9);

    const row = page.locator('button.row', { hasText: 'lib.nvim/alpha' }).first();
    const f = await openTask(page, 'lib.nvim/alpha');
    await expect(f.getByRole('button', { name: 'Move or resize the window' })).toBeVisible();
    // The focus starts on Close (the handle before it would open its long hint over the task).
    await expect(f.locator('button[data-close]')).toBeFocused();
    await expect(f.locator('button[data-close]')).toHaveText('Close');
    // In the list, "Show in the list" would show what is behind the float: it is not offered there.
    await expect(f.getByRole('button', { name: 'Show in the list' })).toHaveCount(0);
    await expectAccessible(page, `the list with a task in its float (${scheme})`);

    // Escape closes it; the row keeps the selection and gets the focus back.
    await page.keyboard.press('Escape');
    await expect(f).toHaveCount(0);
    await expect(row).toBeFocused();
    await expect(row).toHaveAttribute('aria-current', 'true');

    // The keys: j moves the selection without opening anything, o opens the selected task.
    await page.locator('main').focus();
    await page.keyboard.press('j');
    await expect(f).toHaveCount(0);
    const next = (await page.locator('button.row[aria-current="true"] .id').innerText()).trim();
    expect(next).not.toBe('lib.nvim/alpha');
    await page.keyboard.press('o');
    await expect(f.locator('aside.detail .id')).toHaveText(next);
    // A float scrolled down opens the next time at the top of its task.
    await expect(f.locator('aside.detail .prose, aside.detail pre.body')).toBeVisible();
    await f.evaluate((el) => (el.scrollTop = 300));
    expect(await f.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
    await page.keyboard.press('Escape');
    await expect(f).toHaveCount(0);
    await page.keyboard.press('o');
    await expect(f).toBeVisible();
    expect(await f.evaluate((el) => el.scrollTop)).toBe(0);
    await page.keyboard.press('Escape');
    expect(await violations(page)).toEqual([]);
    expect(problems).toEqual([]);
  });
}

test('a task is detached from its float into a window of its own, which shows that task alone', async ({ page, context }) => {
  const problems = await pair(page);
  await showList(page);
  const f = await openTask(page, 'lib.nvim/beta');
  const [win] = await Promise.all([
    context.waitForEvent('page'),
    f.getByRole('button', { name: 'Open in a window of its own' }).click(),
  ]);
  // The float here closes: the task went to the other window.
  await expect(f).toHaveCount(0);
  await win.waitForLoadState();
  // The new window is paired (the tab's session came with it), shows the task alone, and the fragment left the address.
  await expect(win.getByRole('menubar')).toBeVisible();
  await expect(win.locator('main aside.detail .id')).toHaveText('lib.nvim/beta');
  await expect(win.locator('section.list')).toHaveCount(0);
  await expect(win.getByRole('dialog', { name: 'Task' })).toHaveCount(0);
  expect(await win.evaluate(() => location.hash)).toBe('');
  await expectAccessible(win, 'the window of one task');
  // A view chosen in that window makes it a page of views again.
  await win.getByRole('menuitem', { name: 'View', exact: true }).click();
  await win.getByRole('menuitemradio', { name: 'List', exact: true }).click();
  await expect(win.locator('section.list')).toBeVisible();
  await expect(win.locator('aside.detail')).toHaveCount(0);
  await win.close();
  expect(problems).toEqual([]);
});

test('the fifth window of one tab gets no live connection from the hub, and its bar says so', async ({ page, context }) => {
  test.setTimeout(90_000);
  const problems = await pair(page);
  await showList(page);
  const conn = (p: Page): Locator => p.locator('header .conn');
  await expect(conn(page)).toHaveText('live', { timeout: WRITE_BUDGET });
  // The detached windows share the session of the tab, and the hub gives one session four event streams.
  const windows: Page[] = [];
  for (const id of ['lib.nvim/alpha', 'lib.nvim/beta', 'lib.nvim/gamma', 'lib.nvim/delta']) {
    const f = await openTask(page, id);
    const [win] = await Promise.all([context.waitForEvent('page'), f.getByRole('button', { name: 'Open in a window of its own' }).click()]);
    await expect(win.locator('main aside.detail .id')).toHaveText(id, { timeout: WRITE_BUDGET });
    windows.push(win);
  }
  for (const win of windows.slice(0, 3)) await expect(conn(win)).toHaveText('live', { timeout: WRITE_BUDGET });
  const fifth = windows[3] as Page;
  await expect(conn(fifth)).toHaveText('not live: too many windows', { timeout: WRITE_BUDGET });
  await expect(conn(fifth)).toHaveAttribute('data-hint', /at most four live connections/);
  await expectAccessible(fifth, 'the bar of a window the hub gave no stream');
  for (const win of windows) await win.close();
  // The other windows let go of theirs: this tab still has its own.
  await expect(conn(page)).toHaveText('live');
  // The refused stream is the browser's console error of that window, not one of this one.
  expect(problems).toEqual([]);
});

test('the handle of a dialog comes first in the order of the focus without taking it, and a heading drawn later moves the dialog too', async ({ page }) => {
  const slug = `float-head-e2e-${Date.now().toString(36)}`;
  const file = join(state().vault, 'lib.nvim', 'ROADMAP', 'tasks', `${slug}.md`);
  writeFileSync(file, `---\ntitle: Float head e2e\nstatus: doing\nkind: task\n---\n\nx\n`);
  try {
    const problems = await pair(page);
    // The capture: its title has the focus (autofocus); the handle drawn in the upper right corner is the stop before it.
    await showList(page);
    await page.locator('main').focus();
    await page.keyboard.press('c');
    const capture = page.getByRole('dialog', { name: 'New task' });
    const title = capture.getByLabel('Title', { exact: true });
    await expect(title).toBeFocused();
    await page.keyboard.press('Shift+Tab');
    await expect(capture.getByRole('button', { name: 'Move or resize the window' })).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(title).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(capture).toHaveCount(0);

    // A dialog without a field of its own to focus: the browser's first control would be the handle; the focus goes on
    // to the control after it.
    await page.getByRole('menuitem', { name: 'View', exact: true }).click();
    await page.getByRole('menuitemradio', { name: 'Today', exact: true }).click();
    await page.locator('button.tile[data-count="doing"]').click();
    await page.getByRole('region', { name: 'doing' }).getByRole('button', { name: `Move lib.nvim/${slug} to another area` }).click();
    const choose = page.getByRole('dialog', { name: 'Move to another area' });
    await expect(choose.getByLabel('Area')).toBeFocused();
    await choose.getByLabel('Area').selectOption('cascade.nvim');
    await choose.getByRole('button', { name: 'Check the move' }).click();

    // The second step draws a heading of its own while the dialog stays open: it is a handle too.
    const confirm = page.getByRole('dialog', { name: 'Move to cascade.nvim?' });
    const heading = confirm.getByRole('heading', { name: 'Move to cascade.nvim?' });
    await expect(heading).toHaveClass(/\bfloat-head\b/);
    const before = await box(confirm);
    const h = await box(heading);
    await dragBy(page, { x: h.x + 20, y: h.y + h.height / 2 }, -50, 20);
    const after = await box(confirm);
    expect(Math.abs(after.x - (before.x - 50))).toBeLessThanOrEqual(2);
    await expectAccessible(page, 'the second step of the move with its heading as a handle');
    await confirm.getByRole('button', { name: 'Cancel' }).click();
    await expect(confirm).toHaveCount(0);
    expect(readFileSync(file, 'utf8')).toContain('status: doing');
    expect(problems).toEqual([]);
  } finally {
    removeFile(file);
  }
});

test('a task the address names that the list does not have is told, and the page stays as it is', async ({ page }) => {
  // A page loaded at that address, as a detached window is.
  const problems = await pair(page, '/#task=lib.nvim%2Fno-such-task');
  await expect(page.getByText('The task lib.nvim/no-such-task is not in the list')).toBeVisible();
  await expect(page.locator('main aside.detail')).toHaveCount(0);
  expect(problems).toEqual([]);
});

test('the float of a task is moved and sized with the mouse, stays in the window, and keeps its place', async ({ page }) => {
  const problems = await pair(page);
  await showList(page);
  let f = await openTask(page, 'lib.nvim/alpha');
  const start = await box(f);

  // A drag of the head moves it by as much as the mouse went.
  const handle = await box(f.getByRole('button', { name: 'Move or resize the window' }));
  await dragBy(page, { x: handle.x + handle.width / 2, y: handle.y + handle.height / 2 }, -120, -40);
  const moved = await box(f);
  expect(Math.abs(moved.x - (start.x - 120))).toBeLessThanOrEqual(2);
  expect(Math.abs(moved.y - Math.max(8, start.y - 40))).toBeLessThanOrEqual(2);
  expect(moved.width).toBeCloseTo(start.width, 0);

  // The browser's grip in the lower right corner makes it smaller; the upper left corner stays.
  await dragBy(page, { x: moved.x + moved.width - 4, y: moved.y + moved.height - 4 }, -100, -80);
  const sized = await box(f);
  expect(sized.width).toBeLessThan(moved.width - 60);
  expect(sized.height).toBeLessThan(moved.height - 40);
  expect(Math.abs(sized.x - moved.x)).toBeLessThanOrEqual(2);
  expect(Math.abs(sized.y - moved.y)).toBeLessThanOrEqual(2);
  const place = (await kept(page))['task'];
  expect(place).toBeDefined();
  expect(Math.abs(place!.x - sized.x)).toBeLessThanOrEqual(1);
  expect(Math.abs((place!.w ?? 0) - sized.width)).toBeLessThanOrEqual(1);

  // Closed and opened again (and after a reload): the same place and size.
  await page.keyboard.press('Escape');
  await expect(f).toHaveCount(0);
  await page.reload();
  await showList(page);
  f = await openTask(page, 'lib.nvim/beta');
  const again = await box(f);
  expect(Math.abs(again.x - sized.x)).toBeLessThanOrEqual(1);
  expect(Math.abs(again.y - sized.y)).toBeLessThanOrEqual(1);
  expect(Math.abs(again.width - sized.width)).toBeLessThanOrEqual(1);
  expect(Math.abs(again.height - sized.height)).toBeLessThanOrEqual(1);

  // Dragged far out of the window: it stops at its edge.
  const view = page.viewportSize()!;
  const h2 = await box(f.getByRole('button', { name: 'Move or resize the window' }));
  await dragBy(page, { x: h2.x + h2.width / 2, y: h2.y + h2.height / 2 }, view.width + 400, view.height + 400);
  const edge = await box(f);
  expect(edge.x + edge.width).toBeLessThanOrEqual(view.width);
  expect(edge.y + edge.height).toBeLessThanOrEqual(view.height);
  expect(edge.x).toBeGreaterThanOrEqual(0);
  expect(edge.y).toBeGreaterThanOrEqual(0);
  expect(problems).toEqual([]);
});

test('the float is moved and sized by the keyboard on its handle, and Home puts it back', async ({ page }) => {
  await pair(page);
  await showList(page);
  const f = await openTask(page, 'lib.nvim/alpha');
  const handle = f.getByRole('button', { name: 'Move or resize the window' });
  await handle.focus();
  const before = await box(f);
  await page.keyboard.press('ArrowLeft');
  await page.keyboard.press('ArrowUp');
  const moved = await box(f);
  expect(Math.round(moved.x)).toBe(Math.round(before.x) - 16);
  expect(Math.round(moved.y)).toBe(Math.max(8, Math.round(before.y) - 16));
  await page.keyboard.press('Shift+ArrowLeft');
  const narrower = await box(f);
  expect(Math.round(narrower.width)).toBe(Math.round(moved.width) - 16);
  expect(Math.round(narrower.x)).toBe(Math.round(moved.x));
  expect((await kept(page))['task']?.w).toBe(Math.round(narrower.width));
  // Home: the place of a dialog again, nothing kept.
  await page.keyboard.press('Home');
  const back = await box(f);
  expect(Math.abs(back.x - before.x)).toBeLessThanOrEqual(1);
  expect(Math.abs(back.width - before.width)).toBeLessThanOrEqual(1);
  expect((await kept(page))['task']).toBeUndefined();
  // The focus stayed in the float (the dialog keeps it). Escape closes the hint of the handle first (as everywhere on
  // the page), then the float.
  await expect(handle).toBeFocused();
  await expect(page.locator('#hint-tip')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('#hint-tip')).toBeHidden();
  await expect(f).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(f).toHaveCount(0);
});

test('the other floats move too, each keeps its own place, and they have no violation', async ({ page }) => {
  await pair(page);
  await showList(page);
  await page.locator('main').focus();
  await page.keyboard.press('c');
  const capture = page.getByRole('dialog', { name: 'New task' });
  await expect(capture).toBeVisible();
  const handle = capture.getByRole('button', { name: 'Move or resize the window' });
  await expect(handle).toBeVisible();
  await expectAccessible(page, 'the capture with its handle');
  const before = await box(capture);
  // The title of the dialog is a handle too.
  const title = await box(capture.getByRole('heading', { name: 'New task' }));
  await dragBy(page, { x: title.x + 20, y: title.y + title.height / 2 }, 60, 30);
  const after = await box(capture);
  expect(Math.abs(after.x - (before.x + 60))).toBeLessThanOrEqual(2);
  // A tall dialog goes down only as far as its lower edge stays in the window.
  const lowest = page.viewportSize()!.height - 8 - before.height;
  expect(Math.abs(after.y - Math.min(before.y + 30, lowest))).toBeLessThanOrEqual(2);
  const places = await kept(page);
  expect(places['capture']).toBeDefined();
  expect(places['task']).toBeUndefined();
  await page.keyboard.press('Escape');
  await expect(capture).toHaveCount(0);

  // The float of a task did not move with it.
  const f = await openTask(page, 'lib.nvim/alpha');
  const t = await box(f);
  const view = page.viewportSize()!;
  expect(Math.abs(t.x + t.width / 2 - view.width / 2)).toBeLessThanOrEqual(2);
});

test('the float speaks German too, and has no violation there', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('tasks-desktop.lang', 'de'));
  await pair(page);
  await page.getByRole('menuitem', { name: 'Ansicht', exact: true }).click();
  await page.getByRole('menuitemradio', { name: 'Liste', exact: true }).click();
  await page.locator('button.row', { hasText: 'lib.nvim/alpha' }).first().click();
  const f = page.getByRole('dialog', { name: 'Task' });
  await expect(f.locator('aside.detail .prose')).toBeVisible();
  await expect(f.getByRole('button', { name: 'Fenster verschieben oder Größe ändern' })).toBeVisible();
  await expect(f.getByRole('button', { name: 'In eigenem Fenster öffnen' })).toBeVisible();
  await expect(f.getByRole('button', { name: 'Schließen', exact: true })).toBeVisible();
  await expect(f.getByRole('button', { name: 'Erledigt', exact: true })).toBeVisible();
  await expect(f.getByLabel('Zusammenfassung', { exact: true })).toHaveJSProperty('tagName', 'TEXTAREA');
  await expectAccessible(page, 'the float in German');
});

test('on a phone the float fits the screen, a kept place too', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  // A place kept on a large screen.
  await page.addInitScript(() => {
    localStorage.setItem('tasks-desktop.floats', JSON.stringify({ task: { x: 900, y: 500, w: 1200, h: 900 } }));
  });
  await pair(page);
  await showList(page);
  const f = await openTask(page, 'lib.nvim/alpha');
  const b = await box(f);
  expect(b.x).toBeGreaterThanOrEqual(0);
  expect(b.y).toBeGreaterThanOrEqual(0);
  expect(b.x + b.width).toBeLessThanOrEqual(375);
  expect(b.y + b.height).toBeLessThanOrEqual(812);
  // Nothing of the page scrolls sideways.
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(375);
  await expectAccessible(page, 'the float on a phone');
});

test('the detail: the title on a line of its own, a summary of several lines, Done large in the lower right corner', async ({ page }) => {
  const slug = `float-detail-e2e-${Date.now().toString(36)}`;
  const id = `lib.nvim/${slug}`;
  const file = join(state().vault, 'lib.nvim', 'ROADMAP', 'tasks', `${slug}.md`);
  const title = 'A long title that has to be read whole in the detail, with many words in it, more than a narrow field shows';
  // A body long enough that the float scrolls: Done has to stay in its corner, not at the end of the text.
  const body = Array.from({ length: 60 }, (_, i) => `Paragraph ${i + 1} of the body.`).join('\n\n');
  writeFileSync(file, `---\ntitle: ${title}\nstatus: open\nkind: task\nsummary: First words\n---\n\n${body}\n`);
  try {
    const problems = await pair(page);
    await showList(page);
    await expect(page.locator('button.row', { hasText: id })).toHaveCount(1, { timeout: WRITE_BUDGET });
    const f = await openTask(page, id);

    // The title field takes the whole width of the fields, and shows all of the title.
    const fields = await box(f.getByRole('group', { name: 'Change', exact: true }));
    const titleField = f.getByLabel('Title', { exact: true });
    expect((await box(titleField)).width).toBeGreaterThan(fields.width * 0.95);
    await expect(titleField).toHaveValue(title);

    // The summary is a field of several lines, as wide as the title.
    const summary = f.getByLabel('Summary', { exact: true });
    expect(await summary.evaluate((el) => el.tagName)).toBe('TEXTAREA');
    const summaryBox = await box(summary);
    expect(summaryBox.height).toBeGreaterThan((await box(titleField)).height * 2);
    expect(summaryBox.width).toBeGreaterThan(fields.width * 0.95);
    // A line break becomes a space (the engine keeps one line), Enter writes.
    const written = page.waitForResponse((r) => r.request().method() === 'POST' && new URL(r.url()).pathname === '/api/tasks/ops', {
      timeout: WRITE_BUDGET,
    });
    await summary.fill('First line\nsecond line');
    await summary.press('Enter');
    await written;
    await expect.poll(() => readFileSync(file, 'utf8'), { timeout: WRITE_BUDGET }).toMatch(/^summary: First line second line$/m);
    await expect(f.getByLabel('Summary', { exact: true })).toHaveValue('First line second line');
    // The focus stays in the summary (on the page, a letter would be a key of the page).
    await expect(f.getByLabel('Summary', { exact: true })).toBeEditable();
    await expect(f.getByLabel('Summary', { exact: true })).toBeFocused();
    // The toast of the change stands in the float (it is modal: one outside could not be reached), and its Undo works.
    await f.getByRole('button', { name: 'Undo', exact: true }).click();
    await expect.poll(() => readFileSync(file, 'utf8'), { timeout: WRITE_BUDGET }).toMatch(/^summary: First words$/m);
    await expect(f.getByLabel('Summary', { exact: true })).toHaveValue('First words');

    // Done: its name, larger than the buttons around it, in the lower right corner of the float.
    const done = f.getByRole('button', { name: 'Done', exact: true });
    await expect(done).toBeVisible();
    const d = await box(done);
    const close = await box(f.locator('button[data-close]'));
    expect(d.height).toBeGreaterThan(close.height * 1.3);
    expect(d.width).toBeGreaterThan(close.width * 1.5);
    const fb = await box(f);
    expect(fb.x + fb.width - (d.x + d.width)).toBeLessThan(40);
    expect(fb.y + fb.height - (d.y + d.height)).toBeLessThan(40);
    // It stays there while the float scrolls: the text is longer than the float, and at its top as at its end Done is in
    // the corner, in view.
    expect(await f.evaluate((el) => el.scrollHeight > el.clientHeight + 200)).toBe(true);
    for (const scroll of [0, 100_000]) {
      await f.evaluate((el, to) => (el.scrollTop = to), scroll);
      const at = await box(done);
      expect(fb.y + fb.height - (at.y + at.height)).toBeLessThan(40);
      expect(fb.y + fb.height - (at.y + at.height)).toBeGreaterThanOrEqual(0);
      await expect(done).toBeInViewport();
    }
    await expectAccessible(page, 'the detail with Done in its corner');
    await done.click();
    await expect(page.getByRole('dialog', { name: 'Finish this task?' })).toBeVisible();
    await page.keyboard.press('Escape');
    expect(problems).toEqual([]);
  } finally {
    removeFile(file);
  }
});
