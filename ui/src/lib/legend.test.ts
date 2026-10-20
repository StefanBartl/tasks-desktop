import { describe, expect, it } from 'vitest';
import { checkLegend, graphLegend, marksLegend, stagesLegend } from './legend';

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

describe('the legend of the check codes', () => {
  it('gives one line per code, each with the rule of the engine, and the general words for a code it does not know', () => {
    const text = checkLegend('en', ['bad-prio', 'title-missing', 'bad-prio', 'brand-new-code']);
    const lines = text.split('\n');
    expect(lines).toHaveLength(3);
    expect(lines[0]).toBe('bad-prio: The priority must be 1, 2 or 3.');
    expect(lines[2]).toMatch(/^brand-new-code: /);
    expect(lines[2]).not.toMatch(/hint\./);
    expect(checkLegend('de', ['bad-prio'])).toMatch(/^bad-prio: .*Priorität/);
    expect(checkLegend('en', [])).toBe('');
    // The engine's text never reaches the popup with a character that reverses it.
    expect(checkLegend('en', ['a'+String.fromCharCode(0x202e)+'b'])).toMatch(/^a⟦U\+202E⟧b: /);
  });
});

describe('the legend of the graph', () => {
  it('says what the directions, the count, a circle, the wait line and the critical path mean, in both languages', () => {
    for (const lang of ['en', 'de'] as const) {
      const text = graphLegend(lang);
      expect(text.split('\n'), lang).toHaveLength(6);
      expect(text).not.toMatch(/hint\./);
    }
  });
});
