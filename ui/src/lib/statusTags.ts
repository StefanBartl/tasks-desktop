// The status of a task and its state in the plan, as the marks that stand side by side in a row (list, plan, graph).
import { hintOf, labelOf, translate, type Lang } from './i18n';

export interface StatusTag {
  label: string;
  hint: string;
}

/**
 * The mark of the status and, when one is shown, the mark of the state. When both say the same word (`parked` and
 * `parked`, `decision` and `decision`) there is one mark: the state's is left out and the hint names both.
 */
export function statusTags(
  lang: Lang,
  status: string | undefined,
  state: string | undefined,
): { status: StatusTag; state: StatusTag | null } {
  const statusTag = { label: labelOf(lang, 'status', status), hint: hintOf(lang, 'hint.status', status) };
  if (state === undefined || state === '') return { status: statusTag, state: null };
  const stateTag = { label: labelOf(lang, 'state', state), hint: hintOf(lang, 'hint.state', state) };
  if (stateTag.label !== statusTag.label) return { status: statusTag, state: stateTag };
  const both = [
    statusTag.hint === '' ? '' : `${translate(lang, 'prop.status')}: ${statusTag.hint}`,
    stateTag.hint === '' ? '' : `${translate(lang, 'prop.state')}: ${stateTag.hint}`,
  ].filter((line) => line !== '');
  return { status: { label: statusTag.label, hint: both.join('\n') }, state: null };
}
