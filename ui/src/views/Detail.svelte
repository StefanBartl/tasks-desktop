<script lang="ts">
  import type { App } from '../lib/app.svelte';
  import { formatNumber, labelOf, translate, type Key } from '../lib/i18n';
  import { parseMarkdown } from '../lib/markdown';
  import { hasHidden, markHidden } from '../lib/text';
  import { REMIND_CHOICES } from '../lib/remind';
  import { EFFORT_SIZES, KINDS, VALUES, badTag, parseList, parseTags, tagsChanged, tagsText } from '../lib/fields';
  import Blocks from './Blocks.svelte';

  let { app }: { app: App } = $props();

  const t = (key: Key, params: Record<string, string | number> = {}) =>
    translate(app.lang, key, params);

  const task = $derived(app.selected);
  const detail = $derived(app.detail);
  const body = $derived(detail.state === 'ok' ? detail.doc.body : '');
  let raw = $state(false);
  const blocks = $derived(raw ? [] : parseMarkdown(body));
  const byId = $derived(new Map(app.tasks.map((x) => [x.id, x] as const)));

  const STATUSES = ['doing', 'decision', 'blocked', 'open', 'parked'] as const;
  const ACTORS = ['me', 'cdx', 'pair'] as const;

  const unknown = '?';
  function show(value: string | number | undefined): string {
    return value === undefined ? unknown : String(value);
  }
  function statusOf(id: string): string {
    return labelOf(app.lang, 'status', byId.get(id)?.status);
  }
  /** Write a text field of the task when what was typed differs from what the file has; an empty text takes the key away. */
  function changeText(key: 'summary' | 'plan' | 'phase', current: string | undefined, typed: string): void {
    if (!task) return;
    const next = typed.trim();
    if (next === (current ?? '')) return;
    void app.setField(task.id, key, next === '' ? null : next);
  }
  /** Write a list field (`after`, `refs`) when the typed list differs from the one the file has. */
  function changeList(key: 'after' | 'refs', current: readonly string[], typed: string): void {
    if (!task || !tagsChanged(current, typed)) return;
    const list = parseList(typed);
    void app.setField(task.id, key, list.length === 0 ? null : list);
  }
  const steps = $derived(detail.state === 'ok' ? (detail.doc.steps ?? []) : []);

  // The line for the notes: kept while the task stays selected, emptied only when the engine wrote it.
  let note = $state('');
  $effect(() => {
    void task?.id;
    note = '';
  });
  async function addNote(): Promise<void> {
    if (!task || detail.state !== 'ok' || note.trim() === '') return;
    if (await app.addNote(task.id, note, detail.doc.task.etag)) note = '';
  }
</script>

