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
  import CheckDialog from './views/CheckDialog.svelte';
  import { triageKey } from './lib/inbox';
  import { copyText } from './lib/exportDom';
  import MenuBar, { type Menu } from 'appkit-ui/MenuBar.svelte';
  import PlanView from './views/PlanView.svelte';
  import Capture from './views/Capture.svelte';
  import PlanWizard from './views/PlanWizard.svelte';
  import DoneDialog from './views/DoneDialog.svelte';
  import PrioDialog from './views/PrioDialog.svelte';
  import BlockDialog from './views/BlockDialog.svelte';
  import DropMoveDialog from './views/DropMoveDialog.svelte';
  import Palette from './views/Palette.svelte';
  import ContextMenu from './views/ContextMenu.svelte';
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
    if (event.ctrlKey || event.metaKey || event.altKey || typing(event.target)) return;
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
    // The board: Shift with j, k, h or l writes (reorder inside the group, set the status). The letter's case is not
    // trusted: CapsLock turns a plain j into 'J'.
    if (app.view === 'board' && event.shiftKey && /^[jkhl]$/i.test(event.key)) {
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
    if (app.view === 'inbox') {
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
    if (app.view === 'inbox' && event.key !== 'g' && event.key !== 'G') {
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
        if (app.view === 'list') app.moveSelection(1);
        else if (app.view === 'inbox') app.moveSelectionInbox(1);
        else if (app.view === 'board') app.moveSelectionInColumn(1);
        break;
      case 'k':
        if (app.view === 'list') app.moveSelection(-1);
        else if (app.view === 'inbox') app.moveSelectionInbox(-1);
        else if (app.view === 'board') app.moveSelectionInColumn(-1);
        break;
      // The board: h and l change the column (Shift with j, k, h, l writes, above).
      case 'h':
        if (app.view === 'board') app.moveSelectionAcross(-1);
        break;
      case 'l':
        if (app.view === 'board') app.moveSelectionAcross(1);
        break;
      case 'x':
        // Holding the key does not flip the mark back and forth.
        if (app.view === 'list' && app.selectedId !== null && !event.repeat) {
          const id = app.selectedId;
          if (app.shown.some((t) => t.id === id)) app.toggleMark(id);
        }
        break;
      case 'e':
        if (app.view === 'list' && !event.repeat) {
          event.preventDefault();
          app.openMatrix();
        }
        break;
      case '/':
        if (app.view === 'list') {
          event.preventDefault();
          searchBox?.focus();
        }
        break;
      case 'Escape':
        // In the list the marks go first; elsewhere there are none to see.
        if (app.view === 'list' && app.marks.length > 0) app.clearMarks();
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
    ).map(([label, format, how]) => ({
      kind: 'action' as const,
      label: t(label),
      disabled: !ready || !app.exportable,
      onselect: () => void app.exportView(format, how),
    }));

  /** The task the engine names as the next one to take: the one the tile of that name shows. */
  const nextTaskId = $derived(app.next?.task?.id ?? null);
  const areaCount = $derived(new Set(app.tasks.map((x) => x.area)).size);

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
    const vault = app.snapshot?.vault?.id;
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
            shortcut: app.shortcuts ? 'C' : undefined,
            disabled: !ready,
            onselect: () => app.openCapture(),
          },
          { kind: 'section', label: t('menu.sec.find') },
          {
            kind: 'action',
            label: t('menu.find_task'),
            shortcut: app.shortcuts ? '/' : undefined,
            disabled: !ready,
            onselect: () => void findTask(),
          },
          {
            kind: 'action',
            label: t('menu.palette'),
            shortcut: 'Ctrl+K',
            disabled: !ready,
            onselect: () => app.openPalette(),
          },
          {
            kind: 'action',
            label: t('menu.next_task'),
            disabled: !ready || nextTaskId === null,
            onselect: () => nextTaskId !== null && app.reveal(nextTaskId),
          },
          { kind: 'section', label: t('menu.sec.edit') },
          {
            kind: 'action',
            label: t('menu.copy_id'),
            disabled: !ready || app.selectedId === null,
            onselect: () => void copyId(),
          },
          {
            kind: 'action',
            label: t('menu.reset_filter'),
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
          { kind: 'section', label: t('menu.sec.vault') },
          ...(vault ? [{ kind: 'info' as const, label: t('menu.vault', { name: vault }) }] : []),
          ...(ready ? [{ kind: 'info' as const, label: t('menu.vault_info', { areas: areaCount, tasks: app.tasks.length }) }] : []),
          ...(app.vaultList?.vaults ?? []).map((v) => ({
            kind: 'radio' as const,
            label: v.name === 'main' ? `${v.label} (main)` : `${v.name} (${v.label})`,
            checked: v.name === app.vaultList?.active,
            disabled: !ready || app.vaultBusy,
            onselect: () => void app.selectVault(v.name),
          })),
          {
            kind: 'action' as const,
            label: t('menu.vault_reveal'),
            disabled: !ready || app.vaultBusy,
            onselect: () => void app.revealVault(),
          },
          {
            kind: 'action' as const,
            label: t('menu.vaults_manage'),
            disabled: !ready || !app.vaultList,
            onselect: () => app.openVaults(),
          },
          {
            kind: 'action',
            label: t('menu.rescan'),
            disabled: !ready,
            onselect: () => void app.focused(),
          },
          { kind: 'section', label: t('menu.sec.plan') },
          {
            kind: 'action',
            label: t('plan.new.button'),
            disabled: app.phase !== 'ready' || !app.can('plan_new'),
            onselect: () => app.openPlanWizard(),
          },
          { kind: 'section', label: t('menu.sec.export') },
          { kind: 'info', label: t('menu.export_where') },
          ...exportItems(ready),
          { kind: 'section', label: t('menu.sec.page') },
          { kind: 'action', label: t('menu.reload'), onselect: () => window.location.reload() },
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
            checked: app.view === 'today',
            onselect: () => app.setView('today'),
          },
          {
            kind: 'radio',
            label: t('nav.list'),
            checked: app.view === 'list',
            onselect: () => app.setView('list'),
          },
          {
            kind: 'radio',
            label: t('nav.board'),
            disabled: !app.can('reorder'),
            checked: app.view === 'board',
            onselect: () => app.setView('board'),
          },
          {
            kind: 'radio',
            label: t('nav.plan'),
            checked: app.view === 'plan',
            onselect: () => app.setView('plan'),
          },
          {
            kind: 'radio',
            label: t('nav.inbox'),
            checked: app.view === 'inbox',
            onselect: () => app.setView('inbox'),
          },
          {
            kind: 'radio',
            label: t('nav.cross'),
            checked: app.view === 'cross',
            onselect: () => app.setView('cross'),
          },
          ...(app.can('finished')
            ? [
                {
                  kind: 'radio' as const,
                  label: t('nav.done'),
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
            disabled: app.hiddenTiles.length === 0,
            onselect: () => app.showTiles(),
          },
          {
            kind: 'action',
            label: t('menu.reset_order'),
            disabled: !app.tileOrderChanged,
            onselect: () => app.resetTileOrder(),
          },
          { kind: 'section', label: t('theme.label') },
          ...(['auto', 'light', 'dark'] as const).map((value) => ({
            kind: 'radio' as const,
            label: t(`theme.${value}` as Key),
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
            checked: app.lang === 'de',
            onselect: () => app.setLang('de'),
          },
          {
            kind: 'radio',
            label: 'English',
            checked: app.lang === 'en',
            onselect: () => app.setLang('en'),
          },
          { kind: 'section', label: t('menu.sec.behaviour') },
          {
            kind: 'check',
            label: t('shortcuts.label'),
            checked: app.shortcuts,
            onselect: () => app.setShortcuts(!app.shortcuts),
          },
          {
            kind: 'check',
            label: t('menu.short_areas'),
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
            disabled: !app.canAbout,
            onselect: () => app.openAbout('info'),
          },
          {
            kind: 'action',
            label: t('menu.report'),
            disabled: !app.canAbout,
            onselect: () => app.openAbout('report'),
          },
        ],
      },
    ];
  });
