// The text rules of this app. The guard against characters that hide or reorder text is the kit's; it is taken
// from here so that every view imports one module for "text from the vault".

export { hasHidden, markHidden } from 'appkit-ui/text';

/** The longest text the engine takes for a task (`set_body`), in characters. */
export const MAX_BODY_EDIT = 100_000;

/** Whether the text of a task may be offered for editing: whole (not cut by the engine) and not longer than the engine takes back. */
export function editableBody(body: string, truncated: boolean): boolean {
  return !truncated && [...body.trim()].length <= MAX_BODY_EDIT;
}
