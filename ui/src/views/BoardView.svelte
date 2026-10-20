<script lang="ts">
  // The board: a column for each status, the cards in the order of the engine. A card is moved by dragging it (to
  // another column: the status; among the cards of its group: the order) or with the keys of the page. The page
  // never sorts: the order is the engine's, and a move asks the engine for the new one.
  import type { App } from '../lib/app.svelte';
  import { COLUMNS, COLUMN_FIRST, groupLabel, placeOf, runKey, stageOf, type Column } from '../lib/board';
  import { boardTargetAt, createGrip, type BoardTarget, type PointerDragEvent } from '../lib/pointerDrag';
  import { hintOf, labelOf, translate, type Key } from '../lib/i18n';
  import Info from 'appkit-ui/Info.svelte';
  import { marksLegend } from '../lib/legend';
  import { markHidden } from '../lib/text';
  import Detail from './Detail.svelte';
  import FilterNote from './FilterNote.svelte';

  let { app }: { app: App } = $props();
  const t = (key: Key, params: Record<string, string | number> = {}) =>
    translate(app.lang, key, params);

  const board = $derived(app.board);

  // How many cards each column draws: a long column shows its first cards and "show more".
  let limits = $state<Record<string, number>>({});
  const limitOf = (column: Column): number => limits[column] ?? COLUMN_FIRST;
  function showMore(column: Column): void {
    limits = { ...limits, [column]: limitOf(column) + COLUMN_FIRST };
  }
  // The selected card is always drawn, also past the first cards.
  function visible(column: Column) {
    const cards = board[column];
    const upTo = limitOf(column);
    return cards.filter((c, i) => i < upTo || c.id === app.selectedId);
  }

  // The card under the pointer and the half of it, while a card is dragged.
  let dragging = $state<string | null>(null);
  let over = $state<{ id: string; place: 'before' | 'after' } | null>(null);
  let overColumn = $state<Column | null>(null);

  const MIME = 'application/x-tasks-card';

  function onDragStart(event: DragEvent, id: string): void {
    if (app.saving) {
      event.preventDefault();
      return;
    }
    dragging = id;
    event.dataTransfer?.setData(MIME, id);
    event.dataTransfer?.setData('text/plain', id);
    if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move';
  }
  function onDragEnd(): void {
    dragging = null;
    overDone = false;
    over = null;
    overColumn = null;
  }
  function onCardOver(event: DragEvent, id: string, column: Column): void {
    if (dragging === null) return;
    event.preventDefault();
    event.stopPropagation();
    overDone = false;
    overColumn = column;
    const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
    // Over a card of another column the drop sets the status: no insertion bar there.
    const sameColumn = app.tasks.find((x) => x.id === dragging)?.status === column;
    over = id === dragging || !sameColumn ? null : { id, place: placeOf(event.clientY, rect.top, rect.height) };
  }
  function onColumnOver(event: DragEvent, column: Column): void {
    if (dragging === null) return;
    event.preventDefault();
    overDone = false;
    overColumn = column;
    over = null;
  }
  async function onCardDrop(event: DragEvent, id: string, column: Column): Promise<void> {
    event.preventDefault();
    event.stopPropagation();
    const from = dragging;
    const place = over?.id === id ? over.place : 'after';
    onDragEnd();
    if (from === null) return;
    const task = app.tasks.find((x) => x.id === from);
    // Dropped in another column: the status changes (the order inside the column is the engine's).
    if (task && task.status !== column) await app.dropOnColumn(from, column);
    else await app.dropNear(from, { id, place });
  }
  let overDone = $state(false);
  function onDoneOver(event: DragEvent): void {
    if (dragging === null) return;
    event.preventDefault();
    event.stopPropagation();
    overDone = true;
    overColumn = null;
    over = null;
  }
  async function onDoneDrop(event: DragEvent): Promise<void> {
    event.preventDefault();
    const from = dragging;
    onDragEnd();
    if (from !== null) await app.dropOnDone(from);
  }
  async function onColumnDrop(event: DragEvent, column: Column): Promise<void> {
    event.preventDefault();
    const from = dragging;
    onDragEnd();
    if (from !== null) await app.dropOnColumn(from, column);
  }

  // A finger or a pen drags a card by its grip (HTML5 drag does not start on a touch screen). The places count only
  // once the finger has gone a stretch from where it went down, and the drop goes to the place it moved onto.
  const GRAB = 24;
  let from = { x: 0, y: 0 };
  let fingerAt: BoardTarget | null = null;
  const grip = createGrip(
    () => onPointerDrag,
    () => app.saving,
  );
  function onPointerDrag(e: PointerDragEvent): void {
    if (e.phase === 'start') {
      dragging = e.id;
      from = { x: e.x, y: e.y };
      fingerAt = null;
      return;
    }
    if (dragging !== e.id) return;
    if (e.phase === 'move') {
      const far = Math.hypot(e.x - from.x, e.y - from.y) >= GRAB;
      fingerAt = far ? boardTargetAt(document, e.x, e.y) : null;
      overDone = fingerAt?.kind === 'done';
      overColumn = fingerAt && fingerAt.kind !== 'done' ? (fingerAt.column as Column) : null;
      const sameColumn = app.tasks.find((x) => x.id === dragging)?.status === overColumn;
      over =
        fingerAt?.kind === 'card' && fingerAt.id !== dragging && sameColumn
          ? { id: fingerAt.id, place: placeOf(e.y, fingerAt.top, fingerAt.height) }
          : null;
      return;
    }
    const target = e.phase === 'end' ? fingerAt : null;
    const place = over?.place ?? 'after';
    const id = e.id;
    onDragEnd();
    fingerAt = null;
    if (target === null) return;
    if (target.kind === 'done') void app.dropOnDone(id);
    else if (target.kind === 'column') void app.dropOnColumn(id, target.column as Column);
    else if (target.id === id) return;
    else if (app.tasks.find((x) => x.id === id)?.status !== target.column) void app.dropOnColumn(id, target.column as Column);
    else void app.dropNear(id, { id: target.id, place });
  }

  // The selected card stays in view when the keys move it.
  $effect(() => {
    if (app.selectedId === null) return;
    void board;
    const frame = requestAnimationFrame(() => {
      document.querySelector('.board [aria-current="true"]')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    });
    return () => cancelAnimationFrame(frame);
  });

  function runLabel(card: (typeof board)[Column][number]): string | null {
    const label = groupLabel(card, app.can('eff_prio'));
    if (label === null) return null;
    const stage = stageOf(card);
    return stage === null ? t('board.group', { p: label }) : `${t('board.group', { p: label })} · ${t('board.stage', { n: stage })}`;
  }

  // The pointer left the board: no bar and no highlight stay behind.
  function onBoardLeave(event: DragEvent): void {
    const to = event.relatedTarget;
    if (!(to instanceof Node) || !(event.currentTarget as HTMLElement).contains(to)) {
      overDone = false;
      over = null;
      overColumn = null;
    }
  }
