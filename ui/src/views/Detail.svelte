<script lang="ts">
  import { tick } from 'svelte';
  import type { App } from '../lib/app.svelte';
  import { formatNumber, hintOf, labelOf, translate, type Key } from '../lib/i18n';
  import { areaLabel } from '../lib/filter';
  import { parseMarkdown } from 'appkit-ui/markdown';
  import { editableBody, hasHidden, markHidden, MAX_BODY_EDIT } from '../lib/text';
  import { REMIND_CHOICES } from '../lib/remind';
  import { shownTask } from '../lib/drafts';
  import { classChange as classChangeOf } from '../lib/bulk';
  import { copyText } from '../lib/exportDom';
  import {
    badLink,
    badTag,
    isWebLink,
    listEditable,
    oneLine,
    parseList,
    parseTags,
    tagsChanged,
    tagsText,
  } from '../lib/fields';
  import Blocks from 'appkit-ui/Blocks.svelte';

  let { app }: { app: App } = $props();

  const t = (key: Key, params: Record<string, string | number> = {}) =>
    translate(app.lang, key, params);

  const task = $derived(app.selected);
  const detail = $derived(app.detail);
  const body = $derived(detail.state === 'ok' ? detail.doc.body : '');
  let raw = $state(false);
  const blocks = $derived(raw ? [] : parseMarkdown(body));
  const byId = $derived(new Map(app.tasks.map((x) => [x.id, x] as const)));


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
    void app.editField(task.id, key, next === '' ? null : next);
  }
  /** Write a list field (`after`, `refs`) when the typed list differs from the one the file has. */
  function changeList(key: 'after' | 'refs' | 'links', current: readonly string[], typed: string): void {
    if (!task || !tagsChanged(current, typed)) return;
    const list = parseList(typed);
    if (key === 'links') {
      const notLink = badLink(list);
      if (notLink !== null) {
        app.tell('error', 'field.links_invalid', { link: notLink });
        return;
      }
    }
    void app.editField(task.id, key, list.length === 0 ? null : list);
  }
  /** The links the page may draw: http(s) only, whatever the file holds. */
  const webLinks = $derived((task?.links ?? []).filter(isWebLink));
  const steps = $derived(detail.state === 'ok' ? (detail.doc.steps ?? []) : []);
  const questions = $derived(detail.state === 'ok' ? (detail.doc.questions ?? []) : []);

  // The line for the notes: kept while the task stays selected, emptied only when the engine wrote it.
  let note = $state('');
  // The reason for dropping the task: kept like the note, emptied only when the engine wrote it.
  let reason = $state('');

  /** The link of the attached screenshot on the clipboard (the page may write it, never read it). */
  async function copyLink(link: string): Promise<void> {
    const ok = await copyText(navigator.clipboard, link);
    app.tell(ok ? 'ok' : 'error', ok ? 'attach.copied' : 'attach.copy_failed');
  }
  // The area the task is to move to and what the engine said a move there would do (a dry run, nothing written).
  let moveTo = $state('');
  let movePreview = $state<Awaited<ReturnType<App['previewMove']>> | null>(null);
  // The id as a value of its own: a refresh gives `task` a new object with the same id, and the draft must stay.
  const taskId = $derived(task?.id);
  // The text of the task being edited: a draft that stays until it is written or given up, and goes with the task.
  let editing = $state(false);
  let draft = $state('');
  // The version of the file the draft was started from: a change in between is a conflict, not overwritten.
  let draftEtag = $state<string | undefined>(undefined);
  // The text the draft started from: Escape gives up a draft that is as it was, never one that holds typing.
  let draftStart = '';
  $effect(() => {
    void taskId;
    note = '';
    reason = '';
    moveTo = '';
    movePreview = null;
    editing = false;
    draft = '';
  });
  function editBody(): void {
    if (detail.state !== 'ok') return;
    draft = detail.doc.body.trim();
    draftStart = draft;
    draftEtag = detail.doc.task.etag;
    editing = true;
  }
  async function saveBody(): Promise<void> {
    if (!task || detail.state !== 'ok') return;
    if (await app.setBody(task.id, draft, draftEtag)) editing = false;
  }
  // The data class of an area is what decides where its tasks may be kept: a move across classes is told.
  const classChange = $derived.by(() => {
    if (!task || moveTo === '') return null;
    const of = (name: string) => app.hubAreas.find((a) => a.name === name)?.data_class;
    return classChangeOf(of(task.area), of(moveTo));
  });
  async function checkMove(): Promise<void> {
    if (!task || moveTo === '') return;
    const id = task.id;
    const target = moveTo;
    const answer = await app.previewMove(id, target);
    // The person may have chosen another task or area meanwhile: a late answer is not shown for it.
    if (task?.id === id && moveTo === target) movePreview = answer;
  }
  async function doMove(): Promise<void> {
    if (!task || detail.state !== 'ok' || moveTo === '') return;
    if (await app.moveArea(task.id, moveTo, detail.doc.task.etag)) {
      moveTo = '';
      movePreview = null;
    }
  }
  async function discard(): Promise<void> {
    if (!task || detail.state !== 'ok' || reason.trim() === '') return;
    if (await app.discard(task.id, reason, detail.doc.task.etag)) reason = '';
  }
  async function addNote(): Promise<void> {
    if (!task || detail.state !== 'ok' || note.trim() === '') return;
    if (await app.addNote(task.id, note, detail.doc.task.etag)) note = '';
  }

  // A write makes the text fields read-only and disables the choices while it is under way, and draws the fields anew
  // when it has ended (the {#key} below): the field that had the focus loses it to the page, whose single keys (those
  // of the inbox, j and k under the float, c) would then act on what is typed next. The field the person is in is
  // followed as the focus moves (`data-field`), not taken when the write starts: one clicked or tabbed into meanwhile
  // is the one that gets the focus back. A field left for another control or for the page is not followed any more.
  let root = $state<HTMLElement | undefined>();
  let followed: string | null = null;
  const fieldOf = (target: EventTarget | null): string | null =>
    target instanceof HTMLElement ? (target.dataset['field'] ?? null) : null;
  function focusIn(e: FocusEvent): void {
    followed = fieldOf(e.target);
  }
  function focusOut(e: FocusEvent): void {
    const left = e.target;
    const field = fieldOf(left);
    if (!(left instanceof HTMLElement) || field === null) return;
    const to = e.relatedTarget;
    if (to !== null) {
      // To another control: one outside the detail ends it. A field of the detail is followed at once: Tab writes the
      // field it leaves (change), and the write disables the choice it goes to before the focus lands there, so that
      // field never sees a focusin. Its focusin says the rest (a control that is no field: nothing is followed).
      if (!(to instanceof Node) || !root?.contains(to)) followed = null;
      else followed = fieldOf(to) ?? followed;
      return;
    }
    // To nowhere: a click on the page, or the field was taken away (drawn anew, disabled). Only the first is the
    // person's; the window losing the focus leaves the field the active element and is neither.
    queueMicrotask(() => {
      const gone = !left.isConnected || (left as HTMLInputElement).disabled;
      if (!gone && document.activeElement !== left && followed === field) followed = null;
    });
  }
  $effect(() => {
    // After a write has ended, and after the text of the task was read again (the lines below the fields).
    void app.writes;
    void detail.state;
    if (app.saving || !root || followed === null) return;
    const active = document.activeElement;
    if (active !== null && active !== document.body) return;
    const field = root.querySelector<HTMLElement>(`[data-field="${followed}"]`);
    if (field && !(field as HTMLInputElement).disabled) field.focus();
  });
  /**
   * Ctrl+S (Cmd+S) saves the draft of the task. The field being typed in is left first: its `change` puts what was
   * typed into the draft before the draft is written.
   */
  function saveKey(e: KeyboardEvent): void {
    if (!task || app.saveMode !== 'manual' || e.key.toLowerCase() !== 's' || !(e.ctrlKey || e.metaKey) || e.altKey) return;
    e.preventDefault();
    // Only a field of the draft is left (so that what was typed is in it); the text, a note or a reason being typed
    // keeps the focus, and is not saved by this key.
    const active = document.activeElement;
    const field = active instanceof HTMLElement && root?.contains(active) ? active.dataset['field'] : undefined;
    if (field) (active as HTMLElement).blur();
    if (app.saving) return;
    const id = task.id;
    void app.saveDraft(id).then(async () => {
      // Back into the field the key was pressed in (the fields were drawn anew): typing goes on there, not into the
      // single keys of the page.
      await tick();
      if (field && app.selectedId === id) root?.querySelector<HTMLElement>(`[data-field="${field}"]`)?.focus();
    });
  }
  // On the detail itself, not the page: a Ctrl+S elsewhere is the browser's (or nothing).
  $effect(() => {
    const at = root;
    if (!at) return;
    at.addEventListener('keydown', saveKey);
    return () => at.removeEventListener('keydown', saveKey);
  });
