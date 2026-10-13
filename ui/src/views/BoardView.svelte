<script lang="ts">
  // The board: a column for each status, the cards in the order of the engine. A card is moved by dragging it (to
  // another column: the status; among the cards of its group: the order) or with the keys of the page. The page
  // never sorts: the order is the engine's, and a move asks the engine for the new one.
  import type { App } from '../lib/app.svelte';
  import { COLUMNS, COLUMN_FIRST, groupLabel, placeOf, type Column } from '../lib/board';
  import { labelOf, translate, type Key } from '../lib/i18n';
  import { markHidden } from '../lib/text';
  import Detail from './Detail.svelte';

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
    over = null;
    overColumn = null;
  }
  function onCardOver(event: DragEvent, id: string, column: Column): void {
    if (dragging === null) return;
    event.preventDefault();
    event.stopPropagation();
    overColumn = column;
    const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
    over = id === dragging ? null : { id, place: placeOf(event.clientY, rect.top, rect.height) };
  }
  function onColumnOver(event: DragEvent, column: Column): void {
    if (dragging === null) return;
    event.preventDefault();
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
  async function onColumnDrop(event: DragEvent, column: Column): Promise<void> {
    event.preventDefault();
    const from = dragging;
    onDragEnd();
    if (from !== null) await app.dropOnColumn(from, column);
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

  function priorityOf(group: string | undefined): string | null {
    const label = groupLabel(group);
    return label === null ? null : t('board.group', { p: label });
  }
</script>

<div class="wrap">
  <p class="count" role="status">
    {t('list.count', { shown: app.shown.length, total: app.tasks.length })}
    <span class="help">{t('board.help')}</span>
  </p>
  <div class="layout">
    <div class="board" aria-label={t('nav.board')}>
      {#each COLUMNS as column (column)}
        <section
          class="column"
          class:target={overColumn === column && dragging !== null}
          aria-label={labelOf(app.lang, 'status', column)}
          ondragover={(e) => onColumnOver(e, column)}
          ondrop={(e) => void onColumnDrop(e, column)}
        >
          <h2>
            {labelOf(app.lang, 'status', column)}
            <span class="n">{board[column].length}</span>
          </h2>
          <div class="cards">
            {#each visible(column) as card, i (card.file)}
              {@const cards = visible(column)}
              {#if i === 0 || cards[i - 1]?.group !== card.group}
                {@const label = priorityOf(card.group)}
                {#if label}<p class="group">{label}</p>{/if}
              {/if}
              <button
                type="button"
                class="card"
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
                  <span class="id">{card.id}</span>
                  {#if !card.valid}<span class="tag bad">!</span>{/if}
                  <span class="tag soft">{card.prio !== undefined ? `P${card.prio}` : '?'}</span>
                  {#if card.effort}<span class="tag soft">{card.effort}</span>{/if}
                  {#if card.actor}<span class="tag soft">{labelOf(app.lang, 'actor', card.actor)}</span>{/if}
                  {#if card.steps && card.steps.total > 0}
                    <span class="tag soft">{card.steps.ticked}/{card.steps.total}</span>
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
  .board {
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
