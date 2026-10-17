// What the marks on a row, a card or a stage line mean, as one text for the info button beside them: one tab stop
// explains them all (a tab stop per mark would make a list of hundreds of rows unusable with the keyboard), and a
// screen reader hears the text with the button. The words are the hints of the single marks, so they say the same.

import { translate, type Lang } from './i18n';

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