</script>

<svelte:window onkeydown={onKey} />

<div class="shell">
  <header class="bar">
    <strong class="brand">{t('app.title')}</strong>
    <MenuBar {menus} label={t('menu.label')} />
    <span class="spacer"></span>
    {#if app.conflicts.length > 0}
      <button type="button" class="conflicts" data-hint={t('hint.ui.conflicts')} onclick={() => app.openConflicts()}
        >{t('conflicts.button', { n: app.conflicts.length })}</button
      >
    {/if}
    {#if app.phase === 'ready'}
      <span class="conn conn-{app.connection}" role="status" data-hint={t(`hint.ui.conn.${app.cachedAt !== null ? 'cached' : app.connection}` as Key)}>
        {app.cachedAt !== null ? t('conn.cached') : t(`conn.${app.connection}` as Key)}
      </span>
    {/if}
  </header>

  <main tabindex="-1">
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
        {#if app.cachedAt !== null}
          <p class="banner">{t('state.stale', { age })}</p>
        {/if}
        {#if (app.snapshot?.incomplete.length ?? 0) > 0}
          <p class="banner" role="alert">{t('data.incomplete')}</p>
        {/if}
        <h1 class="sr-only">
          {app.view === 'today'
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
        {#if app.view === 'today'}
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
    {#if app.phase === 'ready'}<ContextMenu {app} />{/if}
  </main>
  {#if app.phase === 'ready'}
    <Capture {app} />
    <PlanWizard {app} />
    <DoneDialog {app} />
    <PrioDialog {app} />
    <Matrix {app} />
    <TaskDialog {app} />
    <CheckDialog {app} />
    <BlockDialog {app} />
    <DropMoveDialog {app} />
    <Palette {app} />
    <ConflictCenter {app} />
    <VaultsDialog {app} />
  {/if}
  <!-- Outside the ready block: the Info dialog and its report are there when the engine is not (app.canAbout). -->
  <AboutDialog {app} />
  <Toast {app} />
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
  .brand {
    letter-spacing: 0.02em;
  }
  .spacer {
    flex: 1;
  }
  .conflicts {
    background: var(--surface-2);
    color: var(--bad);
    border: 1px solid var(--bad);
    border-radius: var(--radius);
    padding: 0.15rem 0.6rem;
    font-size: 0.8rem;
    cursor: pointer;
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
</style>
