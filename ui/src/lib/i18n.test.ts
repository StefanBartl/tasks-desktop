import { describe, expect, it } from 'vitest';
import { ago, detectLang, dictionaries, labelOf, translate, type Key } from './i18n';

describe('i18n', () => {
  it('has the same keys and the same placeholders in both languages', () => {
    const keys = Object.keys(dictionaries.en).sort();
    expect(Object.keys(dictionaries.de).sort()).toEqual(keys);
    const holes = (s: string) => (s.match(/\{\w+\}/g) ?? []).sort();
    for (const key of keys as Key[]) {
      expect(holes(dictionaries.de[key]), key).toEqual(holes(dictionaries.en[key]));
      expect(dictionaries.de[key].length, key).toBeGreaterThan(0);
    }
  });
  it('fills placeholders and leaves unknown ones', () => {
    expect(translate('en', 'list.count', { shown: 2, total: 9 })).toBe('2 of 9');
    expect(translate('de', 'list.count', { shown: 2 })).toBe('2 von {total}');
  });
  it('detects German, else English', () => {
    expect(detectLang(['de-AT', 'en'])).toBe('de');
    expect(detectLang(['fr', 'en-GB'])).toBe('en');
    expect(detectLang(['fr'])).toBe('en');
  });
  it('says how long ago in a fitting unit', () => {
    expect(ago('en', 30_000)).toBe('30 s');
    expect(ago('en', 10 * 60_000)).toBe('10 min');
    expect(ago('de', 5 * 3_600_000)).toBe('5 Std');
    expect(ago('en', 5 * 86_400_000)).toBe('5 d');
  });
});

describe('labelOf', () => {
  it('names a known word and shows an unknown one as it is', () => {
    expect(labelOf('de', 'status', 'doing')).toBe('läuft');
    expect(labelOf('en', 'state', 'a-new-state-of-the-engine')).toBe('a-new-state-of-the-engine');
    expect(labelOf('en', 'status', undefined)).toBe('?');
    // A word that happens to be a property of every object is not a key.
    expect(labelOf('en', 'status', 'constructor')).toBe('constructor');
  });
});
