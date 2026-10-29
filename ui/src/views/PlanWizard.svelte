<script lang="ts">
  import { closeOnBackdrop } from 'appkit-ui/backdrop';
  import { floating } from '../lib/floating';
  // The plan wizard: a title and an area are enough; the rest (the areas it covers, the phases, the target, the gate)
  // is optional. While the person types, the engine is asked for a dry run: it names the plan, says when the name is
  // taken and refuses a form that is not one, so the rules are not written a second time here.
  import type { App } from '../lib/app.svelte';
  import { areaLabel } from '../lib/filter';
  import { translate, type Key } from '../lib/i18n';
  import {
    PLAN_STATUSES,
    canCreate,
    emptyForm,
    parsePhases,
    type PlanForm,
    type PlanPreview,
  } from '../lib/planwizard';
  import MultiSelect from 'appkit-ui/MultiSelect.svelte';

  let { app }: { app: App } = $props();
  const t = (key: Key, params: Record<string, string | number> = {}) =>
    translate(app.lang, key, params);

  let dialog: HTMLDialogElement | undefined = $state();
  let form = $state<PlanForm>(emptyForm());
  // The answer of the dry run, with the form it was asked for: an answer for an older form is none for this one.
  let answer = $state<{ key: string; value: PlanPreview } | null>(null);
  const formKey = $derived(JSON.stringify(form));
  const preview = $derived<PlanPreview | null>(answer && answer.key === formKey ? answer.value : null);
  // The areas the plan covers follow the area of the file until the person chooses them.
  let areasTouched = $state(false);
  let busy = $state(false);

  const areas = $derived(
    [...app.allAreaNames]
      .map((name) => ({ value: name, label: app.shortAreas ? areaLabel(name, app.allAreaNames) : name, title: name }))
      .sort((a, b) => a.label.localeCompare(b.label)),
  );
  const phases = $derived(parsePhases(form.phases));
  // The open tasks, offered as the target of the plan (typed text is allowed too).
  const targets = $derived(app.tasks.map((x) => x.id));

  $effect(() => {
    if (!dialog) return;
    if (app.planning && !dialog.open) {
      const area = app.filter.areas.length === 1 ? (app.filter.areas[0] ?? '') : (areas[0]?.value ?? '');
      form = emptyForm(area);
      answer = null;
      areasTouched = false;
      dialog.showModal();
    }
    if (!app.planning && dialog.open) dialog.close();
  });

  // The dry run follows the form, a moment after the last key; an answer that arrives late for an older form is dropped.
  $effect(() => {
    if (!app.planning) return;
    const snapshot = $state.snapshot(form) as PlanForm;
    if (snapshot.title.trim() === '' || snapshot.area === '') return;
    const key = JSON.stringify(snapshot);
    const abort = new AbortController();
    const timer = setTimeout(async () => {
      const value = await app.previewPlan(snapshot, abort.signal);
      if (!abort.signal.aborted) answer = { key, value };
    }, 250);
    return () => {
      clearTimeout(timer);
      abort.abort();
    };
  });

  async function submit(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    if (busy || app.saving || !canCreate(form, preview)) return;
    busy = true;
    try {
      await app.createPlan($state.snapshot(form) as PlanForm);
    } finally {
      busy = false;
    }
  }
</script>

