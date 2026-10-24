<script lang="ts">
  import { closeOnBackdrop } from 'appkit-ui/backdrop';
  // Quick capture: a title and an area, nothing else is required. The
  // engine gives the task its place and its file; the page selects it.
  import type { App } from '../lib/app.svelte';
  import { areaLabel } from '../lib/filter';
  import { badTag, parseList, parseTags } from '../lib/fields';
  import { labelOf, translate, type Key } from '../lib/i18n';

  let { app }: { app: App } = $props();
  const t = (key: Key, params: Record<string, string | number> = {}) =>
    translate(app.lang, key, params);

  let dialog: HTMLDialogElement | undefined = $state();
  let title = $state('');
  let area = $state('');
  let prio = $state('');
  let kind = $state('');
  let effort = $state('');
  let value = $state('');
  let actor = $state('');
  let summary = $state('');
  let tags = $state('');
  let category = $state('');
  let severity = $state('');
  let refs = $state('');
  let problem = $state('');
  let text = $state('');
  let attach = $state(false);
  let busy = $state(false);

  const areas = $derived(
    [...app.allAreaNames]
      .map((name) => ({ name, label: app.shortAreas ? areaLabel(name, app.allAreaNames) : name }))
      .sort((a, b) => a.label.localeCompare(b.label)),
  );

  $effect(() => {
    if (!dialog) return;
    if (app.capturing && !dialog.open) {
      // The area of the filter, when exactly one is chosen, is the one most
      // likely meant.
      area = app.filter.areas.length === 1 ? (app.filter.areas[0] ?? '') : (areas[0]?.name ?? '');
      title = '';
      prio = '';
      kind = '';
      effort = '';
      value = '';
      actor = '';
      summary = '';
      tags = '';
      category = '';
      severity = '';
      refs = '';
      problem = '';
      text = '';
      attach = false;
      dialog.showModal();
    }
    if (!app.capturing && dialog.open) dialog.close();
  });

  async function submit(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    if (busy || title.trim() === '' || area === '') return;
    busy = true;
    try {
      const fields: Record<string, unknown> = {};
      if (prio !== '') fields['prio'] = Number(prio);
      if (kind !== '') fields['kind'] = kind;
      if (effort !== '') fields['effort'] = effort;
      if (value !== '') fields['value'] = Number(value);
      if (actor !== '') fields['actor'] = actor;
      if (summary.trim() !== '') fields['summary'] = summary.trim();
      const tagList = parseTags(tags);
      const bad = badTag(tagList);
      if (bad !== null) {
        problem = t('field.tags_invalid', { tag: bad });
        return;
      }
      problem = '';
      if (tagList.length > 0) fields['tags'] = tagList;
      if (category !== '') fields['category'] = [category];
      if (severity !== '') fields['severity'] = severity;
      const refList = parseList(refs);
      if (refList.length > 0) fields['refs'] = refList;
      const created = await app.createTask(area, title.trim(), fields, text);
      // After the task is made: a plain task becomes the folder of its asset.
      if (created && attach) await app.attachScreenshot(created);
    } finally {
      busy = false;
    }
  }
</script>

