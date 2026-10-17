// The words of the next task of the overview: a value that is missing is said as a word, not as a sign.

import { translate, type Lang } from './i18n';

/** "effort M", or "no effort" when the task has none (a "?" would be a sign without a word for a screen reader). */
export function effortWords(lang: Lang, effort: string | undefined): string {
  return effort ? translate(lang, 'today.next.effort', { effort }) : translate(lang, 'mark.no_effort');
}