<dialog bind:this={dialog} use:floating={{ kind: 'plan-wizard', moveLabel: t('float.move'), moveHint: t('hint.float.move') }} use:closeOnBackdrop={{ closeable: () => form.title.trim() === '' }} aria-labelledby="plan-title" onclose={() => app.closePlanWizard()}>
  <form onsubmit={submit}>
    <h2 id="plan-title">{t('plan.new.title')}</h2>
    <label>
      <span>{t('capture.name')}</span>
      <!-- svelte-ignore a11y_autofocus -->
      <input type="text" bind:value={form.title} maxlength="300" required autofocus />
    </label>
    <label>
      <span>{t('plan.new.area')}</span>
      <select
        bind:value={form.area}
        required
        onchange={() => {
          if (!areasTouched) form.areas = form.area ? [form.area] : [];
        }}
      >
        {#each areas as a (a.value)}
          <option value={a.value} title={a.title}>{a.label}</option>
        {/each}
      </select>
    </label>
    <div class="field">
      <!-- The choice carries its own label; a second one above it said the same twice. -->
      <MultiSelect
        label={t('plan.new.areas')}
        options={areas}
        selected={form.areas}
        onchange={(next) => {
          areasTouched = true;
          form.areas = next;
        }}
        resetLabel={t('multi.reset')}
        searchLabel={t('multi.search')}
      />
      <small class="hint">{t('plan.new.areas_hint')}</small>
    </div>
    <label>
      <span>{t('plan.new.phases')} <small>({t('field.tags_hint')})</small></span>
      <input type="text" bind:value={form.phases} placeholder={t('plan.new.phases_example')} />
    </label>
    {#if phases.length > 0}
      <p class="phases" role="group" aria-label={t('plan.new.order')}>
        {#each phases as phase, i (phase)}<span class="chip">{i + 1} {phase}</span>{/each}
      </p>
    {/if}
    <label>
      <span>{t('plan.new.target')}</span>
      <input type="text" bind:value={form.target} list="plan-targets" placeholder="lib.nvim/alpha" />
      <datalist id="plan-targets">
        {#each targets as id (id)}<option value={id}></option>{/each}
      </datalist>
    </label>
    <label>
      <span>{t('plan.new.status')}</span>
      <select bind:value={form.status}>
        {#each PLAN_STATUSES as s (s)}<option value={s}>{t(`plan.status.${s}` as Key)}</option>{/each}
      </select>
    </label>
    <label class="check">
      <input type="checkbox" bind:checked={form.hard} />
      <span>{t('plan.new.gate')}</span>
    </label>
    <label>
      <span>{t('plan.new.summary')}</span>
      <input type="text" bind:value={form.summary} maxlength="1000" />
    </label>

    <p class="preview" role="status" aria-live="polite">
      {#if preview?.kind === 'ok'}
        {#if preview.renamed}
          <span class="warn">{t('plan.new.taken', { id: preview.id })}</span>
        {:else}
          {t('plan.new.will', { id: preview.id })}
        {/if}
      {:else if preview?.kind === 'refused'}
        <span class="bad">{preview.message}</span>
      {:else if preview?.kind === 'unknown' && form.title.trim() !== ''}
        <span class="warn">{t('plan.new.unknown')}</span>
      {/if}
    </p>

    <div class="actions">
      <button type="button" onclick={() => app.closePlanWizard()}>{t('dialog.cancel')}</button>
      <button type="submit" class="primary" disabled={busy || app.saving || !canCreate(form, preview)}
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
    width: min(34rem, calc(100vw - 2rem));
    max-height: calc(100vh - 2rem);
    overflow: auto;
  }
  dialog::backdrop {
    background: var(--backdrop);
  }
  h2 {
    margin: 0 0 0.75rem;
    font-size: 1.1rem;
  }
  label,
  .field {
    display: grid;
    gap: 0.2rem;
    margin-bottom: 0.7rem;
  }
  label.check {
    display: flex;
    gap: 0.5rem;
    align-items: center;
  }
  input[type='text'],
  select {
    background: var(--surface-2);
    color: var(--text);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 0.35rem 0.5rem;
  }
  .hint {
    color: var(--muted);
  }
  .phases {
    display: flex;
    flex-wrap: wrap;
    gap: 0.3rem;
    margin: -0.3rem 0 0.7rem;
  }
  .chip {
    font-size: 0.75rem;
    padding: 0 0.5rem;
    border: 1px solid var(--border);
    border-radius: 999px;
    color: var(--muted);
  }
  .preview {
    min-height: 1.4rem;
    margin: 0 0 0.7rem;
    font-size: 0.85rem;
    color: var(--muted);
    overflow-wrap: anywhere;
  }
  .warn {
    color: var(--warn);
  }
  .bad {
    color: var(--bad);
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