</script>

<aside
  class="detail"
  aria-label={t('detail.label')}
  bind:this={root}
  onfocusin={focusIn}
  onfocusout={focusOut}
>
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

    {@const shown = shownTask(task, app.draftOf(task.id))}
    {@const pending = Object.keys(app.draftOf(task.id)).length}
    {#if app.saveMode === 'manual'}
      <!-- The fields are held until saved: what is held, and the two ways out of it. -->
      <div class="draft" role="group" aria-label={t('draft.label')}>
        <span class="muted" role="status">{pending > 0 ? t('draft.pending', { n: pending }) : t('draft.none')}</span>
        <button
          type="button"
          class="primary"
          data-hint={t('hint.ui.draft.save')}
          disabled={pending === 0 || app.locked}
          onclick={() => void app.saveDraft(task.id)}>{t('draft.save')}</button
        >
        <button
          type="button"
          class="quiet"
          data-hint={t('hint.ui.draft.discard')}
          disabled={pending === 0 || app.locked}
          onclick={() => app.discardDraft(task.id)}
          >{t('draft.discard')}</button
        >
      </div>
    {/if}
    {#key `${task.id}:${app.writes}`}
    <!-- The fields with a text of their own each take a whole line (a title, a summary is seldom short); the choices
         from a few values share the lines between them, each at a width its values fit in. -->
    <div class="edit" role="group" aria-label={t('detail.edit')}>
      <label class="line">
        <span>{t('field.title')}</span>
        <input
          type="text"
          value={shown.title}
          data-field="title"
          maxlength="300"
          readonly={app.locked}
          onchange={(e) => {
            const next = e.currentTarget.value.trim();
            if (next === shown.title) return;
            if (next === '') {
              app.tell('error', 'field.title_empty');
              e.currentTarget.value = shown.title;
              return;
            }
            void app.editField(shown.id, 'title', next);
          }}
        />
      </label>
      <label class="line">
        <span>{t('field.summary')}</span>
        <!-- Several lines to read and write in; the engine keeps the summary as one line, so Enter writes it (as in a
             field of one line, the focus stays in it) and a line break that was pasted becomes a space. -->
        <textarea
          class="summary"
          rows="3"
          value={shown.summary ?? ''}
          data-field="summary"
          maxlength="1000"
          readonly={app.locked}
          onkeydown={(e) => {
            if (e.key === 'Enter' && !e.isComposing) {
              e.preventDefault();
              if (!app.saving) changeText('summary', shown.summary, oneLine(e.currentTarget.value));
            }
          }}
          onchange={(e) => changeText('summary', shown.summary, oneLine(e.currentTarget.value))}
        ></textarea>
      </label>
      <div class="picks">
        <label>
          <span data-hint={hintOf(app.lang, 'hint.field', 'status')}>{t('field.status')}</span>
          <select
            value={shown.status ?? ''}
            data-field="status"
            disabled={app.locked}
            onchange={(e) => void app.editField(shown.id, 'status', e.currentTarget.value)}
          >
            <!-- A status the file has and the engine does not name (an older engine) is shown as it is. -->
            {#if shown.status && !app.ranges.statuses.includes(shown.status)}
              <option value={shown.status}>{labelOf(app.lang, 'status', shown.status)}</option>
            {/if}
            {#each app.ranges.statuses as s (s)}
              <option value={s}>{labelOf(app.lang, 'status', s)}</option>
            {/each}
          </select>
        </label>
        <label>
          <span data-hint={hintOf(app.lang, 'hint.field', 'prio')}>{t('field.prio')}</span>
          <select
            value={shown.prio === undefined ? '' : String(shown.prio)}
            data-field="prio"
            disabled={app.locked}
            onchange={(e) =>
              void app.editField(
                shown.id,
                'prio',
                e.currentTarget.value === '' ? null : Number(e.currentTarget.value),
              )}
          >
            <option value="">{t('field.none')}</option>
            {#if shown.prio !== undefined && !app.ranges.prios.includes(shown.prio)}
              <option value={String(shown.prio)}>{shown.prio}</option>
            {/if}
            {#each app.ranges.prios as p (p)}
              <option value={String(p)}>{p}</option>
            {/each}
          </select>
        </label>
        <label>
          <span data-hint={hintOf(app.lang, 'hint.field', 'actor')}>{t('field.actor')}</span>
          <select
            value={shown.actor ?? ''}
            data-field="actor"
            disabled={app.locked}
            onchange={(e) =>
              void app.editField(shown.id, 'actor', e.currentTarget.value === '' ? null : e.currentTarget.value)}
          >
            <option value="">{t('field.none')}</option>
            {#if shown.actor && !app.ranges.actors.includes(shown.actor)}
              <option value={shown.actor}>{labelOf(app.lang, 'actor', shown.actor)}</option>
            {/if}
            {#each app.ranges.actors as a (a)}
              <option value={a}>{labelOf(app.lang, 'actor', a)}</option>
            {/each}
          </select>
        </label>
        <label>
          <span data-hint={hintOf(app.lang, 'hint.field', 'kind')}>{t('field.kind')}</span>
          <select
            value={shown.kind ?? ''}
            data-field="kind"
            disabled={app.locked}
            onchange={(e) =>
              void app.editField(shown.id, 'kind', e.currentTarget.value === '' ? null : e.currentTarget.value)}
          >
            <option value="">{t('field.none')}</option>
            {#each app.ranges.kinds as k (k)}
              <option value={k}>{k}</option>
            {/each}
          </select>
        </label>
        <label>
          <span data-hint={hintOf(app.lang, 'hint.field', 'effort')}>{t('field.effort')}</span>
          <select
            value={shown.effort ?? ''}
            data-field="effort"
            disabled={app.locked}
            onchange={(e) =>
              void app.editField(shown.id, 'effort', e.currentTarget.value === '' ? null : e.currentTarget.value)}
          >
            <option value="">{t('field.none')}</option>
            {#if shown.effort && !app.ranges.efforts.includes(shown.effort)}
              <option value={shown.effort}>{shown.effort}</option>
            {/if}
            {#each app.ranges.efforts as size (size)}
              <option value={size}>{size}</option>
            {/each}
          </select>
        </label>
        <label>
          <span data-hint={hintOf(app.lang, 'hint.field', 'value')}>{t('field.value')}</span>
          <select
            value={shown.value === undefined ? '' : String(shown.value)}
            data-field="value"
            disabled={app.locked}
            onchange={(e) =>
              void app.editField(
                shown.id,
                'value',
                e.currentTarget.value === '' ? null : Number(e.currentTarget.value),
              )}
          >
            <option value="">{t('field.none')}</option>
            {#each app.ranges.values as v (v)}
              <option value={String(v)}>{v}</option>
            {/each}
          </select>
        </label>
        <label>
          <span>{t('remind.field')}</span>
          <select
            value={shown.remind ?? ''}
            data-field="remind"
            disabled={app.locked}
            onchange={(e) => {
              const value = e.currentTarget.value;
              if (value !== (shown.remind ?? '')) void app.editField(shown.id, 'remind', value === '' ? null : value);
            }}
          >
            <option value="">{t('remind.none')}</option>
            {#if shown.remind && !(REMIND_CHOICES as readonly string[]).includes(shown.remind)}
              <option value={shown.remind}>{shown.remind}</option>
            {/if}
            {#each REMIND_CHOICES as choice (choice)}
              <option value={choice}
                >{choice === '+0d' ? t('remind.today') : t('remind.in', { n: choice.slice(1, -1) })}</option
              >
            {/each}
          </select>
        </label>
      </div>
      <!-- The plan and the phase are free text, often a long name: a line each, as the title. -->
      <label class="line">
        <span data-hint={hintOf(app.lang, 'hint.field', 'plan')}>{t('field.plan')}</span>
        <input
          type="text"
          value={shown.plan ?? ''}
          data-field="plan"
          readonly={app.locked}
          onchange={(e) => changeText('plan', shown.plan, e.currentTarget.value)}
        />
      </label>
      <label class="line">
        <span data-hint={hintOf(app.lang, 'hint.field', 'phase')}>{t('field.phase')}</span>
        <input
          type="text"
          value={shown.phase ?? ''}
          data-field="phase"
          readonly={app.locked}
          onchange={(e) => changeText('phase', shown.phase, e.currentTarget.value)}
        />
      </label>
      <label class="line">
        <span data-hint={hintOf(app.lang, 'hint.field', 'tags')}>{t('field.tags')} <small>({t('field.tags_hint')})</small></span>
        <input
          type="text"
          value={tagsText(shown.tags)}
          data-field="tags"
          readonly={app.locked}
          disabled={!listEditable(shown.tags)}
          title={listEditable(shown.tags) ? undefined : t('field.list_plain')}
          onchange={(e) => {
            const text = e.currentTarget.value;
            if (tagsChanged(shown.tags, text)) {
              const tags = parseTags(text);
              const bad = badTag(tags);
              if (bad !== null) {
                // The engine would refuse it: say so and keep what was typed.
                app.tell('error', 'field.tags_invalid', { tag: bad });
                return;
              }
              void app.editField(shown.id, 'tags', tags.length === 0 ? null : tags);
            }
          }}
        />
      </label>
      <label class="line">
        <span data-hint={hintOf(app.lang, 'hint.field', 'after')}>{t('field.after')} <small>({t('field.tags_hint')})</small></span>
        <input
          type="text"
          value={tagsText(shown.after)}
          data-field="after"
          readonly={app.locked}
          disabled={!listEditable(shown.after)}
          title={listEditable(shown.after) ? undefined : t('field.list_plain')}
          onchange={(e) => changeList('after', shown.after, e.currentTarget.value)}
        />
      </label>
      <label class="line">
        <span data-hint={hintOf(app.lang, 'hint.field', 'refs')}>{t('field.refs')} <small>({t('field.tags_hint')})</small></span>
        <input
          type="text"
          value={tagsText(shown.refs)}
          data-field="refs"
          readonly={app.locked}
          disabled={!listEditable(shown.refs)}
          title={listEditable(shown.refs) ? undefined : t('field.list_plain')}
          onchange={(e) => changeList('refs', shown.refs, e.currentTarget.value)}
        />
      </label>
      <label class="line">
        <span data-hint={hintOf(app.lang, 'hint.field', 'links')}>{t('field.links')} <small>({t('field.tags_hint')})</small></span>
        <input
          type="text"
          value={tagsText(shown.links)}
          data-field="links"
          readonly={app.locked}
          disabled={!listEditable(shown.links)}
          title={listEditable(shown.links) ? undefined : t('field.list_plain')}
          placeholder="https://"
          onchange={(e) => changeList('links', shown.links ?? [], e.currentTarget.value)}
        />
      </label>
      <!-- outside the label: a link inside it would become part of the accessible name of the field -->
      {#if webLinks.length > 0}
        <div class="weblinks">
          {#each webLinks as link (link)}
            <a href={link} target="_blank" rel="noopener noreferrer">{link}</a>
          {/each}
        </div>
      {/if}
    </div>
    {/key}

    <h3>{t('detail.props')}</h3>
    <dl>
      <dt>{t('prop.status')}</dt>
      <dd>{labelOf(app.lang, 'status', task.status)}</dd>
      <dt data-hint={hintOf(app.lang, 'hint.field', 'state')}>{t('prop.state')}</dt>
      <dd>{task.readiness ? labelOf(app.lang, 'state', task.readiness.state) : unknown}</dd>
      <dt>{t('prop.area')}</dt>
      <dd>{app.shortAreas ? areaLabel(task.area, app.allAreaNames) : task.area}</dd>
      <dt data-hint={hintOf(app.lang, 'hint.field', 'prio')}>{t('prop.prio')}</dt>
      <dd>{task.prio === undefined ? unknown : `P${task.prio}`}</dd>
      <dt data-hint={hintOf(app.lang, 'hint.field', 'effort')}>{t('prop.effort')}</dt>
      <dd>{show(task.effort)}</dd>
      <dt data-hint={hintOf(app.lang, 'hint.field', 'value')}>{t('prop.value')}</dt>
      <dd>{show(task.value)}</dd>
      <dt data-hint={hintOf(app.lang, 'hint.field', 'roi')}>{t('prop.roi')}</dt>
      <dd>{task.roi === undefined ? unknown : formatNumber(app.lang, task.roi)}</dd>
      <dt data-hint={hintOf(app.lang, 'hint.field', 'actor')}>{t('prop.actor')}</dt>
      <dd>{labelOf(app.lang, 'actor', task.actor)}</dd>
      {#if task.plan}
        <dt data-hint={hintOf(app.lang, 'hint.field', 'plan')}>{t('prop.plan')}</dt>
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
            {#if byId.has(id)}
              <button type="button" class="link" onclick={() => app.reveal(id)}><code>{id}</code></button>
            {:else}
              <!-- Not in the list (finished, or a task the page may not show): nothing to reveal, so no button. -->
              <code>{id}</code>
            {/if}
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
                    disabled={app.locked}
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
      {#if questions.length > 0}
        <h3>{t('detail.questions')}</h3>
        <div class="questions">
          {#each questions as q (q.n)}
            <section class="question" class:answered={q.answered} aria-label={q.title}>
              <h4>{markHidden(q.title)}</h4>
              {#if q.text}<p class="muted">{markHidden(q.text)}</p>{/if}
              <ul class="plain options">
                {#each q.options as option (option.n)}
                  <li>
                    {#if app.can('answer')}
                      <!-- The button shows what the file says: a click asks the engine and the task is read again. -->
                      <button
                        type="button"
                        class="option"
                        class:chosen={option.chosen}
                        class:recommended={option.recommended}
                        aria-pressed={option.chosen}
                        disabled={app.locked}
                        onclick={() => void app.answerQuestion(task.id, q.key ?? `#${q.n}`, option.chosen ? null : option.n, detail.doc.task.etag)}
                      >
                        <span aria-hidden="true">{option.chosen ? '◉' : '○'}</span>
                        {markHidden(option.text)}
                        {#if option.recommended}<span class="badge">{t('question.recommended')}</span>{/if}
                      </button>
                    {:else}
                      <span class="option" class:chosen={option.chosen}>
                        <span aria-hidden="true">{option.chosen ? '◉' : '○'}</span>
                        {markHidden(option.text)}
                        {#if option.recommended}<span class="badge">{t('question.recommended')}</span>{/if}
                      </span>
                    {/if}
                  </li>
                {/each}
              </ul>
            </section>
          {/each}
        </div>
      {/if}
      <h3>
        {t('detail.body')}
        <!-- The label names what the button will do, so it is a plain button, not a pressed one (both at once contradict). -->
        <button type="button" class="switch" data-hint={t('hint.ui.detail.view_raw')} onclick={() => (raw = !raw)}
          >{raw ? t('detail.view_rendered') : t('detail.view_raw')}</button
        >
        {#if app.can('set_body') && editableBody(detail.doc.body, detail.doc.body_truncated) && !editing}
          <button type="button" class="switch" data-hint={t('hint.ui.detail.edit_body')} disabled={app.locked} onclick={editBody}>{t('detail.edit_body')}</button>
        {/if}
      </h3>
      {#if hasHidden(body)}<p class="warn">{t('detail.invisible')}</p>{/if}
      <!-- The body is untrusted: it is read into a tree and drawn as
           elements; it never becomes an HTML string. -->
      {#if editing}
        <label class="body-edit">
          <span class="muted">{t('detail.body_label')} <small>({t('detail.body_hint')})</small></span>
          <textarea
            bind:value={draft}
            rows="14"
            maxlength={MAX_BODY_EDIT}
            disabled={app.locked}
            onkeydown={(e) => {
              if (e.key === 'Escape') {
                e.stopPropagation();
                // Not the float's Escape either: it would close the float with the draft in it.
                e.preventDefault();
                if (draft === draftStart) editing = false;
              }
            }}
          ></textarea>
        </label>
        <div class="edit-actions">
          <button type="button" disabled={app.locked} onclick={() => void saveBody()}>{t('detail.body_save')}</button>
          <button type="button" disabled={app.locked} onclick={() => (editing = false)}>{t('detail.body_cancel')}</button>
        </div>
      {:else if raw}
        <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
        <pre class="body" tabindex="0">{markHidden(body)}</pre>
      {:else}
        <!-- A long text scrolls in its box: the box takes the focus, so the keyboard can scroll it (as the plain text). -->
        <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
        <div class="body prose" tabindex="0"><Blocks {blocks} headingBase={2} /></div>
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
              data-field="note"
              maxlength="1000"
              readonly={app.locked}
              onkeydown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  // Read-only while a write is under way (it keeps the focus): Enter then writes nothing a second time.
                  if (!app.saving) void addNote();
                }
              }}
            />
          </label>
          <button type="button" disabled={app.locked || note.trim() === ''} onclick={() => void addNote()}
            >{t('detail.note_button')}</button
          >
        </div>
      {/if}
      {#if app.can('move_area') && task.status !== 'done'}
        <div class="note" role="group" aria-label={t('move.label')}>
          <label>
            <span>{t('move.label')}</span>
            <select
              bind:value={moveTo}
              data-field="move"
              disabled={app.locked}
              onchange={() => {
                movePreview = null;
              }}
            >
              <option value="">{t('field.none')}</option>
              {#each app.allAreaNames.filter((a) => a !== task.area) as area (area)}
                <option value={area}>{area}</option>
              {/each}
            </select>
          </label>
          {#if movePreview?.kind === 'ok' && movePreview.move.conflicts.length === 0}
            <button type="button" disabled={app.locked} onclick={() => void doMove()}
              >{t('move.confirm', { id: movePreview.move.new_id })}</button
            >
          {:else}
            <button type="button" data-hint={t('hint.ui.detail.move_check')} disabled={app.locked || moveTo === ''} onclick={() => void checkMove()}
              >{t('move.check')}</button
            >
          {/if}
        </div>
        {#if movePreview?.kind === 'ok'}
          <p class="muted" role="status">
            {#if movePreview.move.conflicts.length > 0}
              {#each movePreview.move.conflicts as c, i (i)}{markHidden(c.message)} {/each}
            {:else}
              {t('move.rewrites', { n: movePreview.move.references.length })}
            {/if}
            {#if classChange}
              {t('move.class_differs', classChange)}
            {/if}
          </p>
        {:else if movePreview?.kind === 'refused'}
          <p class="bad" role="alert">{markHidden(movePreview.message)}</p>
        {:else if movePreview?.kind === 'unknown'}
          <p class="bad" role="alert">{t('move.unknown')}</p>
        {/if}
      {/if}
      {#if app.can('append_note') && app.can('ops') && task.status !== 'done' && task.status !== 'parked'}
        <div class="note" role="group" aria-label={t('discard.label')}>
          <label>
            <span>{t('discard.label')} <small>({t('discard.hint')})</small></span>
            <input
              type="text"
              bind:value={reason}
              data-field="reason"
              maxlength="900"
              readonly={app.locked}
              onkeydown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  if (!app.saving) void discard();
                }
              }}
            />
          </label>
          <button type="button" disabled={app.locked || reason.trim() === ''} onclick={() => void discard()}
            >{t('discard.button')}</button
          >
        </div>
      {/if}
    {/if}

    {#if app.findingsFor(task.id).length > 0}
      <h3>{t('check.section')}</h3>
      <ul class="findings">
        {#each app.findingsFor(task.id) as f, i (i)}
          <li><code>{f.code}</code> {markHidden(f.message)}</li>
        {/each}
      </ul>
    {/if}

    <h3>{t('detail.file')}</h3>
    <p><code class="file">{task.file}</code></p>
    <p>
      {#if app.machineActions}
        <button type="button" class="open-editor" data-hint={t('hint.ui.detail.open_editor')} onclick={() => void app.openInEditor(task.id)}
          >{t('editor.button')}</button
        >
      {/if}
      {#if app.can('plan_for')}
        <button type="button" class="open-editor" data-hint={t('hint.ui.detail.graph')} onclick={() => app.openGraph(task.id)}>{t('graph.button')}</button>
      {/if}
      {#if app.canAttach}
        <button
          type="button"
          class="open-editor"
          data-hint={t('hint.ui.detail.attach')}
          disabled={app.locked}
          onclick={() => void app.attachScreenshot(task.id)}>{t('attach.button')}</button
        >
      {/if}
    </p>
    {#if app.attached && app.attached.id === task.id}
      {@const link = app.attached.link}
      <p class="attached">
        <label>
          <span>{t('attach.link')}</span>
          <input type="text" readonly value={link} onfocus={(e) => e.currentTarget.select()} />
        </label>
        <button type="button" class="open-editor" onclick={() => void copyLink(link)}>{t('attach.copy')}</button>
      </p>
    {/if}
    <!-- The step that ends the task: larger than the other buttons, in the lower right corner of the card (it stays
         there while the card scrolls), last in the order of the keyboard. -->
    <div class="finish-row">
      <button type="button" class="finish" data-hint={t('hint.ui.detail.finish')} disabled={app.locked} onclick={() => void app.startFinish(task.id)}
        ><span class="finish-icon" aria-hidden="true">✓</span> {t('done.button')}</button
      >
    </div>
  {/if}
</aside>

<style>
  /* One field per line for the texts, then the choices in columns that fit their values: nothing is cut to share a
     line with its neighbour. */
  .draft {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.5rem;
    margin: 0.5rem 0;
    padding: 0.4rem 0.6rem;
    border: 1px solid var(--border);
    border-left: 3px solid var(--accent);
    border-radius: var(--radius);
    background: var(--surface-2);
  }
  .draft [role='status'] {
    flex: 1 1 auto;
  }
  .edit {
    display: grid;
    gap: 0.6rem;
    margin: 0.5rem 0 0.75rem;
  }
  .picks {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(9rem, 1fr));
    gap: 0.6rem;
    align-items: end;
  }
  .edit label {
    display: grid;
    gap: 0.15rem;
    min-width: 0;
    font-size: 0.8rem;
    color: var(--muted);
  }
  .edit select,
  .edit input,
  .edit textarea {
    min-width: 0;
    background: var(--surface-2);
    color: var(--text);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 0.25rem 0.5rem;
    font-size: 0.9rem;
  }
  .edit textarea.summary {
    font: inherit;
    font-size: 0.9rem;
    resize: vertical;
  }
  .findings {
    margin: 0 0 0.6rem;
    padding-left: 1.1rem;
    font-size: 0.85rem;
  }
  .attached {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
    align-items: end;
  }
  .attached label {
    display: grid;
    gap: 0.2rem;
    flex: 1 1 14rem;
  }
  .open-editor {
    background: var(--surface-2);
    color: var(--text);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 0.25rem 0.7rem;
    cursor: pointer;
  }
  .weblinks {
    display: flex;
    flex-wrap: wrap;
    gap: 0.1rem 0.8rem;
    font-size: 0.85em;
    overflow-wrap: anywhere;
  }
  /* The row is as wide as the card but lets the pointer through beside the button: it stands over the text it sticks
     to. */
  .finish-row {
    position: sticky;
    bottom: 0;
    display: flex;
    justify-content: flex-end;
    margin-top: 1rem;
    pointer-events: none;
  }
  .finish {
    pointer-events: auto;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 0.5rem;
    min-width: 9rem;
    min-height: 2.75rem;
    padding: 0.5rem 1.4rem;
    font-size: 1.05rem;
    font-weight: 600;
    background: var(--surface-2);
    color: var(--text);
    border: 2px solid var(--accent);
    border-radius: var(--radius);
    box-shadow: var(--shadow-sm);
    cursor: pointer;
  }
  .finish:hover:not(:disabled) {
    background: var(--accent-soft);
  }
  .finish-icon {
    color: var(--ok);
    font-size: 1.2em;
    line-height: 1;
  }
  .finish:disabled {
    opacity: 0.6;
    cursor: default;
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
    /* A tall form must not stretch the row of the page it stands in (the board's columns would grow with it). */
    align-self: start;
    max-height: calc(100vh - 5rem);
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
  /* Its own class: `.edit` is the group of the fields above, a wrapping row whose wide fields have a flex basis, and a
     column rule on the same name turned that basis into a height (every wide field 14rem tall). */
  .body-edit {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
  }
  .body-edit textarea {
    width: 100%;
    box-sizing: border-box;
    font: inherit;
    font-family: var(--mono, monospace);
    background: var(--surface-2);
    color: var(--text);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 0.5rem;
    resize: vertical;
  }
  .edit-actions {
    display: flex;
    gap: 0.5rem;
    margin-top: 0.5rem;
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
  .question {
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 0.4rem 0.6rem;
    margin-bottom: 0.5rem;
  }
  .question h4 {
    margin: 0 0 0.2rem;
    font-size: 0.9rem;
  }
  .question.answered {
    opacity: 0.85;
  }
  .options {
    display: grid;
    gap: 0.25rem;
  }
  .option {
    display: inline-flex;
    align-items: baseline;
    gap: 0.4rem;
    width: 100%;
    text-align: left;
    background: var(--surface-2);
    color: var(--text);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 0.3rem 0.5rem;
    font: inherit;
  }
  button.option {
    cursor: pointer;
  }
  button.option:hover:not(:disabled) {
    border-color: var(--accent);
  }
  .option.chosen {
    border-color: var(--accent);
    background: var(--accent-soft);
  }
  .option.recommended:not(.chosen) {
    border-style: dashed;
  }
  .badge {
    margin-left: auto;
    font-size: 0.7rem;
    color: var(--accent);
    border: 1px solid var(--accent);
    border-radius: var(--radius-pill);
    padding: 0 0.4rem;
    white-space: nowrap;
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
