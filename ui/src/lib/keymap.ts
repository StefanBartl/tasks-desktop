// The keys of the page: the keys every app shares are the kit's (`keymap.json`: Ctrl or Cmd and K for the palette, the
// `g` chord with its timeout); this file adds the targets of the chord, the views of this page.

import { defaultKeymap, withChord, type KeyPress } from 'appkit-ui/keymap';
import type { View } from './app.svelte';

/** `g h` is Today, `g l` the list, `g p` the plan, `g b` the board, `g i` the inbox, `g v` the saved views. */
export const keymap = withChord(defaultKeymap, {
  h: 'today',
  l: 'list',
  p: 'plan',
  b: 'board',
  i: 'inbox',
  v: 'views',
} satisfies Record<string, View>);

/** The press of a key as the kit reads it. */
export function pressOf(event: KeyboardEvent, typing = false): KeyPress {
  return {
    key: event.key,
    ctrlKey: event.ctrlKey,
    metaKey: event.metaKey,
    altKey: event.altKey,
    shiftKey: event.shiftKey,
    typing,
  };
}
