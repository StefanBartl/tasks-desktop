import { describe, expect, it } from 'vitest';
import { statusTags } from './statusTags';

describe('statusTags', () => {
  it('shows the status and the state when they say different words', () => {
    const tags = statusTags('de', 'open', 'ready');
    expect(tags.status.label).toBe('offen');
    expect(tags.state?.label).toBe('startbar');
  });

  it('shows one mark when both say the same word, and its hint names both', () => {
    for (const [lang, word] of [['de', 'geparkt'], ['en', 'parked']] as const) {
      const tags = statusTags(lang, 'parked', 'parked');
      expect(tags.state).toBeNull();
      expect(tags.status.label).toBe(word);
      expect(tags.status.hint.split('\n')).toHaveLength(2);
    }
    const de = statusTags('de', 'parked', 'parked').status.hint;
    expect(de).toContain('Status: Bewusst zurückgestellt.');
    expect(de).toContain('Zustand: Bewusst zurückgestellt; niemand arbeitet daran.');
    // The other pair with one word: decision.
    expect(statusTags('de', 'decision', 'decision').state).toBeNull();
  });

  it('has no state mark without a state', () => {
    expect(statusTags('en', 'doing', undefined).state).toBeNull();
    expect(statusTags('en', 'doing', undefined).status.hint).not.toContain('\n');
  });
});
