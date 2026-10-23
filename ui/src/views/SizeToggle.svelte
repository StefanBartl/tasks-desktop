<script lang="ts">
  // The small button that shows the grip of a block (an upright rectangle, like a switch standing up), and, while a
  // block has a size of its own, the button that gives it the size of the layout back.
  import { translate, type Key, type Lang } from '../lib/i18n';

  let {
    lang,
    what,
    active,
    sized,
    ontoggle,
    onreset,
  }: {
    lang: Lang;
    /** The name of the block, for the labels. */
    what: string;
    active: boolean;
    /** Whether the block has a size of its own. */
    sized: boolean;
    ontoggle: () => void;
    onreset: () => void;
  } = $props();

  const t = (key: Key, params: Record<string, string | number> = {}) => translate(lang, key, params);
</script>

<button
  type="button"
  class="size"
  class:on={active}
  aria-pressed={active}
  aria-label={t('size.toggle', { what })}
  data-size-toggle
  data-hint={t('hint.size')}
  onclick={ontoggle}
>
  <span class="glyph" aria-hidden="true"></span>
</button>
{#if active && sized}
  <button type="button" class="size" aria-label={t('size.reset', { what })} data-hint={t('size.reset', { what })} onclick={onreset}>
    <span aria-hidden="true">↺</span>
  </button>
{/if}

<style>
  .size {
    flex: none;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-width: 1.6rem;
    min-height: 1.6rem;
    background: none;
    border: 1px solid transparent;
    border-radius: var(--radius);
    color: var(--muted);
    cursor: pointer;
    padding: 0 0.25rem;
  }
  .size:hover,
  .size:focus-visible {
    color: var(--text);
    background: var(--surface-2);
  }
  .size.on {
    border-color: var(--accent);
    color: var(--accent);
  }
  /* An upright rectangle with a knob, drawn with borders (no picture to load). */
  .glyph {
    display: inline-block;
    width: 0.55rem;
    height: 0.85rem;
    border: 1.5px solid currentColor;
    border-radius: 2px;
    position: relative;
  }
  .glyph::after {
    content: '';
    position: absolute;
    right: 1px;
    bottom: 1px;
    width: 0.2rem;
    height: 0.2rem;
    background: currentColor;
    border-radius: 1px;
  }
</style>
