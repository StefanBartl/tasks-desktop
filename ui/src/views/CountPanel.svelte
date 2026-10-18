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

  let {
    app,
    key,
    label,
    tasks,
    total,
    unfiltered,
  }: { app: App; key: CountKey; label: string; tasks: TaskEntry[]; total: number; unfiltered: number } = $props();
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
</style>
