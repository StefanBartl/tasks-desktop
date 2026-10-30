<script lang="ts">
  import { onMount, tick } from 'svelte';
  import type { App, View } from './lib/app.svelte';
  import { matches } from 'appkit-ui/keymap';
  import { keymap, pressOf } from './lib/keymap';
  import { ago, dictionaries, translate, type Key } from './lib/i18n';
  import Today from './views/Today.svelte';
  import ListView from './views/ListView.svelte';
  import BoardView from './views/BoardView.svelte';
  import InboxView from './views/InboxView.svelte';
  import CrossView from './views/CrossView.svelte';
  import FinishedView from './views/FinishedView.svelte';
  import ViewsView from './views/ViewsView.svelte';
  import Matrix from './views/Matrix.svelte';
  import TaskDialog from './views/TaskDialog.svelte';
  import ConflictsButton from './views/ConflictsButton.svelte';
  import FinishedDialog from './views/FinishedDialog.svelte';
  import Detail from './views/Detail.svelte';
  import CheckDialog from './views/CheckDialog.svelte';
  import { triageKey } from './lib/inbox';
  import { copyText } from './lib/exportDom';
  import Brand from 'appkit-ui/Brand.svelte';
  import DocsDialog from 'appkit-ui/DocsDialog.svelte';
  import { helpItems } from 'appkit-ui/docs';
  import MenuBar, { type Menu } from 'appkit-ui/MenuBar.svelte';
  import PlanView from './views/PlanView.svelte';
  import Capture from './views/Capture.svelte';
  import PlanWizard from './views/PlanWizard.svelte';
  import DoneDialog from './views/DoneDialog.svelte';
  import PrioDialog from './views/PrioDialog.svelte';
  import BlockDialog from './views/BlockDialog.svelte';
  import DropMoveDialog from './views/DropMoveDialog.svelte';
  import Palette from './views/Palette.svelte';
  import { DOCS, LICENSE, REPO_URL } from './lib/docs';
  import ContextMenu from 'appkit-ui/ContextMenu.svelte';
  import { contextTarget } from 'appkit-ui/contextmenu';
  import { createContextRegistry, viewTarget } from './lib/context';
  import { vaultMenuItems } from './lib/vaultMenu';
  import ConflictCenter from './views/ConflictCenter.svelte';
  import VaultsDialog from './views/VaultsDialog.svelte';
  import AboutDialog from './views/AboutDialog.svelte';
  import Toast from './views/Toast.svelte';

  let { app, code }: { app: App; code: string | null } = $props();

  const t = (key: Key, params: Record<string, string | number> = {}) =>
    translate(app.lang, key, params);

  let chord = $state(false);
  let chordTimer: ReturnType<typeof setTimeout> | undefined;
  let searchBox = $state<HTMLInputElement | null>(null);

  onMount(() => {
    void app.start(code);
    const onFocus = () => void app.focused();
    window.addEventListener('focus', onFocus);
    return () => {
      window.removeEventListener('focus', onFocus);
      clearTimeout(chordTimer);
      app.stop();
    };
  });

  $effect(() => {
    document.documentElement.lang = app.lang;
    if (app.theme === 'auto') document.documentElement.removeAttribute('data-theme');
    else document.documentElement.dataset.theme = app.theme;
  });

  function typing(target: EventTarget | null): boolean {
    return (
      target instanceof HTMLElement &&
      (target.isContentEditable ||
        // A ticked box is not typing: the keys of the page work on after a click on a mark.
        (target.tagName === 'INPUT' && !target.classList.contains('mark')) ||
        ['TEXTAREA', 'SELECT'].includes(target.tagName) ||
        // An open menu has its own keys; a letter there is not a shortcut of the
        // page. (The buttons of the bar are not it: after a choice the focus
        // sits there and j and k are still the list's.) A dialog is modal: what
        // is behind it is not reached by a key.
        target.closest('[role="menu"], dialog') !== null)
    );
  }

  const MODIFIERS = new Set(['Shift', 'Control', 'Alt', 'Meta', 'CapsLock', 'AltGraph']);

  function setChord(on: boolean): void {
    chord = on;
    clearTimeout(chordTimer);
    // A `g` that nothing follows is forgotten.
    if (on) chordTimer = setTimeout(() => (chord = false), keymap.chord.timeoutMs);
  }

  /** The page is a window of one task (detached from a float): its detail stands alone, in place of the view. */
  const alone = $derived(app.solo && app.selected !== null);

  /**
   * The key `c` in the float of a task, on one of its buttons (not in a field): a new task, as from the page. The
   * capture opens over the float, and the task it makes is shown in the float after it, so that one task after the
   * other is captured with c, its title and Enter.
   */
  function captureFromFloat(event: KeyboardEvent): boolean {
    const target = event.target;
    if (event.key !== 'c' || event.repeat || !(target instanceof HTMLElement)) return false;
    if (!target.closest('dialog')?.classList.contains('peek')) return false;
    if (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)) return false;
    if (target.closest('[role="menu"]') !== null) return false;
    event.preventDefault();
    app.openCapture();
    return true;
  }

  function onKey(event: KeyboardEvent): void {
    // The palette is not a single-key shortcut: it opens with Ctrl or Cmd and K, also in a field and with the keys off.
    if (app.phase === 'ready' && matches(keymap.palette, pressOf(event))) {
      event.preventDefault();
      // Only opens: a second press while it is open leaves it as it is (Escape closes).
      app.openPalette();
      return;
    }
    if (!app.shortcuts || app.phase !== 'ready') return;
    // A key an element of the page already took (the Escape that closed a popup) is not also a key of the page.
    if (event.defaultPrevented) return;
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    if (!event.shiftKey && captureFromFloat(event)) return;
    if (typing(event.target)) return;
    if (MODIFIERS.has(event.key)) return;
    if (chord) {
      setChord(false);
      // Only a key that is part of the chord is taken; Tab and the others
      // keep doing what they do.
      const target = keymap.chord.targets[event.key];
      if (target !== undefined) {
        app.setView(target as View);
        event.preventDefault();
        return;
      }
    }
    // The detail of a window of one task stands in place of the view, and the float of a task over it: the keys of
    // the view do not reach what is hidden behind them (a focus that fell out of the float onto the page would move the
    // list under it, or write a field of the inbox).
    const view = alone || app.taskFloatOpen ? null : app.view;
    // The board: Shift with j, k, h or l writes (reorder inside the group, set the status). The letter's case is not
    // trusted: CapsLock turns a plain j into 'J'.
    if (view === 'board' && event.shiftKey && /^[jkhl]$/i.test(event.key)) {
      event.preventDefault();
      const id = app.selectedId;
      if (id !== null && !event.repeat) {
        const key = event.key.toLowerCase();
        if (key === 'j' || key === 'k') void app.stepCard(id, key === 'j' ? 1 : -1);
        else void app.shiftColumn(id, key === 'l' ? 1 : -1);
      }
      return;
    }
    // The inbox: a single key writes a field of the selected task. Holding a key does not write it again.
    if (view === 'inbox') {
      // The letter's case is not trusted here either: with CapsLock on, j and u arrive as J and U (without Shift).
      const letter = event.key.length === 1 && !event.shiftKey ? event.key.toLowerCase() : event.key;
      if (letter === 'j' || letter === 'k') {
        event.preventDefault();
        app.moveSelectionInbox(letter === 'j' ? 1 : -1);
        return;
      }
      if (letter === 'u') {
        event.preventDefault();
        if (!event.repeat) void app.undo();
        return;
      }
    }
    if (view === 'inbox' && event.key !== 'g' && event.key !== 'G') {
      if (triageKey(event.key, event.shiftKey)) {
        event.preventDefault();
        if (!event.repeat) void app.triage(event.key, event.shiftKey);
        return;
      }
    }
    switch (event.key) {
      case 'g':
        setChord(true);
        break;
      case 'c':
        event.preventDefault();
        app.openCapture();
        break;
      case 'j':
        if (view === 'list') app.moveSelection(1);
        else if (view === 'inbox') app.moveSelectionInbox(1);
        else if (view === 'board') app.moveSelectionInColumn(1);
        break;
      case 'k':
        if (view === 'list') app.moveSelection(-1);
        else if (view === 'inbox') app.moveSelectionInbox(-1);
        else if (view === 'board') app.moveSelectionInColumn(-1);
        break;
      // The board: h and l change the column (Shift with j, k, h, l writes, above).
      case 'h':
        if (view === 'board') app.moveSelectionAcross(-1);
        break;
      case 'l':
        if (view === 'board') app.moveSelectionAcross(1);
        break;
      case 'o':
        // The list has no detail beside it: the selected task opens in the float.
        if (view === 'list' && app.selectedId !== null && !event.repeat) {
          event.preventDefault();
          app.peek(app.selectedId);
        }
        break;
      case 'x':
        // Holding the key does not flip the mark back and forth.
        if (view === 'list' && app.selectedId !== null && !event.repeat) {
          const id = app.selectedId;
          if (app.shown.some((t) => t.id === id)) app.toggleMark(id);
        }
        break;
      case 'e':
        if (view === 'list' && !event.repeat) {
          event.preventDefault();
          app.openMatrix();
        }
        break;
      case '/':
        if (view === 'list') {
          event.preventDefault();
          searchBox?.focus();
        }
        break;
      case 'Escape':
        // The float of a task closes itself (the dialog takes its Escape); the selection and the marks behind it stay.
        if (app.taskFloatOpen) break;
        // In the list the marks go first; elsewhere there are none to see. A window of one task lets go of it and shows
        // its view.
        if (view === 'list' && app.marks.length > 0) app.clearMarks();
        else app.select(null);
        break;
    }
  }

  // The code of the hub names what is missing; a code this page does not
  // know gets the general words.
  const setupKey = $derived.by(() => {
    const code = app.problem ?? '';
    return Object.hasOwn(dictionaries.en, `setup.${code}.title`) ? code : 'unknown';
  });

  const age = $derived(app.cachedAt === null ? '' : ago(app.lang, Date.now() - app.cachedAt));

  /** What the bar says of the connection: the list from the cache, a stream the hub refused (too many windows), or the stream. */
  const connState = $derived(
    app.cachedAt !== null ? 'cached' : app.streamsFull && app.connection !== 'live' ? 'full' : app.connection,
  );

  /** The entries of the menu that export what the view shows: a file for each format, then the clipboard. */
  const exportItems = (ready: boolean) =>
    // Only where the view shows tasks: an export from Today or the inbox would take the list, which is not shown there.
    (
      [
        ['menu.save_csv', 'csv', 'save'],
        ['menu.save_json', 'json', 'save'],
        ['menu.save_md', 'markdown', 'save'],
        ['menu.copy_csv', 'csv', 'copy'],
        ['menu.copy_json', 'json', 'copy'],
        ['menu.copy_md', 'markdown', 'copy'],
      ] as const
    )
      .map(([label, format, how]) => ({
        kind: 'action' as const,
        label: t(label),
        hint: t(`hint.item.${label}` as Key),
        disabled: !ready || !app.exportable,
        onselect: () => void app.exportView(format, how),
      }))
      .concat({ kind: 'action' as const, label: t('menu.print_view'), hint: t('hint.item.menu.print_view'), disabled: !ready || !app.exportable, onselect: () => void app.printView() });

  /** The task the engine names as the next one to take: the one the tile of that name shows. */
  const nextTaskId = $derived(app.next?.task?.id ?? null);

  /** The list with the cursor in its search box. */
  async function findTask(): Promise<void> {
    app.setView('list');
    await tick();
    searchBox?.focus();
  }

  /** The id of the selected task on the clipboard, and a word about it. */
  async function copyId(): Promise<void> {
    const id = app.selectedId;
    if (id === null) return;
    const ok = await copyText(navigator.clipboard, id);
    app.tell(ok ? 'ok' : 'error', ok ? 'menu.id_copied' : 'menu.copy_id_failed');
  }

  // The menu bar of the page (the native shell shows the same entries).
  const menus = $derived.by((): Menu[] => {
    const ready = app.phase === 'ready';
    return [
      {
        id: 'tasks',
        label: t('menu.tasks'),
        hint: t('hint.ui.menu.tasks'),
        items: [
          { kind: 'section', label: t('menu.sec.create') },
          {
            kind: 'action',
            label: t('menu.capture'),
            hint: t('hint.item.menu.capture'),
            shortcut: app.shortcuts ? 'C' : undefined,
            disabled: !ready,
            onselect: () => app.openCapture(),
          },
          { kind: 'section', label: t('menu.sec.find') },
          {
            kind: 'action',
            label: t('menu.find_task'),
            hint: t('hint.item.menu.find_task'),
            shortcut: app.shortcuts ? '/' : undefined,
            disabled: !ready,
            onselect: () => void findTask(),
          },
          {
            kind: 'action',
            label: t('menu.palette'),
            hint: t('hint.item.menu.palette'),
            shortcut: 'Ctrl+K',
            disabled: !ready,
            onselect: () => app.openPalette(),
          },
          {
            kind: 'action',
            label: t('menu.next_task'),
            hint: t('hint.item.menu.next_task'),
            disabled: !ready || nextTaskId === null,
            onselect: () => nextTaskId !== null && app.reveal(nextTaskId),
          },
          { kind: 'section', label: t('menu.sec.edit') },
          {
            kind: 'action',
            label: t('menu.copy_id'),
            hint: t('hint.item.menu.copy_id'),
            disabled: !ready || app.selectedId === null,
            onselect: () => void copyId(),
          },
          {
            kind: 'action',
            label: t('menu.reset_filter'),
            hint: t('hint.item.menu.reset_filter'),
            disabled: !ready,
            onselect: () => app.resetFilter(),
          },
        ],
      },
      {
        id: 'project',
        label: t('menu.project'),
        hint: t('hint.ui.menu.project'),
        items: [
          ...vaultMenuItems(app),
          {
            kind: 'action',
            label: t('menu.rescan'),
            hint: t('hint.item.menu.rescan'),
            disabled: !ready,
            onselect: () => void app.focused(),
          },
          { kind: 'section', label: t('menu.sec.plan') },
          {
            kind: 'action',
            label: t('plan.new.button'),
            hint: t('hint.item.plan.new.button'),
            disabled: app.phase !== 'ready' || !app.can('plan_new'),
            onselect: () => app.openPlanWizard(),
          },
          { kind: 'section', label: t('menu.sec.export') },
          { kind: 'info', label: t('menu.export_where') },
          ...exportItems(ready),
          { kind: 'section', label: t('menu.sec.page') },
          { kind: 'action', label: t('menu.reload'), hint: t('hint.item.menu.reload'), onselect: () => window.location.reload() },
        ],
      },
      {
        id: 'view',
        label: t('menu.view'),
        hint: t('hint.ui.menu.view'),
        items: [
          { kind: 'section', label: t('menu.sec.views') },
          {
            kind: 'radio',
            label: t('nav.today'),
            hint: t('hint.item.nav.today'),
            checked: app.view === 'today',
            onselect: () => app.setView('today'),
          },
          {
            kind: 'radio',
            label: t('nav.list'),
            hint: t('hint.item.nav.list'),
            checked: app.view === 'list',
            onselect: () => app.setView('list'),
          },
          {
            kind: 'radio',
            label: t('nav.board'),
            hint: t('hint.item.nav.board'),
            disabled: !app.can('reorder'),
            checked: app.view === 'board',
            onselect: () => app.setView('board'),
          },
          {
            kind: 'radio',
            label: t('nav.plan'),
            hint: t('hint.item.nav.plan'),
            checked: app.view === 'plan',
            onselect: () => app.setView('plan'),
          },
          {
            kind: 'radio',
            label: t('nav.inbox'),
            hint: t('hint.item.nav.inbox'),
            checked: app.view === 'inbox',
            onselect: () => app.setView('inbox'),
          },
          {
            kind: 'radio',
            label: t('nav.cross'),
            hint: t('hint.item.nav.cross'),
            checked: app.view === 'cross',
            onselect: () => app.setView('cross'),
          },
          ...(app.can('finished')
            ? [
                {
                  kind: 'radio' as const,
                  label: t('nav.done'),
                  hint: t('hint.item.nav.done'),
                  checked: app.view === 'done',
                  onselect: () => app.setView('done'),
                },
              ]
            : []),
          ...(app.can('views')
            ? [
                {
                  kind: 'radio' as const,
                  label: t('nav.views'),
                  hint: t('hint.item.nav.views'),
                  checked: app.view === 'views',
                  onselect: () => app.setView('views'),
                },
              ]
            : []),
          // The export belongs to the view that is shown: it takes what that view draws.
          { kind: 'section', label: t('menu.sec.export') },
          ...exportItems(ready),
          { kind: 'section', label: t('menu.sec.tiles') },
          {
            kind: 'action',
            label: t('menu.show_tiles', { n: app.hiddenTiles.length }),
            hint: t('hint.item.menu.show_tiles'),
            disabled: app.hiddenTiles.length === 0,
            onselect: () => app.showTiles(),
          },
          {
            kind: 'action',
            label: t('menu.reset_order'),
            hint: t('hint.item.menu.reset_order'),
            disabled: !app.tileOrderChanged,
            onselect: () => app.resetTileOrder(),
          },
          { kind: 'section', label: t('theme.label') },
          ...(['auto', 'light', 'dark'] as const).map((value) => ({
            kind: 'radio' as const,
            label: t(`theme.${value}` as Key),
            hint: t(`hint.item.theme.${value}` as Key),
            checked: app.theme === value,
            onselect: () => app.setTheme(value),
          })),
        ],
      },
      {
        id: 'options',
        label: t('menu.options'),
        hint: t('hint.ui.menu.options'),
        items: [
          { kind: 'section', label: t('lang.label') },
          {
            kind: 'radio',
            label: 'Deutsch',
            hint: t('hint.item.lang.de'),
            checked: app.lang === 'de',
            onselect: () => app.setLang('de'),
          },
          {
            kind: 'radio',
            label: 'English',
            hint: t('hint.item.lang.en'),
            checked: app.lang === 'en',
            onselect: () => app.setLang('en'),
          },
          { kind: 'section', label: t('menu.sec.behaviour') },
          {
            kind: 'check',
            label: t('shortcuts.label'),
            hint: t('hint.item.shortcuts.label'),
            checked: app.shortcuts,
            onselect: () => app.setShortcuts(!app.shortcuts),
          },
          {
            kind: 'check',
            label: t('menu.short_areas'),
            hint: t('hint.item.menu.short_areas'),
            checked: app.shortAreas,
            onselect: () => app.setShortAreas(!app.shortAreas),
          },
          { kind: 'section', label: t('menu.sec.export') },
          { kind: 'info', label: t('menu.export_where') },
        ],
      },
      {
        id: 'help',
        label: t('menu.help'),
        hint: t('hint.ui.menu.help'),
        items: [
          {
            kind: 'action',
            label: t('menu.about'),
            hint: t('hint.item.menu.about'),
            disabled: !app.canAbout,
            onselect: () => app.openAbout('info'),
          },
          {
            kind: 'action',
            label: t('menu.report'),
            hint: t('hint.item.menu.report'),
            disabled: !app.canAbout,
            onselect: () => app.openAbout('report'),
          },
          ...helpItems({
            text: (key, params) => t(key, params),
            docs: DOCS,
            opendoc: (id) => openDocs(id),
            opensearch: () => openDocs(null),
            repo: { url: REPO_URL },
            license: LICENSE,
          }),
        ],
      },
    ];
  });
  const contextRegistry = $derived(createContextRegistry(app));
  // The context menu is built at once (the browser's menu is replaced or not before the event is over), so the fields
  // of the engine for "open as a view" are read when the page is ready, not at the first right click.
  $effect(() => {
    if (app.phase === 'ready' && app.can('groupings')) void app.viewsState.loadGroupings();
  });
  // The documentation window: opened at a document from the Help menu, or at its search box.
  let docsOpen = $state(false);
  let docsAt = $state<string | null>(null);
  function openDocs(id: string | null): void {
    docsAt = id;
    docsOpen = true;
  }
