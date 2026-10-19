<script lang="ts">
  // The tasks behind one number of the overview, in the view that was chosen for it. The number may be large (hundreds
  // of blocked tasks): the views cut it up (by priority, area, plan, blocker) and each group shows a page at a time.
  // Keys: `v` walks the views, Escape closes and gives the focus back to the number.
  import { tick } from 'svelte';
  import type { App } from '../lib/app.svelte';
  import { PAGE, countKey, groupTasks, viewsOf, type CountKey } from '../lib/counts';
  import type { TaskEntry } from '../lib/contract';
  import { areaLabel } from '../lib/filter';
  import { translate, type Key } from '../lib/i18n';
  import CountGroup from './CountGroup.svelte';
  import { areaAt, type PointerDragEvent } from '../lib/pointerDrag';

  let {
    app,
    key,
    label,
    tasks,
    total,
    unfiltered,
  }: { app: App; key: CountKey; label: string; tasks: TaskEntry[]; total: number; unfiltered: number } = $props();
  // The task that is dragged, while one is: the areas then show as places to drop it.
  let dragging = $state<string | null>(null);
  // The area a finger is over while it drags, to light its place.
  let overArea = $state<string | null>(null);
  let from = { x: 0, y: 0 };
  /** How far a finger must go (px) before the places to drop on take it. */
  const GRAB = 24;
  function pointerDrag(e: PointerDragEvent): void {
    if (e.phase === 'start') {
      dragging = e.id;
      overArea = null;
      from = { x: e.x, y: e.y };
      return;
    }
    if (dragging !== e.id) return;
    if (e.phase === 'move') {
      // The places count only once the finger has gone a stretch from where it went down: the areas push the rows
      // down when the drag begins, and a place may then lie under a finger that has not moved at all.
      const far = Math.hypot(e.x - from.x, e.y - from.y) >= GRAB;
      overArea = far ? areaAt(document, e.x, e.y) : null;
      return;
    }
    // The finger goes up (or the system takes the touch away). It drops on the place it MOVED onto: the areas appear
    // when the drag begins and push the rows down, so a finger that has not moved may be over a place only because the
    // page moved under it, and that is no drop.
    const area = e.phase === 'end' ? overArea : null;
    dragging = null;
    overArea = null;
    if (area !== null) void app.askDropMove(e.id, area);
  }
  const movable = $derived(app.can('move_area'));
  const dragged = $derived(dragging === null ? undefined : app.tasks.find((x) => x.id === dragging));
  // Why fewer are shown than the engine counts: the filter hides `hidden`, the areas that are not released the rest.
  const hidden = $derived(unfiltered - tasks.length);
  const ofKey = $derived(countKey(hidden, unfiltered, total));

  const t = (k: Key, params: Record<string, string | number> = {}) =>
    translate(app.lang, k, params);

  const view = $derived(app.countView(key));
  const groups = $derived(groupTasks(view, tasks));
  // A few groups, or few tasks: open them all; many tasks in many groups: only the first one.
  const openAll = $derived(groups.length <= 3 || tasks.length <= PAGE);
  const listable = $derived(key === 'doing' || key === 'blocked');
  const titleOf = $derived(new Map(app.tasks.map((x) => [x.id, x.title] as const)));
  const names = $derived(app.allAreaNames);

  function heading(group: { key: string }): string {
    const name = group.key;
    switch (view) {
      case 'area':
        return app.shortAreas ? areaLabel(name, names) : name;
      case 'plan':
        return name === '' ? t('count.none_plan') : name;
      case 'prio':
        return name === '' ? t('count.no_prio') : `P${name}`;
      case 'blocker':
        return name === '' ? t('count.no_blocker') : `${name}${titleOf.has(name) ? ` · ${titleOf.get(name)}` : ''}`;
      default:
        return name;
    }
  }

  function onKey(event: KeyboardEvent): void {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      // The number is found while the panel is still there (its props are gone after it), and takes the focus
      // when the panel is: the box that had it is removed, and that would drop the focus on the body.
      const number = document.querySelector<HTMLElement>(`[data-count="${key}"]`);
      app.closeCount();
      void tick().then(() => number?.focus());
    } else if (event.key === 'v' && !event.ctrlKey && !event.metaKey && !event.altKey) {
      const target = event.target;
      if (target instanceof HTMLInputElement && target.type !== 'radio') return;
      event.preventDefault();
      event.stopPropagation();
      app.cycleCountView(key);
    }
  }
