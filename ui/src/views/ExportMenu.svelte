<script lang="ts">
  // The button Export of a view that shows tasks: what the view draws (or the marked tasks), as a file or on the
  // clipboard. The same entries are in the View menu and the palette; this one is where the tasks are.
  import type { App } from '../lib/app.svelte';
  import type { ExportFormat } from '../lib/export';
  import { translate, type Key } from '../lib/i18n';

  let { app }: { app: App } = $props();

  const t = (key: Key, params: Record<string, string | number> = {}) => translate(app.lang, key, params);
  const FORMATS: readonly [ExportFormat, string][] = [
    ['csv', 'CSV'],
    ['json', 'JSON'],
    ['markdown', 'Markdown'],
  ];

  let open = $state(false);
  let details: HTMLDetailsElement | undefined = $state();
  let summary: HTMLElement | undefined = $state();
  let popup: HTMLDivElement | undefined = $state();
  /** Where the popup stands in the window: fixed, so that a block that scrolls (a sized list) does not cut it. */
  let place = $state<{ left: number; top: number } | null>(null);

  /** The space kept between the popup and the edge of the window, and between the popup and its button. */
  const EDGE = 8;
  const GAP = 4;

  /**
   * Put the popup under its button, its right edge at the button's, kept inside the window (a button at the left of a
   * narrow window); above the button when there is no room below and there is above.
   */
  function placePopup(): void {
    if (!open || !summary || !popup) return;
    const button = summary.getBoundingClientRect();
    const { offsetWidth: w, offsetHeight: h } = popup;
    const { clientWidth, clientHeight } = document.documentElement;
    const left = Math.max(EDGE, Math.min(button.right - w, clientWidth - EDGE - w));
    const below = button.bottom + GAP;
    const above = button.top - GAP - h;
    const top = below + h > clientHeight - EDGE && above >= EDGE ? above : below;
    place = { left, top };
  }

  // While it is open the popup follows its button: a scroll of the page or of a block, a change of the window's size.
  $effect(() => {
    if (!open) {
      place = null;
      return;
    }
    placePopup();
    window.addEventListener('scroll', placePopup, true);
    window.addEventListener('resize', placePopup);
    return () => {
      window.removeEventListener('scroll', placePopup, true);
      window.removeEventListener('resize', placePopup);
    };
  });

  /** Run one entry; the popup closes and the focus goes back to the button that opened it. */
  function run(format: ExportFormat, how: 'save' | 'copy'): void {
    open = false;
    summary?.focus();
    void app.exportView(format, how);
  }

  /**
   * Escape closes the popup and gives the focus back to its button. The key is marked as taken (the page does not
   * also take the selection away), but goes on: the kit's hint, on the document, closes on it too.
   */
  function closeOnEscape(e: KeyboardEvent): void {
    if (e.key !== 'Escape' || !open) return;
    e.preventDefault();
    open = false;
    summary?.focus();
  }

  /** A press or a focus elsewhere closes the popup: it would cover the rows below it. */
  function closeOutside(e: Event): void {
    if (open && details && e.target instanceof Node && !details.contains(e.target)) open = false;
  }
</script>

<svelte:document onpointerdown={closeOutside} onfocusin={closeOutside} />

<details class="export" bind:open bind:this={details}>
  <summary bind:this={summary} aria-label={t('export.label')} data-hint={t('export.hint')} onkeydown={closeOnEscape}>
    <span aria-hidden="true">⤓</span> {t('export.button')}
  </summary>
  <div
    class="popup"
    role="group"
    aria-label={t('export.choices')}
    bind:this={popup}
    class:placed={place !== null}
    style:left={place ? `${place.left}px` : undefined}
    style:top={place ? `${place.top}px` : undefined}
  >
    {#each FORMATS as [format, name] (format)}
      <button type="button" disabled={app.phase !== 'ready'} onkeydown={closeOnEscape} onclick={() => run(format, 'save')}
        >{t('export.save', { format: name })}</button
      >
    {/each}
    {#each FORMATS as [format, name] (format)}
      <button type="button" disabled={app.phase !== 'ready'} onkeydown={closeOnEscape} onclick={() => run(format, 'copy')}
        >{t('export.copy', { format: name })}</button
      >
    {/each}
  </div>
</details>

<style>
  .export {
    position: relative;
    flex: none;
    font-size: 0.85rem;
  }
  summary {
    cursor: pointer;
    list-style: none;
    display: inline-flex;
    align-items: center;
    gap: 0.3rem;
    min-height: 1.6rem;
    padding: 0.15rem 0.5rem;
    border: 1px solid var(--border);
    border-radius: var(--radius);
    color: var(--text);
    background: var(--surface-2);
  }
  summary::-webkit-details-marker {
    display: none;
  }
  /* Measured once open (see `placePopup`); until then it is not seen, so it does not flash at the window's corner. */
  .popup {
    position: fixed;
    left: 0;
    top: 0;
    visibility: hidden;
    z-index: 20;
    display: flex;
    flex-direction: column;
    min-width: 12rem;
    padding: 0.25rem;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    box-shadow: var(--shadow);
  }
  .popup.placed {
    visibility: visible;
  }
  .popup button {
    text-align: left;
    background: none;
    border: none;
    border-radius: var(--radius);
    color: var(--text);
    padding: 0.3rem 0.5rem;
    cursor: pointer;
  }
  .popup button:hover,
  .popup button:focus-visible {
    background: var(--surface-2);
  }
</style>
