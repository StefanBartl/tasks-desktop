<script lang="ts">
  // The button of the bar that opens the conflict center. A new refusal shows it in words for a few seconds; after
  // that only the number stays, still in the colour of a refusal, so the bar is tidier. The words stay as the name
  // of the button (a screen reader hears them in both states) and as its hint.
  import type { App } from '../lib/app.svelte';
  import { translate, type Key } from '../lib/i18n';

  let { app }: { app: App } = $props();
  const t = (key: Key, params: Record<string, string | number> = {}) => translate(app.lang, key, params);

  /** How long the words stand after a new refusal. */
  const WORDS_MS = 5000;

  const n = $derived(app.conflicts.length);
  let words = $state(true);
  let seen = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;

  // Words again whenever the number grows (a new refusal); a smaller number leaves the state and the running pause as
  // they are (the timer is not part of the effect's cleanup, which would drop it when the number falls).
  $effect(() => {
    const count = n;
    const grew = count > seen;
    seen = count;
    if (!grew) return;
    words = true;
    clearTimeout(timer);
    timer = setTimeout(() => (words = false), WORDS_MS);
  });
  $effect(() => () => clearTimeout(timer));

  const full = $derived(t('conflicts.button', { n }));
</script>

<button
  type="button"
  class="conflicts"
  class:compact={!words}
  aria-label={words ? undefined : full}
  data-hint={words ? t('hint.ui.conflicts') : `${full}\n${t('hint.ui.conflicts')}`}
  onclick={() => app.openConflicts()}>{words ? full : n}</button
>

<style>
  .conflicts {
    background: var(--surface-2);
    color: var(--bad);
    border: 1px solid var(--bad);
    border-radius: var(--radius);
    padding: 0.15rem 0.6rem;
    font-size: 0.8rem;
    cursor: pointer;
  }
  .compact {
    min-width: 1.6rem;
    padding: 0.15rem 0.4rem;
    font-variant-numeric: tabular-nums;
  }
</style>