<dialog bind:this={dialog} use:closeOnBackdrop={{ closeable: () => [title, text, summary, tags, refs].every((v) => v.trim() === '') }} aria-labelledby="capture-title" onclose={() => app.closeCapture()}>
  <form onsubmit={submit}>
    <h2 id="capture-title">{t('capture.title')}</h2>
    <label>
      <span>{t('capture.name')}</span>
      <!-- svelte-ignore a11y_autofocus -->
      <input type="text" bind:value={title} maxlength="300" required autofocus />
    </label>
    <label>
      <span>{t('capture.area')}</span>
      <select bind:value={area} required>
        {#each areas as a (a.name)}
          <option value={a.name} title={a.name}>{a.label}</option>
        {/each}
      </select>
    </label>
    <div class="grid">
      <label>
        <span>{t('field.kind')}</span>
        <select bind:value={kind}>
          <option value="">{t('field.none')}</option>
          {#each app.ranges.kinds as k (k)}<option value={k}>{labelOf(app.lang, 'kind', k)}</option>{/each}
        </select>
      </label>
      <label>
        <span>{t('field.prio')}</span>
        <select bind:value={prio}>
          <option value="">{t('field.none')}</option>
          {#each app.ranges.prios as p (p)}<option value={String(p)}>{p}</option>{/each}
        </select>
      </label>
      <label>
        <span>{t('field.effort')}</span>
        <select bind:value={effort}>
          <option value="">{t('field.none')}</option>
          {#each app.ranges.efforts as e (e)}<option value={e}>{e}</option>{/each}
        </select>
      </label>
      <label>
        <span>{t('field.value')}</span>
        <select bind:value={value}>
          <option value="">{t('field.none')}</option>
          {#each app.ranges.values as v (v)}<option value={String(v)}>{v}</option>{/each}
        </select>
      </label>
      <label>
        <span>{t('field.actor')}</span>
        <select bind:value={actor}>
          <option value="">{t('field.none')}</option>
          {#each app.ranges.actors as a (a)}<option value={a}>{labelOf(app.lang, 'actor', a)}</option>{/each}
        </select>
      </label>
    </div>
    <details class="more">
      <summary>{t('capture.more')}</summary>
      <label>
        <span>{t('field.summary')}</span>
        <input type="text" bind:value={summary} maxlength="300" />
      </label>
      <label>
        <span>{t('field.tags')} <small>({t('field.tags_hint')})</small></span>
        <input type="text" bind:value={tags} />
      </label>
      <div class="grid">
        <label>
          <span>{t('field.category')}</span>
          <select bind:value={category}>
            <option value="">{t('field.none')}</option>
            {#each app.ranges.categories as c (c)}<option value={c}>{labelOf(app.lang, 'category', c)}</option>{/each}
          </select>
        </label>
        <label>
          <span>{t('field.severity')}</span>
          <select bind:value={severity}>
            <option value="">{t('field.none')}</option>
            {#each app.ranges.severities as v (v)}<option value={v}>{labelOf(app.lang, 'severity', v)}</option>{/each}
          </select>
        </label>
      </div>
      <label>
        <span>{t('field.refs')} <small>({t('field.tags_hint')})</small></span>
        <input type="text" bind:value={refs} />
      </label>
    </details>
    <label>
      <span>{t('capture.body')} <small>({t('capture.body_hint')})</small></span>
      <textarea bind:value={text} rows="5" maxlength="20000"></textarea>
    </label>
    {#if app.can('attach')}
      <label class="check">
        <input type="checkbox" bind:checked={attach} />
        <span>{t('capture.attach')}</span>
      </label>
    {/if}
    {#if problem}<p class="problem" role="alert">{problem}</p>{/if}
    <div class="actions">
      <button type="button" onclick={() => app.closeCapture()}>{t('dialog.cancel')}</button>
      <button type="submit" class="primary" disabled={busy || title.trim() === ''}
        >{t('capture.create')}</button
      >
    </div>
  </form>
</dialog>

<style>
  dialog {
    background: var(--surface);
    color: var(--text);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 1rem 1.25rem;
    width: min(36rem, calc(100vw - 2rem));
  }
  dialog::backdrop {
    background: var(--backdrop);
  }
  h2 {
    margin: 0 0 0.75rem;
    font-size: 1.1rem;
  }
  label {
    display: grid;
    gap: 0.2rem;
    margin-bottom: 0.7rem;
  }
  .grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(9rem, 1fr));
    gap: 0 0.75rem;
  }
  .more {
    margin-bottom: 0.7rem;
  }
  .more summary {
    cursor: pointer;
    color: var(--accent);
    margin-bottom: 0.5rem;
  }
  .problem {
    color: var(--bad);
    margin: 0 0 0.6rem;
  }
  label.check {
    display: flex;
    align-items: center;
    gap: 0.4rem;
  }
  input,
  textarea,
  select {
    background: var(--surface-2);
    color: var(--text);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 0.35rem 0.5rem;
  }
  .actions {
    display: flex;
    justify-content: flex-end;
    gap: 0.5rem;
  }
  button {
    background: var(--surface-2);
    color: var(--text);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 0.35rem 0.8rem;
    cursor: pointer;
  }
  .primary {
    border-color: var(--accent);
  }
  button:disabled {
    opacity: 0.6;
    cursor: default;
  }
</style>