<aside class="detail" aria-label={t('detail.props')}>
  {#if !task}
    <p class="muted">{t('detail.none')}</p>
  {:else}
    <h2 class="task-title">{markHidden(task.title)}</h2>
    <p class="id"><code>{task.id}</code></p>

    {#if task.problems.length > 0 || !task.valid}
      <div class="problems" role="alert">
        <h3>{t('detail.problems')}</h3>
        <ul>
          {#each task.problems as problem, i (i)}
            <li><code>{problem.code}</code> {markHidden(problem.msg)}</li>
          {/each}
        </ul>
      </div>
    {/if}

    {#if task.summary}<p>{markHidden(task.summary)}</p>{/if}

    {#key `${task.id}:${app.writes}`}
    <div class="edit" role="group" aria-label={t('detail.edit')}>
      <label class="wide">
        <span>{t('field.title')}</span>
        <input
          type="text"
          value={task.title}
          maxlength="300"
          disabled={app.saving}
          onchange={(e) => {
            const next = e.currentTarget.value.trim();
            if (next === task.title) return;
            if (next === '') {
              app.tell('error', 'field.title_empty');
              e.currentTarget.value = task.title;
              return;
            }
            void app.setField(task.id, 'title', next);
          }}
        />
      </label>
      <label class="wide">
        <span>{t('field.summary')}</span>
        <input
          type="text"
          value={task.summary}
          maxlength="1000"
          disabled={app.saving}
          onchange={(e) => changeText('summary', task.summary, e.currentTarget.value)}
        />
      </label>
      <label>
        <span>{t('field.status')}</span>
        <select
          value={task.status ?? ''}
          disabled={app.saving}
          onchange={(e) => void app.setField(task.id, 'status', e.currentTarget.value)}
        >
          {#each STATUSES as s (s)}
            <option value={s}>{labelOf(app.lang, 'status', s)}</option>
          {/each}
        </select>
      </label>
      <label>
        <span>{t('field.prio')}</span>
        <select
          value={task.prio === undefined ? '' : String(task.prio)}
          disabled={app.saving}
          onchange={(e) =>
            void app.setField(
              task.id,
              'prio',
              e.currentTarget.value === '' ? null : Number(e.currentTarget.value),
            )}
        >
          <option value="">–</option>
          <option value="1">1</option>
          <option value="2">2</option>
          <option value="3">3</option>
        </select>
      </label>
      <label>
        <span>{t('field.actor')}</span>
        <select
          value={task.actor ?? ''}
          disabled={app.saving}
          onchange={(e) =>
            void app.setField(task.id, 'actor', e.currentTarget.value === '' ? null : e.currentTarget.value)}
        >
          <option value="">–</option>
          {#each ACTORS as a (a)}
            <option value={a}>{labelOf(app.lang, 'actor', a)}</option>
          {/each}
        </select>
      </label>
      <label>
        <span>{t('field.kind')}</span>
        <select
          value={task.kind ?? ''}
          disabled={app.saving}
          onchange={(e) =>
            void app.setField(task.id, 'kind', e.currentTarget.value === '' ? null : e.currentTarget.value)}
        >
          <option value="">–</option>
          {#each KINDS as k (k)}
            <option value={k}>{k}</option>
          {/each}
        </select>
      </label>
      <label>
        <span>{t('field.effort')}</span>
        <select
          value={task.effort ?? ''}
          disabled={app.saving}
          onchange={(e) =>
            void app.setField(task.id, 'effort', e.currentTarget.value === '' ? null : e.currentTarget.value)}
        >
          <option value="">–</option>
          {#if task.effort && !(EFFORT_SIZES as readonly string[]).includes(task.effort)}
            <option value={task.effort}>{task.effort}</option>
          {/if}
          {#each EFFORT_SIZES as size (size)}
            <option value={size}>{size}</option>
          {/each}
        </select>
      </label>
      <label>
        <span>{t('field.value')}</span>
        <select
          value={task.value === undefined ? '' : String(task.value)}
          disabled={app.saving}
          onchange={(e) =>
            void app.setField(
              task.id,
              'value',
              e.currentTarget.value === '' ? null : Number(e.currentTarget.value),
            )}
        >
          <option value="">–</option>
          {#each VALUES as v (v)}
            <option value={String(v)}>{v}</option>
          {/each}
        </select>
      </label>
      <label class="wide">
        <span>{t('field.tags')} <small>({t('field.tags_hint')})</small></span>
        <input
          type="text"
          value={tagsText(task.tags)}
          disabled={app.saving}
          onchange={(e) => {
            const text = e.currentTarget.value;
            if (tagsChanged(task.tags, text)) {
              const tags = parseTags(text);
              const bad = badTag(tags);
              if (bad !== null) {
                // The engine would refuse it: say so and keep what was typed.
                app.tell('error', 'field.tags_invalid', { tag: bad });
                return;
              }
              void app.setField(task.id, 'tags', tags.length === 0 ? null : tags);
            }
          }}
        />
      </label>
      <label>
        <span>{t('field.plan')}</span>
        <input
          type="text"
          value={task.plan ?? ''}
          disabled={app.saving}
          onchange={(e) => changeText('plan', task.plan, e.currentTarget.value)}
        />
      </label>
      <label>
        <span>{t('field.phase')}</span>
        <input
          type="text"
          value={task.phase ?? ''}
          disabled={app.saving}
          onchange={(e) => changeText('phase', task.phase, e.currentTarget.value)}
        />
      </label>
      <label class="wide">
        <span>{t('field.after')} <small>({t('field.tags_hint')})</small></span>
        <input
          type="text"
          value={tagsText(task.after)}
          disabled={app.saving}
          onchange={(e) => changeList('after', task.after, e.currentTarget.value)}
        />
      </label>
      <label class="wide">
        <span>{t('field.refs')} <small>({t('field.tags_hint')})</small></span>
        <input
          type="text"
          value={tagsText(task.refs)}
          disabled={app.saving}
          onchange={(e) => changeList('refs', task.refs, e.currentTarget.value)}
        />
      </label>
      <label>
        <span>{t('remind.field')}</span>
        <select
          value={task.remind ?? ''}
          disabled={app.saving}
          onchange={(e) => {
            const value = e.currentTarget.value;
            if (value !== (task.remind ?? '')) void app.setField(task.id, 'remind', value === '' ? null : value);
          }}
        >
          <option value="">{t('remind.none')}</option>
          {#if task.remind}<option value={task.remind}>{task.remind}</option>{/if}
          {#each REMIND_CHOICES as choice (choice)}
            <option value={choice}
              >{choice === '+0d' ? t('remind.today') : t('remind.in', { n: choice.slice(1, -1) })}</option
            >
          {/each}
        </select>
      </label>
      <button type="button" class="finish" disabled={app.saving} onclick={() => void app.startFinish(task.id)}
        >{t('done.button')}</button
      >
    </div>
    {/key}

    <h3>{t('detail.props')}</h3>
    <dl>
      <dt>{t('prop.status')}</dt>
      <dd>{labelOf(app.lang, 'status', task.status)}</dd>
      <dt>{t('prop.state')}</dt>
      <dd>{task.readiness ? labelOf(app.lang, 'state', task.readiness.state) : unknown}</dd>
      <dt>{t('prop.area')}</dt>
      <dd>{task.area}</dd>
      <dt>{t('prop.prio')}</dt>
      <dd>{task.prio === undefined ? unknown : `P${task.prio}`}</dd>
      <dt>{t('prop.effort')}</dt>
      <dd>{show(task.effort)}</dd>
      <dt>{t('prop.value')}</dt>
      <dd>{show(task.value)}</dd>
      <dt>{t('prop.roi')}</dt>
      <dd>{task.roi === undefined ? unknown : formatNumber(app.lang, task.roi)}</dd>
      <dt>{t('prop.actor')}</dt>
      <dd>{labelOf(app.lang, 'actor', task.actor)}</dd>
      {#if task.plan}
        <dt>{t('prop.plan')}</dt>
        <dd>{task.plan}{task.phase ? ` · ${task.phase}` : ''}</dd>
      {/if}
      <dt>{t('prop.updated')}</dt>
      <dd>{show(task.updated)}</dd>
    </dl>

    {#if task.blocked_by.length > 0}
      <h3>{t('detail.waits_on')}</h3>
      <ul class="plain">
        {#each task.blocked_by as id, i (`${id}:${i}`)}
          <li>
            <button type="button" class="link" onclick={() => byId.has(id) && app.reveal(id)}
              ><code>{id}</code></button
            >
            <span class="muted">{statusOf(id)}</span>
          </li>
        {/each}
      </ul>
    {/if}
    {#if task.after.length > 0}
      <h3>{t('detail.after')}</h3>
      <ul class="plain">
        {#each task.after as id, i (`${id}:${i}`)}
          <li><code>{id}</code> <span class="muted">{statusOf(id)}</span></li>
        {/each}
      </ul>
    {/if}

    {#if detail.state === 'loading'}
      <p class="muted">{t('detail.loading')}</p>
    {:else if detail.state === 'failed'}
      <p class="bad" role="alert">{t('detail.failed')}</p>
    {:else if detail.state === 'ok'}
      {#if steps.length > 0}
        <h3>{t('detail.steps')}</h3>
        <ul class="plain">
          {#each steps as step, i (i)}
            <li class:dropped={step.dropped}>
              {#if step.dropped || !app.can('tick_step')}
                <span aria-hidden="true">{step.ticked ? '☑' : step.dropped ? '⊘' : '☐'}</span>
                <span class="sr-only"
                  >{t(step.ticked ? 'step.done' : step.dropped ? 'step.dropped' : 'step.open')}</span
                >
                {markHidden(step.text)}
              {:else}
                <!-- The box shows what the file says: a click asks the engine and the list is read again
                     (no optimistic display), so the click itself changes nothing on the page. -->
                <label class="step">
                  <input
                    type="checkbox"
                    checked={step.ticked}
                    disabled={app.saving}
                    onclick={(e) => {
                      e.preventDefault();
                      void app.tickStep(task.id, step.n, !step.ticked, detail.doc.task.etag);
                    }}
                  />
                  {markHidden(step.text)}
                </label>
              {/if}
            </li>
          {/each}
        </ul>
      {/if}
      <h3>
        {t('detail.body')}
        <button type="button" class="switch" aria-pressed={raw} onclick={() => (raw = !raw)}
          >{raw ? t('detail.view_rendered') : t('detail.view_raw')}</button
        >
      </h3>
      {#if hasHidden(body)}<p class="warn">{t('detail.invisible')}</p>{/if}
      <!-- The body is untrusted: it is read into a tree and drawn as
           elements; it never becomes an HTML string. -->
      {#if raw}
        <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
        <pre class="body" tabindex="0">{markHidden(body)}</pre>
      {:else}
        <div class="body prose"><Blocks {blocks} /></div>
      {/if}
      {#if detail.doc.body_truncated}<p class="muted">{t('detail.body_truncated')}</p>{/if}
      {#if app.can('append_note')}
        <!-- No <form> element: the page's own tests take a form in the text of a task for injected markup. -->
        <div class="note" role="group" aria-label={t('detail.note_label')}>
          <label>
            <span>{t('detail.note_label')} <small>({t('detail.note_hint')})</small></span>
            <input
              type="text"
              bind:value={note}
              maxlength="1000"
              disabled={app.saving}
              onkeydown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  void addNote();
                }
              }}
            />
          </label>
          <button type="button" disabled={app.saving || note.trim() === ''} onclick={() => void addNote()}
            >{t('detail.note_button')}</button
          >
        </div>
      {/if}
    {/if}

    <h3>{t('detail.file')}</h3>
    <p><code class="file">{task.file}</code></p>
  {/if}
</aside>

<style>
  .edit {
    display: flex;
    flex-wrap: wrap;
    gap: 0.6rem;
    align-items: end;
    margin: 0.5rem 0 0.75rem;
  }
  .edit label {
    display: grid;
    gap: 0.15rem;
    font-size: 0.8rem;
    color: var(--muted);
  }
  .edit select,
  .edit input,
  .edit .finish {
    background: var(--surface-2);
    color: var(--text);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 0.25rem 0.5rem;
    font-size: 0.9rem;
  }
  .edit .wide {
    flex: 1 1 14rem;
  }
  .edit .finish {
    cursor: pointer;
  }
  .edit :disabled {
    opacity: 0.6;
    cursor: default;
  }
  .detail {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 1rem;
    overflow: auto;
    min-height: 0;
  }
  .task-title {
    font-size: 1.25rem;
  }
  .id {
    margin: -0.25rem 0 0.75rem;
    color: var(--muted);
  }
  dl {
    display: grid;
    grid-template-columns: max-content 1fr;
    gap: 0.2rem 1rem;
    margin: 0 0 1rem;
  }
  dt {
    color: var(--muted);
  }
  dd {
    margin: 0;
  }
  .plain {
    list-style: none;
    padding: 0;
    margin: 0 0 1rem;
  }
  .plain li {
    padding: 0.1rem 0;
  }
  .step {
    display: flex;
    gap: 0.4rem;
    align-items: baseline;
    cursor: pointer;
  }
  .note {
    display: flex;
    gap: 0.6rem;
    align-items: end;
    flex-wrap: wrap;
    margin: 0.75rem 0 1rem;
  }
  .note label {
    flex: 1 1 14rem;
    display: grid;
    gap: 0.15rem;
    font-size: 0.8rem;
    color: var(--muted);
  }
  .note input,
  .note button {
    background: var(--surface-2);
    color: var(--text);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 0.25rem 0.5rem;
    font-size: 0.9rem;
  }
  .note button {
    cursor: pointer;
  }
  .note :disabled {
    opacity: 0.6;
    cursor: default;
  }
  .dropped {
    text-decoration: line-through;
    color: var(--muted);
  }
  .muted {
    color: var(--muted);
  }
  .bad {
    color: var(--bad);
  }
  .warn {
    color: var(--warn);
  }
  .problems {
    border: 1px solid var(--bad);
    border-radius: var(--radius);
    padding: 0.5rem 0.75rem;
    margin-bottom: 1rem;
  }
  .link {
    background: none;
    border: 0;
    padding: 0;
    color: var(--accent);
    cursor: pointer;
  }
  .body {
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    background: var(--surface-2);
    border-radius: var(--radius);
    padding: 0.75rem;
    max-height: 24rem;
    overflow: auto;
  }
  .switch {
    margin-left: 0.5rem;
    background: none;
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 0 0.4rem;
    cursor: pointer;
    font-size: 0.75rem;
    text-transform: none;
    letter-spacing: 0;
    color: var(--muted);
  }
  .prose {
    white-space: normal;
  }
  .file {
    overflow-wrap: anywhere;
  }
</style>
