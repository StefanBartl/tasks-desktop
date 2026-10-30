<script lang="ts">
  // The graph of one task, as a list: what it needs before it can start, or what waits for it. The list is the
  // plain form (Tab and the arrow keys, a screen reader reads it as a list, the steps from the task are the indent);
  // the engine walks the graph, this only shows it.
  import { untrack } from 'svelte';
  import type { App } from '../lib/app.svelte';
  import { translate, type Key } from '../lib/i18n';
  import { markHidden } from '../lib/text';
  import { statusTags } from '../lib/statusTags';
  import { graphLegend } from '../lib/legend';
  import Info from 'appkit-ui/Info.svelte';

  let { app }: { app: App } = $props();
  const t = (key: Key, params: Record<string, string | number> = {}) => translate(app.lang, key, params);

  const graph = $derived(app.graph);
  const doc = $derived(app.graphDoc);

  // Asked again when the vault changed under the graph. The app knows the rev the graph was asked for (also after
  // the view was left and the panel is drawn again), and the call is not tracked: it reads the graph state, and an
  // effect that listened to that would ask again after every answer, for ever.
  $effect(() => {
    void app.snapshot?.rev;
    untrack(() => app.reloadGraph());
  });

  // The panel takes the focus when it opens (the button that opened it is gone from the page), and gives it back to
  // the stages when it closes.
  let heading: HTMLElement | undefined = $state();
  let hadGraph = false;
  $effect(() => {
    // The heading exists only once the panel is drawn: the effect runs again when it is there. The focus is taken
    // once, when the graph was opened.
    if (graph && heading && app.graphWantsFocus) {
      app.graphWantsFocus = false;
      const target = heading;
      // After the frame: a dialog that opened it (the palette) gives the focus back to what it took it from when it
      // closes, and that must not be the last word.
      requestAnimationFrame(() => target.focus());
    }
    if (graph) hadGraph = true;
    else if (hadGraph) {
      document.querySelector<HTMLElement>('section.stages')?.focus();
      hadGraph = false;
    }
  });

  function onPanelKey(event: KeyboardEvent): void {
    if (event.key === 'Escape') {
      event.stopPropagation();
      app.closeGraph();
    }
  }

  // The ids a node waits for, as the engine's edges say (`from` is finished first, `to` waits).
  const waitsFor = $derived.by(() => {
    const out = new Map<string, string[]>();
    for (const edge of doc?.edges ?? []) {
      const list = out.get(edge.to);
      if (list) list.push(edge.from);
      else out.set(edge.to, [edge.from]);
    }
    return out;
  });

  // Nodes are drawn in steps, like the plan: a graph of five hundred is not one block of work.
  const FIRST = 100;
  const STEP = 200;
  let grown = $state({ key: '', n: FIRST });
  const key = $derived(`${graph?.id ?? ''}|${graph?.direction ?? ''}`);
  const limit = $derived(grown.key === key ? grown.n : FIRST);
  const nodes = $derived(doc?.nodes ?? []);
  const drawn = $derived(nodes.slice(0, limit));
  $effect(() => {
    if (limit >= nodes.length) return;
    const k = key;
    const frame = requestAnimationFrame(() => {
      grown = { key: k, n: Math.min(nodes.length, limit + STEP) };
    });
    return () => cancelAnimationFrame(frame);
  });

  function onKey(event: KeyboardEvent): void {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    const buttons = [...(event.currentTarget as HTMLElement).querySelectorAll<HTMLButtonElement>('button.node')];
    const at = buttons.indexOf(document.activeElement as HTMLButtonElement);
    if (at === -1) return;
    const next = buttons[at + (event.key === 'ArrowDown' ? 1 : -1)];
    if (next) {
      event.preventDefault();
      next.focus();
    }
  }
</script>

