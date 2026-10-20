// What the marks on a row, a card or a stage line mean, as one text for the info button beside them: one tab stop
// explains them all (a tab stop per mark would make a list of hundreds of rows unusable with the keyboard), and a
// screen reader hears the text with the button. The words are the hints of the single marks, so they say the same.

import { hintOf, translate, type Key, type Lang } from './i18n';

export function marksLegend(lang: Lang): string {
  const t = (key: Parameters<typeof translate>[1]) => translate(lang, key);
  return [
    t('mark.legend.status'),
    t('hint.prio'),
    t('hint.effort'),
    t('hint.steps'),
    `↔ n: ${t('mark.legend.cross')}`,
    `⚑ n: ${t('mark.legend.flag')}`,
    `⏰: ${t('mark.legend.due')}`,
    `!: ${t('hint.invalid')}`,
    `?: ${t('mark.legend.unknown')}`,
  ].join('\n');
}

/** The legend beside the stages of the plan: what a stage is (the word of the engine), then the marks of its lines. */
export function stagesLegend(lang: Lang): string {
  return `${translate(lang, 'plan.stage_hint')}\n${marksLegend(lang)}`;
}

/** What the codes of the findings of a check mean, one line each (the code, then the engine's rule), for the info button. */
export function checkLegend(lang: Lang, codes: readonly string[]): string {
  const seen = [...new Set(codes)];
  return seen.map((code) => `${code}: ${hintOf(lang, 'hint.check', code) || translate(lang, 'hint.check.code')}`).join('\n');
}

/** What the parts of the graph of a task mean: the two directions, the count, a circle, the wait line, the critical path. */
export function graphLegend(lang: Lang): string {
  const keys: Key[] = ['hint.graph.needs', 'hint.graph.unlocks', 'hint.graph.count', 'hint.graph.cycle', 'hint.graph.waits', 'hint.critical'];
  return keys.map((key) => translate(lang, key)).join('\n');
}