</script>

<!-- The keys come from the buttons and boxes inside (they bubble up to here); the section itself takes no input. -->
<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
<section id="count-panel" class="card" aria-label={label} onkeydown={onKey}>
  <header>
    <h2 class="eyebrow">{label} · {tasks.length}</h2>
    <div class="views" role="radiogroup" aria-label={t('count.views')}>
      {#each viewsOf(key) as v (v)}
        <label class:on={v === view}>
          <input
            type="radio"
            name={`count-view-${key}`}
            value={v}
            checked={v === view}
            onchange={() => app.setCountView(key, v)}
          />
          {t(`count.view.${v}` as Key)}
        </label>
      {/each}
    </div>
    {#if listable}
      <button type="button" onclick={() => app.openCountInList(key)}>{t('count.in_list')}</button>
    {/if}
    <button type="button" class="close" aria-label={t('count.close')} title={t('count.close')} onclick={() => app.closeCount()}
      >×</button
    >
  </header>
  {#if movable && tasks.length > 0}
    <p class="muted hint">{t('drop.drag_hint')}</p>
  {/if}
  {#if dragged}
    <div class="targets" role="group" aria-label={t('drop.targets')}>
      {#each names.filter((a) => a !== dragged.area) as area (area)}
        <!-- A place to drop on, for the pointer only: the keys have the move in the details of the task. -->
        <span
          class="target"
          class:over={overArea === area}
          role="presentation"
          data-area={area}
          ondragover={(e) => e.preventDefault()}
          ondrop={(e) => {
            e.preventDefault();
            const id = dragging;
            dragging = null;
            if (id !== null) void app.askDropMove(id, area);
          }}>{app.shortAreas ? areaLabel(area, names) : area}</span
        >
      {/each}
    </div>
  {/if}
  {#if tasks.length !== total}
    <p class="muted" role="status">{t(ofKey, { f: hidden,  n: tasks.length, m: total })}</p>
  {/if}
  {#if tasks.length === 0}
    <p class="muted">{t('count.empty')}</p>
  {:else}
    {#each groups as group, i (`${view}:${group.key}`)}
      <CountGroup
        {app}
        heading={view === 'list' ? null : heading(group)}
        tasks={group.tasks}
        open={openAll || i === 0}
        ondragtask={movable ? (id) => (dragging = id) : undefined}
        onpointerdrag={movable ? pointerDrag : undefined}
      />
    {/each}
  {/if}
</section>

<style>
  header {
    display: flex;
    flex-wrap: wrap;
    gap: 0.6rem;
    align-items: center;
    margin-bottom: 0.5rem;
  }
  h2 {
    margin: 0;
    flex: 1 1 auto;
  }
  .views {
    display: flex;
    flex-wrap: wrap;
    gap: 0.25rem;
  }
  .views label {
    display: inline-flex;
    gap: 0.3rem;
    align-items: center;
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 0.15rem 0.5rem;
    background: var(--surface-2);
    cursor: pointer;
  }
  .views label.on {
    border-color: var(--accent);
  }
  header button {
    background: var(--surface-2);
    color: var(--text);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 0.2rem 0.6rem;
    cursor: pointer;
  }
  .muted {
    color: var(--muted);
  }
  .hint {
    margin: 0 0 0.4rem;
    font-size: 0.9em;
  }
  .targets {
    display: flex;
    flex-wrap: wrap;
    gap: 0.35rem;
    max-height: 9rem;
    overflow-y: auto;
    margin: 0 0 0.6rem;
    padding: 0.4rem;
    border: 1px dashed var(--accent);
    border-radius: var(--radius);
    background: var(--surface-2);
  }
  .target {
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 0.2rem 0.6rem;
    background: var(--surface);
  }
  .target:hover,
  .target.over {
    border-color: var(--accent);
  }
  .target.over {
    background: var(--surface-2);
  }
</style>
