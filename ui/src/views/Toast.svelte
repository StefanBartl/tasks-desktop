<script lang="ts">
  // What a write did, in one line, and the way back when there is one. The toast and its regions are the kit's.
  import KitToast from 'appkit-ui/Toast.svelte';
  import type { App } from '../lib/app.svelte';
  import { translate, type Key } from '../lib/i18n';

  let { app }: { app: App } = $props();
  const t = (key: Key, params: Record<string, string | number> = {}) =>
    translate(app.lang, key, params);
  const message = $derived(
    app.toast ? { kind: app.toast.kind, text: app.toast.text, undo: !!app.toast.undo } : null,
  );
</script>

<KitToast
  toast={message}
  busy={app.answering}
  onundo={() => app.undo()}
  ondismiss={() => app.dismissToast()}
  labels={{ undo: t('write.undo'), dismiss: t('write.dismiss') }}
/>
