<script lang="ts">
  // The way in of the web variant: choose the vault folder, or take one used before. What happens is the state machine's
  // (entry.ts); this draws its state and passes the clicks on. A click handler calls the machine first and awaits
  // nothing before it: the browser asks for a permission only inside a click.
  import { untrack } from 'svelte';
  import type { Entry, EntryState } from './entry';
  import { translate, type Key, type Lang } from '../lib/i18n';

  let { entry, lang }: { entry: Entry; lang: Lang } = $props();

  // The state at the start comes from the machine, once; later states come through the subscription.
  let view = $state<EntryState>(untrack(() => entry.state));
  $effect(() => {
    view = entry.state;
    return entry.subscribe((next) => (view = next));
  });

  const t = (key: Key, params: Record<string, string | number> = {}) => translate(lang, key, params);
  const busy = $derived(view.step === 'opening');
</script>

<section class="card entry" aria-labelledby="web-entry-title" aria-busy={busy}>
  <h1 id="web-entry-title">{t('web.entry.title')}</h1>

  {#if view.step === 'unsupported'}
    <p role="alert">{t(`web.entry.unsupported.${view.reason}` as Key)}</p>
  {:else}
    <p>{t('web.entry.lead')}</p>

    {#if view.step === 'choose' && view.notice}
      <p role="alert" class="notice">
        {t(`web.entry.notice.${view.notice.code}` as Key, { detail: view.notice.detail ?? '' })}
      </p>
    {/if}

    {#if view.step === 'opening'}
      <p role="status">{t('web.entry.opening', { name: view.name })}</p>
    {:else if view.step === 'open'}
      <p role="status">{t('web.entry.opening', { name: view.name })}</p>
      {#if view.skipped.length > 0}
        <p class="muted">{t('web.entry.skipped', { count: view.skipped.length })}</p>
      {/if}
    {:else if view.step === 'choose'}
      <p>
        <button type="button" class="primary" onclick={() => void entry.pick()}>{t('web.entry.pick')}</button>
      </p>

      {#if view.recent.length > 0}
        <h2>{t('web.entry.recent')}</h2>
        <ul class="recent">
          {#each view.recent as item (item.id)}
            <li>
              <span class="name">{item.name}</span>
              <span class="muted state">{t(`web.entry.state.${item.access}` as Key)}</span>
              {#if item.access !== 'gone'}
                <button type="button" onclick={() => void entry.openRecent(item.id)}>
                  {item.access === 'granted' ? t('web.entry.open') : t('web.entry.allow')}
                </button>
              {/if}
              <button type="button" class="quiet" onclick={() => void entry.forget(item.id)}>
                {t('web.entry.forget')}
              </button>
            </li>
          {/each}
        </ul>
        {#if view.recent.some((item) => item.access === 'prompt')}
          <p class="muted">{t('web.entry.allow_hint')}</p>
        {/if}
      {/if}
    {/if}
  {/if}
</section>

<style>
  .entry {
    max-width: 38rem;
    margin: 3rem auto;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 1.25rem;
  }
  .muted {
    color: var(--muted);
  }
  .notice {
    color: var(--warn);
  }
  .recent {
    list-style: none;
    margin: 0;
    padding: 0;
    display: grid;
    gap: 0.5rem;
  }
  .recent li {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.5rem;
  }
  .name {
    font-weight: 600;
    overflow-wrap: anywhere;
  }
  .state {
    flex: 1 1 auto;
  }
</style>