{#if graph}
  <!-- Escape closes the panel from any control inside it; the section itself takes no input. -->
  <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
  <section class="graph card" onkeydown={onPanelKey} aria-label={t(graph.direction === 'needs' ? 'graph.title.needs' : 'graph.title.unlocks', { id: graph.id })}>
    <header>
      <div class="title-row">
        <h2 bind:this={heading} tabindex="-1">{t(graph.direction === 'needs' ? 'graph.title.needs' : 'graph.title.unlocks', { id: graph.id })}</h2>
        <Info hint={graphLegend(app.lang)} label={t('hint.about', { what: t('graph.legend_what') })} />
      </div>
      <div class="dir" role="group" aria-label={t('graph.direction')}>
        <button type="button" data-hint={t('hint.graph.needs')} aria-pressed={graph.direction === 'needs'} onclick={() => app.openGraph(graph.id, 'needs')}>{t('graph.dir.needs')}</button>
        <button type="button" data-hint={t('hint.graph.unlocks')} aria-pressed={graph.direction === 'unlocks'} onclick={() => app.openGraph(graph.id, 'unlocks')}>{t('graph.dir.unlocks')}</button>
      </div>
      <!-- Closing is no direction: outside the group. -->
      <button type="button" onclick={() => app.closeGraph()}>{t('graph.close')}</button>
    </header>
    <div role="status" aria-live="polite">
      {#if app.graphProblem}
        <p class="problem">{app.graphProblem}</p>
      {:else if doc}
        <p class="count" data-hint={t('hint.graph.count')}>
          {t('graph.count', { n: doc.total })}{doc.truncated ? ` - ${t('graph.truncated', { n: doc.nodes.length })}` : ''}
        </p>
      {:else}
        <p class="count">{t('state.loading')}</p>
      {/if}
    </div>
    {#each doc?.cycles ?? [] as cycle, i (i)}
      <p class="cycle" data-hint={t('hint.graph.cycle')}>{t('graph.cycle', { ids: cycle.join(', ') })}</p>
    {/each}
    <!-- The keys come from the buttons inside the list (arrow keys move between them); the list itself takes no input. -->
    <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
    <ol class="nodes" onkeydown={onKey}>
      {#each drawn as node (node.id)}
        {@const tags = statusTags(app.lang, node.status, node.state ?? undefined)}
        <li style:padding-left={`${Math.min(node.distance, 8) * 1.25}rem`} aria-level={node.distance + 1}>
          <button type="button" class="node" class:target={node.distance === 0} onclick={() => app.peek(node.id)}>
            <span class="title">{markHidden(node.title)}</span>
            <span class="id">{node.id}</span>
          </button>
          <span class="meta">
            <span class="tag" data-hint={tags.status.hint}>{tags.status.label}</span>
            {#if tags.state}<span class="tag soft" data-hint={tags.state.hint}>{tags.state.label}</span>{/if}
            {#if node.on_critical_path}<span class="tag crit" data-hint={t('hint.critical')}>{t('plan.on_path')}</span>{/if}
          </span>
          {#if waitsFor.get(node.id)}
            <span class="waits" data-hint={t('hint.graph.waits')}>{t('graph.waits', { ids: (waitsFor.get(node.id) ?? []).join(', ') })}</span>
          {/if}
        </li>
      {/each}
    </ol>
  </section>
{/if}

<style>
  .card {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 0.9rem 1rem;
  }
  header {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
    align-items: baseline;
    justify-content: space-between;
  }
  .title-row {
    display: flex;
    align-items: center;
    gap: 0.4rem;
  }
  h2 {
    margin: 0;
    font-size: 1rem;
  }
  .dir {
    display: flex;
    gap: 0.4rem;
  }
  .dir button {
    background: var(--surface-2);
    color: var(--text);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 0.2rem 0.6rem;
    cursor: pointer;
  }
  .dir button[aria-pressed='true'] {
    border-color: var(--accent);
  }
  .count,
  .cycle,
  .waits {
    color: var(--muted);
    font-size: 0.85rem;
    margin: 0.3rem 0;
  }
  .cycle,
  .problem {
    color: var(--warn);
  }
  .nodes {
    list-style: none;
    margin: 0;
    padding: 0;
  }
  li {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
    align-items: baseline;
    padding-top: 0.25rem;
    padding-bottom: 0.25rem;
    border-bottom: 1px solid var(--border);
  }
  .node {
    background: none;
    border: 0;
    padding: 0;
    text-align: left;
    color: inherit;
    cursor: pointer;
    display: flex;
    flex-direction: column;
  }
  .node.target .title {
    font-weight: 600;
  }
  .id {
    font-family: var(--mono);
    font-size: 0.75rem;
    color: var(--muted);
  }
  .meta {
    display: flex;
    gap: 0.3rem;
  }
  .tag {
    font-size: 0.75rem;
    padding: 0 0.4rem;
    border-radius: 999px;
    border: 1px solid var(--border);
  }
  .tag.soft {
    color: var(--muted);
  }
  .tag.crit {
    color: var(--accent);
    border-color: var(--accent);
  }
</style>
