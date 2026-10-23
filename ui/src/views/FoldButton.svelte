<script lang="ts">
  // The button that folds one block of a view (or all of them) one step on: open, folded (its head only), narrow (its
  // head on its side), open again.
  import { nextFold, type Fold } from '../lib/fold';
  import { translate, type Key, type Lang } from '../lib/i18n';

  let {
    lang,
    fold,
    what,
    onfold,
  }: {
    lang: Lang;
    /** Where the block (or, for the button of all, the step they go to next) stands now. */
    fold: Fold;
    /** The name of what is folded, for the label ("Stage 3", "all stages"). */
    what: string;
    onfold: (next: Fold) => void;
  } = $props();

  const t = (key: Key, params: Record<string, string | number> = {}) => translate(lang, key, params);
  const next = $derived(nextFold(fold));
  const SIGN: Record<Fold, string> = { open: '▾', folded: '▸', narrow: '⇹' };
</script>

<button
  type="button"
  class="fold"
  aria-label={t(`fold.to.${next}` as Key, { what })}
  aria-expanded={fold === 'open'}
  data-hint={t('hint.fold')}
  onclick={() => onfold(next)}
>
  <span aria-hidden="true">{SIGN[fold]}</span>
</button>

<style>
  .fold {
    flex: none;
    background: none;
    border: 1px solid transparent;
    border-radius: var(--radius);
    color: var(--muted);
    cursor: pointer;
    padding: 0 0.3rem;
    line-height: 1.4;
  }
  .fold:hover,
  .fold:focus-visible {
    border-color: var(--border);
    color: var(--text);
  }
</style>
