<script lang="ts">
  import type { Block } from '../lib/markdown';
  import { markHidden } from '../lib/text';
  import Blocks from './Blocks.svelte';
  import Inlines from './Inlines.svelte';

  let { blocks }: { blocks: Block[] } = $props();

  // Headings of a task body sit below the h1 of the task.
  const heading = (level: number) => Math.min(6, level + 2);
</script>

{#each blocks as block, i (i)}
  {#if block.t === 'p'}
    <p><Inlines items={block.children} /></p>
  {:else if block.t === 'h'}
    {@const level = heading(block.level)}
    <svelte:element this={`h${level}`} class="md-h"
      ><Inlines items={block.children} /></svelte:element
    >
  {:else if block.t === 'list'}
    <svelte:element this={block.ordered ? 'ol' : 'ul'} start={block.ordered ? block.start : undefined}>
      {#each block.items as item, j (j)}
        <li><Blocks blocks={item} /></li>
      {/each}
    </svelte:element>
  {:else if block.t === 'quote'}
    <blockquote><Blocks blocks={block.children} /></blockquote>
  {:else if block.t === 'pre'}
    <!-- A scrolling block is reached with the keyboard. -->
    <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
    <pre tabindex="0"><code>{markHidden(block.text)}</code></pre>
  {:else if block.t === 'hr'}
    <hr />
  {:else if block.t === 'table'}
    <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
    <div class="scroll" tabindex="0">
      <table>
        {#if block.head.length > 0}
          <thead>
            <tr>
              {#each block.head as cell, j (j)}
                <th><Inlines items={cell} /></th>
              {/each}
            </tr>
          </thead>
        {/if}
        <tbody>
          {#each block.rows as row, j (j)}
            <tr>
              {#each row as cell, k (k)}
                <td><Inlines items={cell} /></td>
              {/each}
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
  {/if}
{/each}

<style>
  p {
    margin: 0 0 0.6em;
    overflow-wrap: anywhere;
  }
  .md-h {
    font-size: 0.95rem;
    margin: 0.8em 0 0.4em;
  }
  ul,
  ol {
    margin: 0 0 0.6em;
    padding-left: 1.4em;
  }
  blockquote {
    margin: 0 0 0.6em;
    padding-left: 0.8em;
    border-left: 3px solid var(--border);
    color: var(--muted);
  }
  pre {
    background: var(--surface-2);
    border-radius: var(--radius);
    padding: 0.6rem 0.8rem;
    overflow: auto;
    margin: 0 0 0.6em;
  }
  .scroll {
    overflow: auto;
    margin: 0 0 0.6em;
  }
  table {
    border-collapse: collapse;
  }
  th,
  td {
    border: 1px solid var(--border);
    padding: 0.2rem 0.5rem;
    text-align: left;
  }
</style>
