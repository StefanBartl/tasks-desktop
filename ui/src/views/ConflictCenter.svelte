<script lang="ts">
  // The conflict center: every change the engine refused because the file had moved on. The dialog is the kit's (all
  // at once, or one at a time as the person chooses); this file words each conflict and names what can be done.
  import KitConflictCenter from 'appkit-ui/ConflictCenter.svelte';
  import type { ConflictItem } from 'appkit-ui/conflicts';
  import type { App } from '../lib/app.svelte';
  import { alreadyDone, differences, retryOp } from '../lib/conflicts';
  import { labelOf, translate, type Key } from '../lib/i18n';

  let { app }: { app: App } = $props();
  const t = (key: Key, params: Record<string, string | number> = {}) =>
    translate(app.lang, key, params);

  /** A key of the frontmatter as the person knows it; a key this version does not know is shown as it is. */
  function keyLabel(key: string): string {
    const known: Record<string, Key> = {
      status: 'field.status',
      prio: 'field.prio',
      actor: 'field.actor',
      effort: 'field.effort',
      tags: 'field.tags',
      remind: 'remind.field',
    };
    const hit = known[key];
    return hit ? t(hit) : key;
  }

  function valueLabel(key: string, value: string): string {
    return key === 'status' || key === 'actor' ? labelOf(app.lang, key, value) : value;
  }

  const items = $derived(
    app.conflicts.map((conflict): ConflictItem => {
      const task = app.tasks.find((x) => x.id === conflict.id);
      const same = alreadyDone(conflict, task);
      const notes: string[] = [];
      if (conflict.code === 'not_found' || !task) notes.push(t('conflicts.gone'));
      else if (conflict.code === 'locked' || conflict.code === 'lock_stuck') notes.push(t('conflicts.locked'));
      if (conflict.op.op === 'reorder') notes.push(t('conflicts.order'));
      else if (same) notes.push(t('conflicts.done_already'));
      const showRows = conflict.op.op !== 'reorder' && !same;
      return {
        key: conflict.key,
        title: task?.title ?? conflict.id,
        id: conflict.id,
        notes,
        rows: showRows
          ? differences(conflict, task).map((d) => ({
              key: d.key,
              label: keyLabel(d.key),
              wanted: valueLabel(d.key, d.wanted),
              now: valueLabel(d.key, d.now),
            }))
          : [],
        actions: [
          ...(retryOp(conflict, task) !== null && !same
            ? [{ name: 'retry', label: t('conflicts.retry'), primary: true, disabled: app.saving }]
            : []),
          { name: 'discard', label: t('conflicts.discard') },
        ],
      };
    }),
  );
</script>

<KitConflictCenter
  open={app.conflictsOpen}
  {items}
  mode={app.conflictMode}
  onmode={(mode) => app.setConflictMode(mode)}
  onaction={(key, action) => (action === 'retry' ? app.retryConflict(key) : app.discardConflict(key))}
  ondiscardall={() => app.discardAllConflicts()}
  onclose={() => app.closeConflicts()}
  labels={{
    title: t('conflicts.title'),
    intro: t('conflicts.intro'),
    field: t('conflicts.field'),
    wanted: t('conflicts.wanted'),
    now: t('conflicts.now'),
    more: (n) => t('conflicts.more', { n }),
    discardAll: t('conflicts.discard_all'),
    close: t('conflicts.close'),
    view: t('conflicts.view'),
    viewList: t('conflicts.view_list'),
    viewSingle: t('conflicts.view_single'),
  }}
/>
