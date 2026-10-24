<script lang="ts">
  import { closeOnBackdrop } from 'appkit-ui/backdrop';
  // Quick capture: a title and an area, nothing else is required. The
  // engine gives the task its place and its file; the page selects it.
  import type { App } from '../lib/app.svelte';
  import { areaLabel } from '../lib/filter';
  import { translate, type Key } from '../lib/i18n';

  let { app }: { app: App } = $props();
  const t = (key: Key, params: Record<string, string | number> = {}) =>
    translate(app.lang, key, params);

  let dialog: HTMLDialogElement | undefined = $state();
  let title = $state('');
  let area = $state('');
  let prio = $state('');
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
      const created = await app.createTask(area, title.trim(), fields, text);
      // After the task is made: a plain task becomes the folder of its asset.
      if (created && attach) await app.attachScreenshot(created);
    } finally {
      busy = false;
    }
  }
</script>

<dialog bind:this={dialog} use:closeOnBackdrop={{ closeable: () => title.trim() === '' && text.trim() === '' }} aria-labelledby="capture-title" onclose={() => app.closeCapture()}>
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
    <label>
      <span>{t('field.prio')}</span>
      <select bind:value={prio}>
        <option value="">{t('field.none')}</option>
        <option value="1">1</option>
        <option value="2">2</option>
        <option value="3">3</option>
      </select>
    </label>
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
    width: min(28rem, calc(100vw - 2rem));
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
