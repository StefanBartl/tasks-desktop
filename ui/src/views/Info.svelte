<script lang="ts">
  // The "what does this mean" button next to a label that is not clear by itself. The explanation is on the
  // button as `data-hint` (the popup of `lib/tooltip.ts` shows it on hover and on focus) and also stays in the page
  // for a screen reader, which hears it with the button.
  let { hint, label }: { hint: string; label: string } = $props();
  const id = `info-${Math.random().toString(36).slice(2, 9)}`;
</script>

<button type="button" class="info" data-hint={hint} data-hint-own aria-label={label} aria-describedby={id}>ⓘ</button>
<span {id} class="sr-only">{hint}</span>
