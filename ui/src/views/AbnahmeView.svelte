<script lang="ts">
  // The acceptance view: the live-check tasks whose test sheet is green by machine and waits for a person (the engine
  // reads the states line: `TaskEntry.sheets`). Each task shows the snapshots of its sheets as text grids and the
  // criteria as checkboxes; a tick is written into the task as the one changed line of its body (`set_body` on the
  // version read, so a change made meanwhile is not written over). When every point is ticked the page offers `done`
  // (the dialog of the finish); nothing is finished by itself. See `lib/abnahme.ts`.
  import type { App } from '../lib/app.svelte';
  import type { TaskDocument } from '../lib/contract';
  import { abnahmeOf, allTicked, parseSheets, progress, rowsOf, tickItem, waiting, type Item } from '../lib/abnahme';
  import { ApiError } from '../lib/api';
  import { translate, type Key } from '../lib/i18n';
  import Info from 'appkit-ui/Info.svelte';
  import { markHidden } from '../lib/text';

  let { app }: { app: App } = $props();
  const t = (key: Key, params: Record<string, string | number> = {}) => translate(app.lang, key, params);

  type Doc = { state: 'loading' } | { state: 'ok'; doc: TaskDocument } | { state: 'failed'; etag?: string };
  type Snap = { state: 'loading' } | { state: 'ok'; rows: string[] } | { state: 'failed'; code: string };

  const tasks = $derived(abnahmeOf(app.tasks));
  let docs = $state.raw<Record<string, Doc>>({});
  let snaps = $state.raw<Record<string, Snap>>({});
  // The id of the task whose body changed under a tick, to say so once.
  let changed = $state<string | null>(null);

  // A task is read when it is new here or its file changed (its etag differs from the one read).
  $effect(() => {
    for (const task of tasks) {
      const have = docs[task.id];
      if (have?.state === 'loading') continue;
      if (have?.state === 'ok' && have.doc.task.etag === task.etag) continue;
      if (have?.state === 'failed' && have.etag === task.etag) continue;
      void read(task.id, task.etag);
    }
  });

  async function read(id: string, etag: string | undefined): Promise<void> {
    docs = { ...docs, [id]: { state: 'loading' } };
    try {
      const doc = await app.readTask(id);
      docs = { ...docs, [id]: { state: 'ok', doc } };
    } catch {
      docs = { ...docs, [id]: { state: 'failed', etag } };
    }
  }

  // The snapshots of the sheets that wait are read once each (their names are in the block; a new run writes the same name).
  $effect(() => {
    for (const task of tasks) {
      const entry = docs[task.id];
      if (entry?.state !== 'ok') continue;
      for (const sheet of waiting(parseSheets(entry.doc.body))) {
        for (const name of sheet.snapshots) {
          if (!snaps[name]) void readSnap(name);
        }
      }
    }
  });

  async function readSnap(name: string): Promise<void> {
    snaps = { ...snaps, [name]: { state: 'loading' } };
    try {
      snaps = { ...snaps, [name]: { state: 'ok', rows: rowsOf(await app.readSheetSnapshot(name)) } };
    } catch (error) {
      snaps = { ...snaps, [name]: { state: 'failed', code: error instanceof ApiError ? error.code : 'offline' } };
    }
  }

  async function tick(id: string, doc: TaskDocument, item: Item, checked: boolean): Promise<void> {
    if (doc.body_truncated) return;
    const body = tickItem(doc.body, item, checked);
    if (body === null) {
      // The text is not what was read: read it again, write nothing.
      changed = id;
      await read(id, doc.task.etag);
      return;
    }
    changed = null;
    await app.setBody(id, body, doc.task.etag);
  }

  const kinds = ['judge', 'manual'] as const;
</script>

