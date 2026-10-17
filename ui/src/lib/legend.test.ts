import { describe, expect, it } from 'vitest';
import { marksLegend } from './legend';

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
