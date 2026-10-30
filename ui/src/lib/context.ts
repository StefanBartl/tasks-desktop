// What the context menu offers, per kind of target (the kit's `ContextRegistry`): the entries come from the providers of
// every target around the pointer, the innermost first. The page declares the targets (`use:contextTarget`); what an
// entry does goes through the same methods of `App` as the buttons and keys do (the engine judges, WEB-13).
import { ContextRegistry, type ContextTarget } from 'appkit-ui/contextmenu';
import type { MenuItem } from 'appkit-ui/menu';
import type { App } from './app.svelte';
import type { TaskEntry, ViewSelect } from './contract';
import type { ExportFormat } from './export';
import { translate, type Key } from './i18n';

/** A target that stands for a selection of tasks (an area, a plan, a group of a view): "open as a view" for it. */
export function selectionTarget(title: string, select: Partial<ViewSelect>): ContextTarget {
  return { kind: 'selection', id: title, data: { title, select } };
}

/** A task (a row, a card): its entries and the view of its area. */
export function taskTarget(task: TaskEntry): ContextTarget {
  return { kind: 'task', id: task.id, data: task };
}

/** The view that is shown, as the target of everything on it that is no target of its own. */
export function viewTarget(view: string): ContextTarget {
  return { kind: 'view', id: view };
}

/** The views that make a task: the entries "new task" is offered on. */
const WRITING_VIEWS = new Set(['today', 'list', 'board', 'inbox', 'plan', 'cross']);

/** The formats the context menu copies in, as the button Export names them. */
const COPY_FORMATS: readonly [ExportFormat, string][] = [
  ['markdown', 'Markdown'],
  ['csv', 'CSV'],
  ['json', 'JSON'],
];

export function createContextRegistry(app: App): ContextRegistry {
  const registry = new ContextRegistry();
  const t = (key: Key, params: Record<string, string | number> = {}) => translate(app.lang, key, params);

  /** The entries that copy `tasks` (read when chosen: the list may have changed since the menu opened). */
  const copyEntries = (tasks: () => readonly TaskEntry[]): MenuItem[] => [
    { kind: 'section', label: t('menu.sec.export') },
    ...COPY_FORMATS.map(
      ([format, name]): MenuItem => ({
        kind: 'action',
        label: t('export.copy', { format: name }),
        hint: t('hint.ctx.copy_tasks'),
        onselect: () => void app.copyTasks(tasks(), format),
      }),
    ),
  ];

  registry.provide('selection', (target) => {
    const data = target.data as { title: string; select: Partial<ViewSelect> };
    return [...copyEntries(() => app.tasksOfSelect(data.select)), ...app.viewMenuEntries(data.title, data.select)];
  });

  registry.provide('task', (target, env) => {
    const task = target.data as TaskEntry;
    const items: MenuItem[] = [
      { kind: 'action', label: t('ctx.show'), hint: t('hint.ctx.show'), onselect: () => app.reveal(task.id) },
      {
        kind: 'action',
        label: t('ctx.copy_id'),
        onselect: () => {
          void navigator.clipboard.writeText(task.id).then(
            () => app.tell('ok', 'ctx.copied', { id: task.id }),
            () => app.tell('error', 'about.copy_failed'),
          );
        },
      },
    ];
    // What the engine can write; one task or the whole selection (the same writes as the keys, each one asked of it).
    if (app.can('ops') && env.selection.length <= 1) {
      items.push({ kind: 'section', label: t('field.status') });
      for (const status of app.ranges.statuses) {
        items.push({
          kind: 'radio',
          label: t(`status.${status}` as Key),
          checked: task.status === status,
          disabled: app.saving,
          onselect: () => void app.setField(task.id, 'status', status),
        });
      }
      items.push({ kind: 'section', label: t('field.prio') });
      for (const prio of app.ranges.prios) {
        items.push({
          kind: 'radio',
          label: `P${prio}`,
          checked: task.prio === prio,
          disabled: app.saving,
          onselect: () => void app.setField(task.id, 'prio', prio),
        });
      }
    }
    // The task, or the marked ones of the list when it is one of them (`selection`), each as the list holds it now.
    const ids = env.selection.map((s) => s.id);
    const chosen = () => app.tasks.filter((entry) => ids.includes(entry.id));
    return [...items, ...copyEntries(chosen), ...app.viewMenuEntries(task.area, { areas: [task.area] })];
  });

  registry.provide('view', (target) => {
    if (!WRITING_VIEWS.has(target.id ?? '')) return [];
    return [
      { kind: 'action', label: t('menu.capture'), shortcut: 'C', onselect: () => app.openCapture() },
      { kind: 'action', label: t('menu.palette'), shortcut: 'Ctrl+K', onselect: () => app.openPalette() },
    ];
  });

  return registry;
}
