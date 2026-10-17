import { describe, expect, it } from 'vitest';
import { marksLegend, stagesLegend } from './legend';

describe('the legend of the marks', () => {
  it('explains every mark a row, a card or a stage line can show, in both languages', () => {
    for (const lang of ['en', 'de'] as const) {
      const text = marksLegend(lang);
      for (const sign of ['↔', '⚑', '⏰', '!', '?']) expect(text, `${lang} ${sign}`).toContain(sign);
      expect(text.split('\n')).toHaveLength(9);
      expect(text).not.toMatch(/mark\.legend|hint\./);
    }
    expect(marksLegend('en')).toContain('Priority: 1');
    expect(marksLegend('de')).toContain('Priorität: 1');
  });
});

describe('the legend of the stages', () => {
  it('first says what a stage is, then the marks of its lines, in both languages', () => {
    for (const lang of ['en', 'de'] as const) {
      const [first, ...rest] = stagesLegend(lang).split('\n');
      expect(first, lang).not.toMatch(/plan\.stage_hint/);
      expect(rest.join('\n')).toBe(marksLegend(lang));
    }
    expect(stagesLegend('en')).toMatch(/^Stage: .*earliest stage.*Without a stage: a cycle/);
    expect(stagesLegend('de')).toMatch(/^Stufe: .*frühesten Stufe.*Ohne Stufe: ein Zyklus/);
  });
});
