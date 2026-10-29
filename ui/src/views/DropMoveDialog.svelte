<script lang="ts">
  import { closeOnBackdrop } from 'appkit-ui/backdrop';
  import { floating } from '../lib/floating';
  // A task dropped on an area (or given an area with the key or the button of its row): what the engine says the move
  // would do (a dry run, nothing written yet), and the choice to go on or to give up. A taken name in the target is
  // told, and then there is nothing to confirm. Marked tasks go together and are told one by one, as in the list.
  import type { App } from '../lib/app.svelte';
  import { classChange as classChangeOf } from '../lib/bulk';
  import { translate, type Key } from '../lib/i18n';
  import { markHidden } from '../lib/text';

  let { app }: { app: App } = $props();
  const t = (key: Key, params: Record<string, string | number> = {}) => translate(app.lang, key, params);

  let dialog: HTMLDialogElement | undefined = $state();
  const asking = $derived(app.dropMove);
  const choosing = $derived(app.dropChoose);
  const chosenTask = $derived(choosing ? app.tasks.find((x) => x.id === choosing) : undefined);
  const task = $derived(asking ? app.tasks.find((x) => x.id === asking.id) : undefined);
  const answer = $derived(asking?.answer ?? null);
  const open = $derived(asking !== null || choosing !== null);
  const dataClassOf = (name: string): string | undefined => app.hubAreas.find((a) => a.name === name)?.data_class;
  const classChange = $derived.by(() => {
    if (!asking || !task) return null;
    return classChangeOf(dataClassOf(task.area), dataClassOf(asking.toArea));
  });
  // The marked tasks that change the data class, counted per class they come from.
  const classCounts = $derived.by(() => {
    if (!asking?.checks) return [];
    const to = dataClassOf(asking.toArea);
    const counts = new Map<string, number>();
    for (const c of asking.checks) {
      if (c.reasons.length > 0) continue;
      const area = app.tasks.find((x) => x.id === c.id)?.area;
      if (area === undefined) continue;
      const change = classChangeOf(dataClassOf(area), to);
      if (change) counts.set(change.from, (counts.get(change.from) ?? 0) + 1);
    }
    return [...counts].map(([from, n]) => ({ from, to: to ?? '?', n }));
  });
  const movable = $derived(asking?.checks?.filter((c) => c.reasons.length === 0 && c.newId !== '').length ?? 0);
  const confirmable = $derived(
    asking !== null && (asking.count > 1 ? movable > 0 : answer?.kind === 'ok' && answer.move.conflicts.length === 0),
  );

  // The area chosen without a drag.
  let area = $state('');
  const areas = $derived(app.allAreaNames.filter((a) => a !== chosenTask?.area));
  $effect(() => {
    void choosing;
    area = '';
  });
  function goChosen(): void {
    if (choosing && area !== '') void app.askDropMove(choosing, area);
  }

  $effect(() => {
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  });
  function closed(): void {
    app.cancelDropMove();
    app.cancelDropChoose();
  }
</script>

<dialog bind:this={dialog} use:floating={{ kind: 'drop-move', moveLabel: t('float.move'), moveHint: t('hint.float.move') }} use:closeOnBackdrop aria-labelledby="drop-move-title" onclose={closed}>
  {#if asking === null && choosing !== null}
    <h2 id="drop-move-title">{t('drop.choose')}</h2>
    <p class="what">{markHidden(chosenTask?.title ?? choosing)}</p>
    <p class="id"><code>{choosing}</code></p>
    <label class="pick">
      <span>{t('drop.choose_area')}</span>
      <select bind:value={area}>
        <option value="">{t('field.none')}</option>
        {#each areas as a (a)}<option value={a}>{a}</option>{/each}
      </select>
    </label>
    <div class="actions">
      <button type="button" onclick={() => app.cancelDropChoose()}>{t('dialog.cancel')}</button>
      <button type="button" class="primary" disabled={app.saving || area === ''} onclick={goChosen}
        >{t('drop.choose_go')}</button
      >
    </div>
  {:else if asking}
    <h2 id="drop-move-title">
      {asking.count > 1
        ? t('drop.title_many', { n: asking.count, area: asking.toArea })
        : t('drop.title', { area: asking.toArea })}
    </h2>
    {#if asking.count > 1}
      {#if asking.checks === null}
        <p class="muted" role="status">{t('drop.checking')}</p>
      {:else}
        <ul role="status" aria-label={t('bulk.move_result')}>
          {#each asking.checks as c (c.id)}
            <li class:bad={c.reasons.length > 0}>
              {#if c.reasons.length > 0}
                {t('bulk.move_refused', { id: c.id, reason: markHidden(c.reasons.join(' ')) })}
              {:else}
                {t('bulk.move_ok', { id: c.id, new_id: c.newId, n: c.references })}
              {/if}
            </li>
          {:else}
            <li>{t('bulk.nothing')}</li>
          {/each}
        </ul>
        {#each classCounts as m (m.from)}<p class="muted">{t('bulk.move_class', m)}</p>{/each}
      {/if}
    {:else}
      <p class="what">{markHidden(task?.title ?? asking.id)}</p>
      <p class="id"><code>{asking.id}</code></p>
      {#if answer === null}
        <p class="muted" role="status">{t('drop.checking')}</p>
      {:else if answer.kind === 'ok'}
        <p class="muted" role="status">
          {#if answer.move.conflicts.length > 0}
            {#each answer.move.conflicts as c, i (i)}{markHidden(c.message)} {/each}
          {:else}
            {t('move.rewrites', { n: answer.move.references.length })}
          {/if}
          {#if classChange}
            {t('move.class_differs', classChange)}
          {/if}
        </p>
      {:else if answer.kind === 'refused'}
        <p class="bad" role="alert">{markHidden(answer.message)}</p>
      {:else}
        <p class="bad" role="alert">{t('move.unknown')}</p>
      {/if}
    {/if}
    <div class="actions">
      <button type="button" onclick={() => app.cancelDropMove()}>{t('dialog.cancel')}</button>
      <button
        type="button"
        class="primary"
        disabled={app.saving || !confirmable}
        onclick={() => void app.confirmDropMove()}
        >{asking.count > 1
          ? t('bulk.move_go', { n: movable })
          : answer?.kind === 'ok'
            ? t('move.confirm', { id: answer.move.new_id })
            : t('move.check')}</button
      >
    </div>
  {/if}
</dialog>

<style>
  dialog {
    background: var(--surface);
    color: var(--text);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 1rem 1.25rem;
    width: min(30rem, calc(100vw - 2rem));
  }
  dialog::backdrop {
    background: var(--backdrop);
  }
  h2 {
    margin: 0 0 0.5rem;
    font-size: 1.1rem;
  }
  .what {
    font-weight: 600;
    margin: 0;
  }
  .id {
    margin: 0.1rem 0 0.6rem;
    color: var(--muted);
  }
  .muted {
    color: var(--muted);
  }
  .bad,
  li.bad {
    color: var(--bad);
  }
  ul {
    margin: 0 0 0.6rem;
    padding-left: 1.2rem;
  }
  .pick {
    display: flex;
    gap: 0.5rem;
    align-items: center;
    margin: 0.5rem 0 0.8rem;
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
