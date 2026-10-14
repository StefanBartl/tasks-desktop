// What the palette can do: the actions of the page, as a list for the state it is in (a task that is selected, a
// board the engine can serve, marks that are made). Only what can be done now is listed.

import type { App } from './app.svelte';
import { translate, type Key } from './i18n';
import type { PaletteAction } from './palette';

const STATUSES = ['doing', 'decision', 'blocked', 'open', 'parked'] as const;
const PRIOS = [1, 2, 3] as const;

export function paletteActions(app: App): PaletteAction[] {
  const t = (key: Key, params: Record<string, string | number> = {}) => translate(app.lang, key, params);
  const out: PaletteAction[] = [];
  const add = (key: string, label: string, run: () => void | Promise<void>, hint = ''): void => {
    out.push({ key, label, hint, run });
  };

  add('capture', t('menu.capture'), () => app.openCapture());
  if (app.can('plan_new')) add('plan.new', t('plan.new.button'), () => app.openPlanWizard());

  // The task that is selected: what the keys of the board and the form do, by name.
  const selected = app.selectedId === null ? undefined : app.tasks.find((x) => x.id === app.selectedId);
  if (selected) {
    const id = selected.id;
    add('task.finish', t('palette.finish'), () => app.startFinish(id), id);
    if (app.can('plan_for')) add('task.graph', t('graph.button'), () => app.openGraph(id), id);
    for (const status of STATUSES) {
      if (status === selected.status) continue;
      add(`task.status.${status}`, t('palette.status', { status: t(`status.${status}` as Key) }), () => app.dropOnColumn(id, status), id);
    }
    for (const prio of PRIOS) {
      if (prio === selected.prio) continue;
      add(`task.prio.${prio}`, t('palette.prio', { prio }), () => app.setField(id, 'prio', prio), id);
    }
  }

  add('go.today', t('palette.go', { view: t('nav.today') }), () => app.setView('today'));
  add('go.list', t('palette.go', { view: t('nav.list') }), () => app.setView('list'));
  if (app.can('reorder')) add('go.board', t('palette.go', { view: t('nav.board') }), () => app.setView('board'));
  add('go.plan', t('palette.go', { view: t('nav.plan') }), () => app.setView('plan'));
  add('go.inbox', t('palette.go', { view: t('nav.inbox') }), () => app.setView('inbox'));
  if (app.can('check')) add('check.open', t('check.open'), () => app.openChecks());
  if (app.can('estimate') && app.view === 'list') add('matrix.open', t('matrix.open'), () => app.openMatrix());

  if (app.conflicts.length > 0) add('conflicts.show', t('palette.conflicts', { n: app.conflicts.length }), () => app.openConflicts());
  add('rescan', t('menu.rescan'), () => app.focused());
  add('marks.all', t('bulk.all'), () => {
    app.setView('list');
    app.markShown();
  });
  if (app.marks.length > 0) add('marks.clear', t('bulk.clear'), () => app.clearMarks());
  add('filter.reset', t('palette.filter_reset'), () => app.resetFilter());

  add('lang.de', t('palette.lang', { name: 'Deutsch' }), () => app.setLang('de'));
  add('lang.en', t('palette.lang', { name: 'English' }), () => app.setLang('en'));
  for (const theme of ['auto', 'light', 'dark'] as const) {
    add(`theme.${theme}`, t('palette.theme', { name: t(`theme.${theme}` as Key) }), () => app.setTheme(theme));
  }
  return out;
}
