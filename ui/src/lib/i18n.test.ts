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

describe('the setup page', () => {
  // Every code the hub can name in `hello.engine.problem`: the setup problems (appkit `SetupProblem::code`), the
  // probe problems (`ProbeProblem::code`) and the empty vault. A code without words gets the general page.
  const CODES = [
    'invalid_setting',
    'no_vault',
    'vault_not_a_directory',
    'nvim_not_found',
    'nvim_probe_failed',
    'nvim_too_old',
    'engine_not_found',
    'lib_not_found',
    'engine_unreachable',
    'contract_unsupported',
    'engine_too_old',
    'vault_empty',
  ];
  it('has a title and an explanation, in both languages, for every code of the hub', () => {
    for (const lang of ['en', 'de'] as const) {
      for (const code of CODES) {
        expect(Object.hasOwn(dictionaries[lang], `setup.${code}.title`), `${lang} ${code} title`).toBe(true);
        expect(Object.hasOwn(dictionaries[lang], `setup.${code}.body`), `${lang} ${code} body`).toBe(true);
      }
    }
  });
});

describe('the German explanations', () => {
  // A status or a state is named by the word the page shows; the word of the file follows in brackets, so that whoever
  // edits the file finds it ("blockiert (blocked)"). Outside brackets no raw word stands in a German hint.
  const RAW = /\b(doing|open|blocked|parked|decision|done|ready|waiting|stuck|freed)\b/;
  it('name a status or a state by the shown word, the raw word only in brackets', () => {
    for (const [key, text] of Object.entries(dictionaries.de)) {
      if (!key.startsWith('hint.') && !key.startsWith('mark.legend')) continue;
      const outside = text.replace(/\([^)]*\)/g, '');
      expect(outside, key).not.toMatch(RAW);
    }
  });
  it('use one stem for finishing a task: erledigen', () => {
    for (const [key, text] of Object.entries(dictionaries.de)) {
      expect(text, key).not.toMatch(/abschlie|schließt ab|abzuschlie/i);
    }
  });
});

describe('the name of the app', () => {
  it('is the same in every language: it is a name, not a word', () => {
    expect(dictionaries.de['app.title']).toBe(dictionaries.en['app.title']);
    expect(dictionaries.en['app.title']).toBe('Tasks');
  });
});

describe('the name of the app', () => {
  it('is the same in every language: it is a name, not a word', () => {
    expect(dictionaries.de['app.title']).toBe(dictionaries.en['app.title']);
    expect(dictionaries.en['app.title']).toBe('Tasks');
  });
});