<section class="abnahme" aria-label={t('nav.abnahme')}>
  <header class="intro">
    <div class="head">
      <h2>{t('nav.abnahme')}</h2>
      <Info hint={t('hint.abnahme')} label={t('hint.about', { what: t('nav.abnahme') })} />
    </div>
  </header>
  {#each tasks as task (task.id)}
    {@const entry = docs[task.id]}
    <article class="task" data-task={task.id}>
      <header class="thead">
        <h3>{markHidden(task.title)}</h3>
        <span class="id">{task.id}</span>
        <button type="button" class="link" onclick={() => app.reveal(task.id)}>{t('abnahme.open_task')}</button>
      </header>
      {#if !entry || entry.state === 'loading'}
        <p class="note" role="status">{t('abnahme.loading')}</p>
      {:else if entry.state === 'failed'}
        <p class="note" role="alert">{t('abnahme.failed')}</p>
      {:else}
        {@const sheets = parseSheets(entry.doc.body)}
        {@const open = waiting(sheets)}
        {@const done = progress(sheets)}
        <p class="count" role="status">{t('abnahme.progress', { ticked: done.ticked, total: done.total })}</p>
        {#if entry.doc.body_truncated}<p class="note" role="alert">{t('abnahme.truncated')}</p>{/if}
        {#if changed === task.id}<p class="note" role="alert">{t('abnahme.changed')}</p>{/if}
        {#each open as sheet (sheet.id ?? sheet.title)}
          <div class="sheet">
            <h4>{markHidden(sheet.title)}</h4>
            {#if sheet.snapshots.length > 0}
              <div class="snaps" aria-label={t('abnahme.snapshots')}>
                {#each sheet.snapshots as name (name)}
                  {@const snap = snaps[name]}
                  <figure>
                    <figcaption>{name.slice(name.lastIndexOf('/') + 1)}</figcaption>
                    {#if !snap || snap.state === 'loading'}
                      <p class="note">{t('abnahme.loading')}</p>
                    {:else if snap.state === 'failed'}
                      <p class="note" role="alert">{t('abnahme.snap_failed', { code: snap.code })}</p>
                    {:else}
                      <pre class="grid">{snap.rows.join('\n')}</pre>
                    {/if}
                  </figure>
                {/each}
              </div>
            {/if}
            {#each kinds as kind (kind)}
              {@const items = sheet.items.filter((i) => i.kind === kind)}
              {#if items.length > 0}
                <fieldset class="points">
                  <legend>{t(kind === 'judge' ? 'abnahme.judge' : 'abnahme.manual')}</legend>
                  {#each items as item (item.line)}
                    <label>
                      <input
                        type="checkbox"
                        checked={item.checked}
                        disabled={entry.doc.body_truncated || app.saving}
                        onchange={(event) => void tick(task.id, entry.doc, item, event.currentTarget.checked)}
                      />
                      <span>{item.text}</span>
                    </label>
                  {/each}
                </fieldset>
              {/if}
            {/each}
          </div>
        {/each}
        {#if allTicked(sheets)}
          <div class="offer" role="status">
            <span>{t('abnahme.all_ticked')}</span>
            <button type="button" class="primary" onclick={() => void app.startFinish(task.id)}>{t('abnahme.finish')}</button>
          </div>
        {/if}
      {/if}
    </article>
  {:else}
    <p class="empty">{t('abnahme.none')}</p>
  {/each}
</section>

<style>
  .abnahme {
    display: flex;
    flex-direction: column;
    gap: 0.8rem;
    min-height: 0;
  }
  .intro {
    padding: 0.2rem 0.2rem 0;
  }
  .head {
    display: flex;
    align-items: center;
    gap: 0.4rem;
  }
  .head h2 {
    margin: 0;
    font-size: 1.05rem;
  }
  .task {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 0.7rem 0.9rem;
  }
  .thead {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: 0.2rem 0.7rem;
  }
  .thead h3 {
    margin: 0;
    font-size: 1rem;
  }
  .id {
    color: var(--muted);
    font-size: 0.85rem;
  }
  .link {
    margin-left: auto;
    padding: 0;
    background: none;
    border: 0;
    color: var(--accent);
    cursor: pointer;
  }
  .count,
  .note,
  .empty {
    color: var(--muted);
    margin: 0.4rem 0;
  }
  .sheet {
    margin-top: 0.6rem;
    padding-top: 0.5rem;
    border-top: 1px solid var(--border);
  }
  .sheet h4 {
    margin: 0 0 0.4rem;
    font-size: 0.95rem;
  }
  .snaps {
    display: flex;
    flex-wrap: wrap;
    gap: 0.6rem;
    margin-bottom: 0.5rem;
  }
  figure {
    margin: 0;
    max-width: 100%;
  }
  figcaption {
    color: var(--muted);
    font-size: 0.8rem;
  }
  .grid {
    margin: 0.2rem 0 0;
    padding: 0.4rem 0.5rem;
    overflow-x: auto;
    font-family: ui-monospace, SFMono-Regular, Consolas, monospace;
    font-size: 0.8rem;
    line-height: 1.2;
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: var(--radius);
  }
  .points {
    border: 0;
    margin: 0 0 0.4rem;
    padding: 0;
  }
  .points legend {
    color: var(--muted);
    font-size: 0.85rem;
    padding: 0;
  }
  label {
    display: flex;
    align-items: baseline;
    gap: 0.5rem;
    padding: 0.15rem 0;
  }
  .offer {
    display: flex;
    align-items: center;
    gap: 0.8rem;
    margin-top: 0.7rem;
  }
</style>
