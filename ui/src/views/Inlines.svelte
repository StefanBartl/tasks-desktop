<script lang="ts">
  import type { Inline } from '../lib/markdown';
  import { markHidden } from '../lib/text';
  import Inlines from './Inlines.svelte';

  let { items }: { items: Inline[] } = $props();
</script>

{#each items as item, i (i)}
  {#if item.t === 'text'}
    {markHidden(item.text)}
  {:else if item.t === 'code'}
    <code>{markHidden(item.text)}</code>
  {:else if item.t === 'br'}
    <br />
  {:else if item.t === 'em'}
    <em><Inlines items={item.children} /></em>
  {:else if item.t === 'strong'}
    <strong><Inlines items={item.children} /></strong>
  {:else if item.t === 'del'}
    <del><Inlines items={item.children} /></del>
  {:else if item.t === 'link'}
    {#if item.href}
      <a href={item.href} rel="noopener noreferrer nofollow" target="_blank"
        ><Inlines items={item.children} /></a
      >{#if item.host}<span class="host"> ({item.host})</span>{/if}
    {:else}
      <Inlines items={item.children} />
    {/if}
  {:else if item.t === 'image'}
    <span class="alt">{markHidden(item.alt)}</span>
  {/if}
{/each}

<style>
  a {
    color: var(--accent);
    overflow-wrap: anywhere;
  }
  code {
    background: var(--surface-2);
    border-radius: 3px;
    padding: 0 0.25em;
  }
  .alt,
  .host {
    color: var(--muted);
  }
</style>
