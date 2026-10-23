<script lang="ts">
  // The head of the list: the names of its columns and the edges that set their widths. An edge is dragged with the
  // mouse or moved with the arrow keys; a double click or Enter gives the column its default width back.
  import { COLUMN_LIMITS, COLUMN_STEP, draggedWidth, withWidth, type ColumnKey, type ListColumns } from '../lib/columns';
  import { translate, type Key, type Lang } from '../lib/i18n';

  let {
    lang,
    columns,
    onlive,
    oncommit,
  }: {
    lang: Lang;
    columns: ListColumns;
    /** The widths while an edge moves (shown, not yet remembered). */
    onlive: (columns: ListColumns) => void;
    /** The widths when an edge is let go (remembered). */
    oncommit: (columns: ListColumns) => void;
  } = $props();

  const t = (key: Key, params: Record<string, string | number> = {}) => translate(lang, key, params);

  let idCell: HTMLElement | undefined = $state();
  let metaCell: HTMLElement | undefined = $state();
  let drag: { key: ColumnKey; x: number; start: number } | null = null;

  const cellOf = (key: ColumnKey): HTMLElement | undefined => (key === 'id' ? idCell : metaCell);
  /** The width the column has now: the one it was given, else the one the default lays out. */
  const widthOf = (key: ColumnKey): number => columns[key] ?? cellOf(key)?.getBoundingClientRect().width ?? 0;

  function down(event: PointerEvent, key: ColumnKey): void {
    if (event.button !== 0) return;
    event.preventDefault();
    (event.currentTarget as HTMLElement).setPointerCapture?.(event.pointerId);
    drag = { key, x: event.clientX, start: widthOf(key) };
  }

  function move(event: PointerEvent): void {
    if (drag === null) return;
    onlive(withWidth(columns, drag.key, draggedWidth(drag.key, drag.start, event.clientX - drag.x)));
  }

  function up(): void {
    if (drag === null) return;
    drag = null;
    oncommit(columns);
  }

  function key(event: KeyboardEvent, key: ColumnKey): void {
    // The edge of the id sits on its right, the one of the marks on their left: the arrow moves the edge.
    const sign = key === 'id' ? 1 : -1;
    if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
      event.preventDefault();
      const dx = event.key === 'ArrowRight' ? COLUMN_STEP : -COLUMN_STEP;
      oncommit(withWidth(columns, key, widthOf(key) + sign * dx));
    } else if (event.key === 'Enter' || event.key === 'Delete') {
      event.preventDefault();
      oncommit(withWidth(columns, key, null));
    }
  }
</script>

<div class="head">
  <span class="mark-space" aria-hidden="true"></span>
  <div class="cols">
    <span class="cell" bind:this={idCell}>
      {t('list.col.id')}
      <!-- A focusable separator with a value is the ARIA window splitter; the lint does not count it as a widget. -->
      <!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions -->
      <span
        class="edge right"
        role="separator"
        tabindex="0"
        aria-orientation="vertical"
        aria-label={t('list.col.edge', { col: t('list.col.id') })}
        aria-valuemin={COLUMN_LIMITS.id.min}
        aria-valuemax={COLUMN_LIMITS.id.max}
        aria-valuenow={Math.round(widthOf('id'))}
        data-hint={t('hint.list.col_edge')}
        onpointerdown={(e) => down(e, 'id')}
        onpointermove={move}
        onpointerup={up}
        onpointercancel={up}
        ondblclick={() => oncommit(withWidth(columns, 'id', null))}
        onkeydown={(e) => key(e, 'id')}
      ></span>
    </span>
    <span class="cell">{t('list.col.title')}</span>
    <span class="cell meta" bind:this={metaCell}>
      <!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions -->
      <span
        class="edge left"
        role="separator"
        tabindex="0"
        aria-orientation="vertical"
        aria-label={t('list.col.edge', { col: t('list.col.meta') })}
        aria-valuemin={COLUMN_LIMITS.meta.min}
        aria-valuemax={COLUMN_LIMITS.meta.max}
        aria-valuenow={Math.round(widthOf('meta'))}
        data-hint={t('hint.list.col_edge')}
        onpointerdown={(e) => down(e, 'meta')}
        onpointermove={move}
        onpointerup={up}
        onpointercancel={up}
        ondblclick={() => oncommit(withWidth(columns, 'meta', null))}
        onkeydown={(e) => key(e, 'meta')}
      ></span>
      {t('list.col.meta')}
    </span>
  </div>
</div>

<style>
  .head {
    display: flex;
    align-items: center;
    border-bottom: 1px solid var(--border);
    font-size: 0.75rem;
    color: var(--muted);
    user-select: none;
  }
  /* As wide as the box that marks a row, so the names stand over their columns. */
  .mark-space {
    flex: none;
    width: calc(13px + 0.6rem);
  }
  .cols {
    flex: 1;
    min-width: 0;
    display: grid;
    grid-template-columns: var(--col-id, minmax(8rem, 14rem)) minmax(6rem, 1fr) var(--col-meta, auto);
    gap: 0.75rem;
    padding: 0.25rem 0.6rem;
  }
  .cell {
    position: relative;
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
  }
  .cell.meta {
    text-align: right;
    min-width: 3rem;
  }
  .edge {
    position: absolute;
    top: 0;
    bottom: 0;
    width: 0.5rem;
    cursor: col-resize;
    touch-action: none;
  }
  .edge.right {
    right: 0;
    border-right: 2px solid var(--border);
  }
  .edge.left {
    left: 0;
    border-left: 2px solid var(--border);
  }
  .edge:hover,
  .edge:focus-visible {
    border-color: var(--accent);
  }
</style>
