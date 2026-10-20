<script lang="ts">
  // The command palette (Ctrl+K) of the page: the box, the list and the keys are the kit's; this file gives it the
  // actions of the page, the tasks, the words, and what a choice does (it is remembered and comes first next time).
  import KitPalette from 'appkit-ui/Palette.svelte';
  import { paletteItems, type PaletteItem } from 'appkit-ui/palette';
  import type { App } from '../lib/app.svelte';
  import { translate, type Key } from '../lib/i18n';
  import { paletteActions } from '../lib/paletteActions';

  let { app }: { app: App } = $props();
  const t = (key: Key, params: Record<string, string | number> = {}) =>
    translate(app.lang, key, params);

  // The actions are worked out while the palette is open (the selection may change under it).
  function items(query: string): PaletteItem[] {
    return paletteItems(query, paletteActions(app), app.tasks, app.frecency, Date.now(), {
      entryPrefix: 'task:',
      recent: 5,
    });
  }

  async function choose(item: PaletteItem): Promise<void> {
    app.chose(item.key, item.kind === 'entry' ? item.id : undefined);
    // Closed first: what an action opens (a dialog) must not stand under this one.
    app.closePalette();
    if (item.kind === 'action') await item.action.run();
    else app.reveal(item.id);
  }
</script>

<KitPalette
  open={app.palette}
  {items}
  onchoose={choose}
  onclose={() => app.closePalette()}
  labels={{
    title: t('palette.title'),
    label: t('palette.label'),
    placeholder: t('palette.placeholder'),
    none: t('palette.none'),
    action: t('palette.action'),
    entry: t('palette.task'),
  }}
/>
