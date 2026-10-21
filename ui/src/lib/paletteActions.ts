// What the palette can do: the actions of the page, as a list for the state it is in (a task that is selected, a
// board the engine can serve, marks that are made). Only what can be done now is listed.

import type { App } from './app.svelte';
import { translate, type Key } from './i18n';
import type { PaletteAction } from 'appkit-ui/palette';
import { selectOfFilter } from './views';

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
  add('go.cross', t('palette.go', { view: t('nav.cross') }), () => app.setView('cross'));
  if (app.can('finished')) add('go.done', t('palette.go', { view: t('nav.done') }), () => app.setView('done'));
  if (app.can('views')) {
    add('go.views', t('palette.go', { view: t('nav.views') }), () => app.setView('views'));
    // Every saved view of the vault, by its name.
    for (const view of app.viewsState.list) add(`view.${view.id}`, t('palette.view', { name: view.title }), () => app.openView(view.id), view.id);
    // The list as it is filtered, grouped by a field the engine names (a view to look with: nothing is saved). Not
    // under `view.`: that is the key of a saved view, whose id names an area (see `App.chose`).
    for (const field of app.viewsState.groupingsShown?.fields ?? []) {
      const name = t(`views.field.${field.field}` as Key);
      add(`group.${field.field}`, t('palette.group_by', { field: name }), () =>
        app.tryView({
          title: t('views.list_by', { field: name }),
          display: 'columns',
          group_by: field.field,
          collapsed: [],
          select: selectOfFilter(app.filter).select,
        }),
      );
    }
  }
  if (app.can('check')) add('check.open', t('check.open'), () => app.openChecks());
  if (app.can('estimate') && app.view === 'list') add('matrix.open', t('matrix.open'), () => app.openMatrix());

  if (app.conflicts.length > 0) add('conflicts.show', t('palette.conflicts', { n: app.conflicts.length }), () => app.openConflicts());
  add('rescan', t('menu.rescan'), () => app.focused());
  add('about', t('menu.about'), () => app.openAbout('info'));
  add('report', t('menu.report'), () => app.openAbout('report'));
  add('marks.all', t('bulk.all'), () => {
    app.setView('list');
    app.markShown();
  });
  if (app.marks.length > 0) add('marks.clear', t('bulk.clear'), () => app.clearMarks());
  add('filter.reset', t('palette.filter_reset'), () => app.resetFilter());
  // The named lists: the ones kept in this browser, then the ones of the engine. Each shows the list with its filter and order.
  for (const list of app.lists) {
    add(`list.mine.${list.name}`, t('palette.list', { name: list.name }), () => {
      app.setView('list');
      app.applyList(list.name);
    });
  }
  for (const list of app.engineLists) {
    add(`list.engine.${list.name}`, t('palette.list_engine', { name: list.name }), () => {
      app.setView('list');
      app.applyEngineList(list.name);
    }, list.summary);
  }

  add('lang.de', t('palette.lang', { name: 'Deutsch' }), () => app.setLang('de'));
  add('lang.en', t('palette.lang', { name: 'English' }), () => app.setLang('en'));
  for (const theme of ['auto', 'light', 'dark'] as const) {
    add(`theme.${theme}`, t('palette.theme', { name: t(`theme.${theme}` as Key) }), () => app.setTheme(theme));
  }
  return out;
}
