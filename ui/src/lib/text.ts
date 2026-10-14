// Text from the vault is untrusted. It is only ever shown as text (never as
// HTML). Characters that hide or reorder what is read are made visible.

// Bidi controls, zero-width characters, the byte order mark, soft hyphen and
// the tag characters.
const HIDDEN = /[­\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF\u{e0000}-\u{e007f}]/gu;

/** Does the text hold such characters? */
export function hasHidden(text: string): boolean {
  HIDDEN.lastIndex = 0;
  return HIDDEN.test(text);
}

/** The text with each such character shown as ⟦U+XXXX⟧. */
export function markHidden(text: string): string {
  return text.replace(HIDDEN, (c) => {
    const code = c.codePointAt(0) ?? 0;
    return `⟦U+${code.toString(16).toUpperCase().padStart(4, '0')}⟧`;
  });
}

/** The longest text the engine takes for a task (`set_body`), in characters. */
export const MAX_BODY_EDIT = 100_000;

/** Whether the text of a task may be offered for editing: whole (not cut by the engine) and not longer than the engine takes back. */
export function editableBody(body: string, truncated: boolean): boolean {
  return !truncated && [...body.trim()].length <= MAX_BODY_EDIT;
}