</script>

<div class="wrap">
  <FilterNote {app} />
  <p class="count">
    <span role="status">{t('list.count', { shown: app.shown.length, total: app.tasks.length })}</span>
    <span class="help">{t('board.help')}</span>
    <Info hint={t('hint.board')} label={t('hint.about', { what: t('nav.board') })} />
    <Info hint={marksLegend(app.lang)} label={t('hint.about', { what: t('mark.legend.what') })} />
  </p>
  <div class="layout">
    <div class="main" ondragleave={onBoardLeave} role="presentation">
      <div
        class="donezone"
        data-donezone
        class:target={overDone && dragging !== null}
        role="group"
        aria-label={t('board.done')}
        data-hint={t('hint.board.done')}
        ondragover={onDoneOver}
        ondrop={(e) => void onDoneDrop(e)}
      >
        {t('board.done')}
      </div>
    <!-- A board that scrolls and holds no card (a filter hid them all) has nothing to focus: it takes the focus itself. -->
    <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
    <div class="board" role="group" aria-label={t('nav.board')} tabindex={COLUMNS.every((c) => visible(c).length === 0) ? 0 : undefined}>
      {#each COLUMNS as column (column)}
        <section
          class="column"
          data-column={column}
          class:target={overColumn === column && dragging !== null}
          aria-label={labelOf(app.lang, 'status', column)}
          ondragover={(e) => onColumnOver(e, column)}
          ondrop={(e) => void onColumnDrop(e, column)}
        >
          <h2>
            <span data-hint={hintOf(app.lang, 'hint.status', column)}>{labelOf(app.lang, 'status', column)}</span>
            <span class="n" data-hint={t('hint.board.count')}>{board[column].length}</span>
          </h2>
          <div class="cards">
            {#each visible(column) as card, i (card.file)}
              {@const cards = visible(column)}
              {#if i === 0 || (cards[i - 1] && runKey(cards[i - 1] as typeof card) !== runKey(card))}
                {@const label = runLabel(card)}
                {#if label}<p class="group" data-hint={t('hint.board.group')}>{label}</p>{/if}
              {/if}
              <button
                type="button"
                class="card"
                data-card={card.id}
                data-card-column={column}
                class:selected={card.id === app.selectedId}
                class:dragging={dragging === card.id}
                class:before={over?.id === card.id && over.place === 'before'}
                class:after={over?.id === card.id && over.place === 'after'}
                aria-current={card.id === app.selectedId ? 'true' : undefined}
                draggable={!app.saving}
                ondragstart={(e) => onDragStart(e, card.id)}
                ondragend={onDragEnd}
                ondragover={(e) => onCardOver(e, card.id, column)}
                ondrop={(e) => void onCardDrop(e, card.id, column)}
                onclick={() => app.select(card.id)}
              >
                <span class="title">{markHidden(card.title)}</span>
                <span class="meta">
                  <!-- A finger drags by this grip (a screen reader and the keys have the keys of the board). -->
                  <span
                    class="grip"
                    data-hint={t('hint.ui.board.grip')}
                    role="presentation"
                    aria-hidden="true"
                    onpointerdown={(e) => grip(e, card.id, 'start')}
                    onpointermove={(e) => grip(e, card.id, 'move')}
                    onpointerup={(e) => grip(e, card.id, 'end')}
                    onpointercancel={(e) => grip(e, card.id, 'cancel')}>⠿</span
                  >
                  <span class="id">{card.id}</span>
                  {#if !card.valid}<span class="tag bad" data-hint={t('hint.invalid')}><span aria-hidden="true">!</span><span class="sr-only">{t('mark.invalid')}</span></span>{/if}
                  {#if app.crossAreas(card.id).length >= 2}
                    <span class="tag soft" data-hint={t('cross.mark', { n: app.crossAreas(card.id).length, areas: app.crossAreas(card.id).join(', ') })}><span aria-hidden="true">↔ {app.crossAreas(card.id).length}</span><span class="sr-only">{t('mark.cross', { n: app.crossAreas(card.id).length })}</span></span>
                  {/if}
                  <span class="tag soft" data-hint={hintOf(app.lang, 'hint', 'prio')}>{#if card.prio !== undefined}P{card.prio}{:else}<span aria-hidden="true">?</span><span class="sr-only">{t('mark.no_prio')}</span>{/if}</span>
                  {#if card.effort}<span class="tag soft" data-hint={hintOf(app.lang, 'hint', 'effort')}>{card.effort}</span>{/if}
                  {#if card.actor}<span class="tag soft" data-hint={hintOf(app.lang, 'hint.field', 'actor')}>{labelOf(app.lang, 'actor', card.actor)}</span>{/if}
                  {#if card.steps && card.steps.total > 0}
                    <span class="tag soft" data-hint={hintOf(app.lang, 'hint', 'steps')}>{card.steps.ticked}/{card.steps.total}</span>
                  {/if}
                </span>
              </button>
            {:else}
              <p class="empty">{t('board.empty')}</p>
            {/each}
            {#if board[column].length > visible(column).length}
              <button type="button" class="more" onclick={() => showMore(column)}>
                {t('board.more', { n: board[column].length - visible(column).length })}
              </button>
            {/if}
          </div>
        </section>
      {/each}
    </div>
    </div>
    <Detail {app} />
  </div>
</div>

<style>
  .wrap {
    display: flex;
    flex-direction: column;
    height: 100%;
    min-height: 0;
  }
  .count {
    margin: 0 0 0.4rem;
    color: var(--muted);
    font-size: 0.8rem;
    display: flex;
    justify-content: space-between;
    gap: 1rem;
  }
  .layout {
    display: grid;
    grid-template-columns: minmax(0, 1fr) minmax(16rem, 22rem);
    gap: 1rem;
    flex: 1;
    min-height: 0;
  }
  @media (max-width: 52rem) {
    .layout {
      grid-template-columns: 1fr;
    }
  }
  .main {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    min-width: 0;
    min-height: 0;
  }
  .donezone {
    border: 1px dashed var(--border);
    border-radius: var(--radius);
    color: var(--muted);
    font-size: 0.8rem;
    text-align: center;
    padding: 0.5rem;
  }
  .donezone.target {
    border-color: var(--accent);
    color: var(--text);
  }
  .board {
    flex: 1;
    display: grid;
    grid-auto-flow: column;
    grid-auto-columns: minmax(14rem, 1fr);
    gap: 0.6rem;
    overflow: auto;
    min-height: 0;
  }
  .column {
    display: flex;
    flex-direction: column;
    min-height: 0;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius);
  }
  .column.target {
    border-color: var(--accent);
    box-shadow: inset 0 0 0 1px var(--accent);
  }
  h2 {
    margin: 0;
    padding: 0.4rem 0.6rem;
    font-size: 0.9rem;
    border-bottom: 1px solid var(--border);
    display: flex;
    justify-content: space-between;
  }
  .n {
    color: var(--muted);
    font-weight: normal;
  }
  .cards {
    overflow: auto;
    padding: 0.4rem;
    display: flex;
    flex-direction: column;
    gap: 0.35rem;
    flex: 1;
    min-height: 3rem;
  }
  .group {
    margin: 0.3rem 0 0;
    font-size: 0.7rem;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--muted);
  }
  .card {
    display: grid;
    gap: 0.25rem;
    text-align: left;
    background: var(--surface-2);
    color: var(--text);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 0.4rem 0.5rem;
    cursor: grab;
  }
  .card.selected {
    box-shadow: inset 3px 0 0 var(--accent);
  }
  .grip {
    display: inline-block;
    min-width: 1.6rem;
    text-align: center;
    cursor: grab;
    color: var(--muted);
    touch-action: none;
    user-select: none;
  }
  .card.dragging {
    opacity: 0.45;
  }
  .card.before {
    box-shadow: 0 -3px 0 var(--accent);
  }
  .card.after {
    box-shadow: 0 3px 0 var(--accent);
  }
  .title {
    overflow-wrap: anywhere;
  }
  .meta {
    display: flex;
    flex-wrap: wrap;
    gap: 0.3rem;
    align-items: center;
    font-size: 0.75rem;
  }
  .id {
    font-family: var(--mono);
    color: var(--muted);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    max-width: 100%;
  }
  .tag {
    padding: 0 0.4rem;
    border-radius: 999px;
    border: 1px solid var(--border);
  }
  .soft {
    color: var(--muted);
  }
  .bad {
    color: var(--bad);
    border-color: var(--bad);
  }
  .empty {
    margin: 0;
    color: var(--muted);
    font-size: 0.85rem;
  }
  .more {
    background: none;
    border: 1px dashed var(--border);
    border-radius: var(--radius);
    color: var(--accent);
    padding: 0.3rem;
    cursor: pointer;
  }
</style>