</script>

<svelte:window onkeydown={onKey} />

<div class="shell">
  <header class="bar">
    <Brand label={t('app.title')} hint={t('hint.ui.brand')} onclick={() => app.setView('today')} />
    <MenuBar {menus} label={t('menu.label')} />
    <span class="spacer"></span>
    {#if app.conflicts.length > 0}
      <ConflictsButton {app} />
    {/if}
    {#if app.phase === 'ready'}
      <span class="conn conn-{app.connection}" class:conn-full={connState === 'full'} role="status" data-hint={t(`hint.ui.conn.${connState}` as Key)}>
        {t(`conn.${connState}` as Key)}
      </span>
    {/if}
  </header>

  <main tabindex="-1" use:contextTarget={viewTarget(app.view)}>
    <!-- The data is somebody else's text: one task that breaks a view must
         not take the whole page with it. -->
    <svelte:boundary>
      {#if app.phase === 'starting'}
        <p class="note">{t('state.loading')}</p>
      {:else if app.phase === 'needs_pairing'}
        <section class="card centered">
          <h1>{t('state.needs_pairing.title')}</h1>
          {#if app.pairRefused}
            <p role="alert">{t('state.needs_pairing.refused')}</p>
          {/if}
          <p>{t('state.needs_pairing.body')}</p>
          <pre><code>tasks-hub open</code></pre>
        </section>
      {:else if app.phase === 'offline'}
        <section class="card centered">
          <h1>{t('state.offline.title')}</h1>
          <p>{t('state.offline.body')}</p>
          <pre><code>tasks-hub serve</code></pre>
        </section>
      {:else if app.phase === 'unavailable'}
        <section class="card centered">
          <h1>{t(`setup.${setupKey}.title` as Key)}</h1>
          <p>{t(`setup.${setupKey}.body` as Key)}</p>
          <p class="muted">{t('state.unavailable.body')} <code>{app.problem ?? '?'}</code></p>
        </section>
      {:else}
        {#if app.readOnly}
          <p class="banner" role="status">{t('web.readonly.banner')}</p>
        {/if}
        {#if app.cachedAt !== null}
          <p class="banner">{t('state.stale', { age })}</p>
        {/if}
        {#if (app.snapshot?.incomplete.length ?? 0) > 0}
          <p class="banner" role="alert">{t('data.incomplete')}</p>
        {/if}
        <h1 class="sr-only">
          {alone
            ? t('peek.label')
            : app.view === 'today'
            ? t('nav.today')
            : app.view === 'plan'
              ? t('nav.plan')
              : app.view === 'board'
                ? t('nav.board')
                : app.view === 'inbox'
                  ? t('nav.inbox')
                  : app.view === 'cross'
                    ? t('nav.cross')
                    : app.view === 'done'
                      ? t('nav.done')
                      : app.view === 'views'
                        ? t('nav.views')
                        : t('nav.list')}
        </h1>
        {#if alone}
          <!-- A window of one task (detached from a float): its detail, alone, as wide as the window allows. -->
          <div class="solo"><Detail {app} /></div>
        {:else if app.view === 'today'}
          <Today {app} />
        {:else if app.view === 'plan'}
          <PlanView {app} />
        {:else if app.view === 'board'}
          <!-- The board is the built-in view of the views; an engine that keeps no views shows it alone. -->
          {#if app.can('views')}<ViewsView {app} board />{:else}<BoardView {app} />{/if}
        {:else if app.view === 'inbox'}
          <InboxView {app} />
        {:else if app.view === 'cross'}
          <CrossView {app} />
        {:else if app.view === 'done'}
          <FinishedView {app} />
        {:else if app.view === 'views'}
          <ViewsView {app} />
        {:else}
          <ListView {app} bind:searchBox />
        {/if}
      {/if}

      {#snippet failed(_error, reset)}
        <section class="card centered" role="alert">
          <h1>{t('error.title')}</h1>
          <p>{t('error.body')}</p>
          <button
            type="button"
            onclick={() => {
              reset();
              window.location.reload();
            }}>{t('error.reload')}</button
          >
        </section>
      {/snippet}
    </svelte:boundary>
    <!-- The context menu belongs to the content it was opened on: inside the main landmark. -->
    {#if app.phase === 'ready'}<ContextMenu registry={contextRegistry} label={t('ctx.label')} />{/if}
  </main>
  {#if app.phase === 'ready'}
    <Capture {app} />
    <PlanWizard {app} />
    <DoneDialog {app} />
    <PrioDialog {app} />
    <Matrix {app} />
    <TaskDialog {app} />
    <FinishedDialog {app} />
    <CheckDialog {app} />
    <BlockDialog {app} />
    <DropMoveDialog {app} />
    <Palette {app} />
    <DocsDialog
      open={docsOpen}
      docs={DOCS}
      docId={docsAt}
      onclose={() => (docsOpen = false)}
      labels={{
        title: t('kit.docs.title'),
        label: t('kit.docs.label'),
        placeholder: t('kit.docs.placeholder'),
        none: t('kit.docs.none'),
        list: t('kit.docs.list'),
        close: t('kit.dismiss'),
      }}
    />
    <ConflictCenter {app} />
    <VaultsDialog {app} />
  {/if}
  <!-- Outside the ready block: the Info dialog and its report are there when the engine is not (app.canAbout). -->
  <AboutDialog {app} />
  <!-- While the float of a task is open the toast is drawn inside it: the float is modal, and the Undo out here could not
       be reached. -->
  {#if !app.taskFloatOpen}<Toast {app} />{/if}
</div>

<style>
  .shell {
    display: flex;
    flex-direction: column;
    height: 100%;
  }
  .bar {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    padding: 0.5rem 1rem;
    background: var(--surface);
    border-bottom: 1px solid var(--border);
    flex-wrap: wrap;
  }
  .spacer {
    flex: 1;
  }
  .conn {
    font-size: 0.8rem;
    color: var(--muted);
  }
  .conn-live {
    color: var(--ok);
  }
  .conn-offline {
    color: var(--bad);
  }
  .conn-full {
    color: var(--warn);
  }
  main {
    flex: 1;
    min-height: 0;
    overflow: auto;
    padding: 1rem;
  }
  .note,
  .muted {
    color: var(--muted);
  }
  .solo {
    max-width: 60rem;
    margin: 0 auto;
  }
  /* The page scrolls, not the card: the button that finishes the task sticks to the lower edge of the window. */
  .solo :global(aside.detail) {
    max-height: none;
    overflow: visible;
  }
  .card {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 1.25rem;
  }
  .centered {
    max-width: 38rem;
    margin: 3rem auto;
  }
  .banner {
    background: var(--surface-2);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 0.4rem 0.75rem;
    margin: 0 0 1rem;
    color: var(--warn);
  }
  pre {
    background: var(--surface-2);
    border-radius: var(--radius);
    padding: 0.6rem 0.8rem;
    overflow: auto;
  }

  /* The page for the printer of a view (exportDom.printSheet) stands in the document only while the print dialog is
     open; while it does, nothing else is printed. Black on white whatever the theme: it is paper or a PDF. */
  :global(#view-print) {
    display: none;
  }
  @media print {
    :global(html.print-view body > *:not(#view-print)) {
      display: none !important;
    }
    /* With "background graphics" in the dialog a dark theme would print its page colour around the sheet. */
    :global(html.print-view),
    :global(html.print-view body) {
      background: white !important;
    }
    :global(html.print-view #view-print) {
      display: block;
      color: black;
      background: white;
      font-size: 10pt;
    }
    :global(#view-print h1) {
      font-size: 14pt;
      margin: 0 0 0.3em;
    }
    :global(#view-print h2) {
      font-size: 11pt;
      margin: 1em 0 0.3em;
      break-after: avoid;
    }
    :global(#view-print p) {
      margin: 0;
    }
    :global(#view-print table) {
      width: 100%;
      border-collapse: collapse;
      margin-top: 0.5em;
    }
    :global(#view-print th),
    :global(#view-print td) {
      border: 1px solid gray;
      padding: 0.15em 0.4em;
      text-align: left;
      vertical-align: top;
      /* A long id or a title without spaces breaks in the cell instead of widening the table past the page. */
      overflow-wrap: anywhere;
    }
    :global(#view-print tr) {
      break-inside: avoid;
    }
  }
</style>
