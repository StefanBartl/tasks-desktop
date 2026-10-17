<script lang="ts">
  // The finished tasks of the chosen plan, ticked, in front of the stages: the plan view otherwise shows only what is
  // still open (a finished blocker counts as met, the finished task itself is not drawn). The engine finds them
  // (`tasks.finished` with the plan); a finished task has no stage, so they stand in a group of their own.
  import { untrack } from 'svelte';
  import type { App } from '../lib/app.svelte';
  import type { Finished } from '../lib/contract';
  import { ApiError } from '../lib/api';
  import { translate, type Key } from '../lib/i18n';
  import { markHidden } from '../lib/text';

  let { app, planId }: { app: App; planId: string } = $props();
  const t = (key: Key, params: Record<string, string | number> = {}) => translate(app.lang, key, params);

  let show = $state(false);
  let doc = $state<Finished | null>(null);
  let items = $state<Finished['items']>([]);
  let problem = $state<string | null>(null);
  let loading = $state(false);
  let seq = 0;

  async function load(plan: string, offset: number): Promise<void> {
    seq += 1;
    const mine = seq;
    loading = true;
    try {
      const next = await app.finished({ plan, ...(offset > 0 ? { offset } : {}) });
      if (mine !== seq) return;
      doc = next;
      items = offset > 0 ? [...items, ...next.items] : next.items;
      problem = null;
    } catch (error) {
      if (mine !== seq) return;
      problem = error instanceof ApiError ? error.message : t('done.failed');
      if (offset === 0) {
        doc = null;
        items = [];
      }
    } finally {
      if (mine === seq) loading = false;
    }
  }

  // Asks when it is switched on, when another plan is chosen, and when the vault changes.
  let loadedFor = '';
  $effect(() => {
    const plan = planId;
    void app.snapshot?.rev;
    if (!show || plan === '') {
      seq += 1;
      loading = false;
      doc = null;
      items = [];
      loadedFor = '';
      return;
    }
    untrack(() => {
      // Another plan: the old plan's tasks do not stand under the new one while the answer is on its way.
      if (plan !== loadedFor) {
        doc = null;
        items = [];
        problem = null;
      }
      loadedFor = plan;
      void load(plan, 0);
    });
  });
</script>

{#if planId !== '' && app.can('finished')}
  <label class="switch"><input type="checkbox" bind:checked={show} /> {t('plan.show_finished')}</label>
  {#if show}
    <section class="card" aria-labelledby="plan-finished-title">
      <h2 id="plan-finished-title" class="eyebrow">
        {t('plan.finished')}{#if doc} ({doc.total}){/if}
      </h2>
      {#if problem}
        <p class="problem" role="alert">{problem}</p>
      {:else if !doc}
        <p class="muted" role="status">{t('state.loading')}</p>
      {:else if items.length === 0}
        <p class="muted">{t('plan.finished_none')}</p>
      {:else}
        <ul class="plain">
          {#each items as item (item.file)}
            <li>
              <span aria-hidden="true">✓</span>
              <span class="sr-only">{t('plan.finished_mark')}</span>
              <span class="title">{markHidden(item.title)}</span>
              <span class="muted">{item.done ?? t('done.undated_row')}</span>
              {#if item.phase}<span class="muted">{markHidden(item.phase)}</span>{/if}
            </li>
          {/each}
        </ul>
        {#if doc?.next_offset !== undefined}
          <button
            type="button"
            disabled={loading}
            onclick={() => doc?.next_offset !== undefined && void load(planId, doc.next_offset)}>{t('done.more')}</button
          >
        {/if}
      {/if}
    </section>
  {/if}
{/if}

<style>
  .switch {
    display: block;
  }
  .card {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 0.9rem 1rem;
  }
  .eyebrow {
    font-size: 0.8rem;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--muted);
    margin: 0 0 0.5rem;
  }
  .plain {
    list-style: none;
    padding: 0;
    margin: 0;
  }
  .title {
    overflow-wrap: anywhere;
  }
  li {
    display: flex;
    flex-wrap: wrap;
    gap: 0.25rem 0.75rem;
    padding: 0.25rem 0;
  }
  .muted {
    color: var(--muted);
  }
  .problem {
    color: var(--bad);
  }
</style>
