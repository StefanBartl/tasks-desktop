import { describe, expect, it } from 'vitest';
import { dictionaries, hintOf } from './i18n';

// The explanations of the page (the popup itself is the kit's, tested there): every word the engine can say has one.
describe('hintOf', () => {
  it('finds the explanation of a known value and says nothing of an unknown one', () => {
    expect(hintOf('en', 'hint.state', 'freed')).toContain('nothing blocks it');
    expect(hintOf('de', 'hint.state', 'freed')).toContain('nichts blockiert');
    expect(hintOf('en', 'hint.state', 'a-word-of-a-newer-engine')).toBe('');
    expect(hintOf('en', 'hint.state', undefined)).toBe('');
  });

  it('explains every state and every status the page has a word for', () => {
    for (const lang of ['en', 'de'] as const) {
      for (const state of ['ready', 'decision', 'waiting', 'stuck', 'freed', 'parked', 'unknown']) {
        expect(hintOf(lang, 'hint.state', state), `${lang} state ${state}`).not.toBe('');
      }
      for (const key of Object.keys(dictionaries[lang]).filter((k) => k.startsWith('status.'))) {
        const status = key.slice('status.'.length);
        expect(hintOf(lang, 'hint.status', status), `${lang} status ${status}`).not.toBe('');
      }
    }
  });

  it('explains every field the inbox can say is missing, and the parts of the board and the matrix', () => {
    for (const lang of ['en', 'de'] as const) {
      const missing = Object.keys(dictionaries[lang]).filter((k) => k.startsWith('inbox.missing.'));
      expect(missing.length).toBeGreaterThan(0);
      for (const key of missing) {
        const field = key.slice('inbox.missing.'.length);
        expect(hintOf(lang, 'hint.inbox.missing', field), `${lang} inbox ${field}`).not.toBe('');
      }
      for (const key of ['hint.board.count', 'hint.board.done', 'hint.board.group', 'hint.invalid', 'hint.inbox']) {
        expect(dictionaries[lang][key as keyof (typeof dictionaries)[typeof lang]], `${lang} ${key}`).not.toBe('');
      }
    }
  });

  it('explains every finding code the check of the engine documents, in both languages', () => {
    // The codes of `lua/tasks_nvim/check.lua` (its header lists them); a code of a newer engine just has no explanation.
    const codes = [
      'frontmatter-missing', 'frontmatter-invalid', 'title-missing', 'status-missing', 'field-type', 'unknown-status',
      'unknown-kind', 'unknown-category', 'unknown-severity', 'bad-prio', 'bad-effort', 'bad-date', 'bad-value', 'bad-actor',
      'severity-without-bug-or-security', 'slug', 'slug-conflict', 'asset-dangling', 'index-stale', 'bad-blocked-by',
      'blocked-by-self', 'blocked-by-dangling', 'blocked-by-done', 'blocked-by-cycle', 'doing-while-blocked',
      'blocked-without-blocker', 'blocker-freed', 'blocked-by-parked', 'plan-unknown', 'bad-plan', 'bad-phase', 'plan-area',
      'plan-phase', 'plan-target-unknown', 'bad-after', 'bad-order', 'after-self', 'after-dangling', 'wikilink-dangling',
      'wikilink-ambiguous', 'actor-cdx-waits-on-me', 'done-in-roadmap', 'open-in-backlog', 'duplicate-id', 'unreadable',
      'index-error', 'symlink-task', 'frontmatter-warning', 'title-comment',
    ];
    for (const lang of ['en', 'de'] as const) {
      for (const code of codes) expect(hintOf(lang, 'hint.check', code), `${lang} ${code}`).not.toBe('');
      expect(hintOf(lang, 'hint.check', 'a-code-of-a-newer-engine')).toBe('');
    }
  });

  it('writes the unit of the critical path out', () => {
    expect(dictionaries.en['plan.days']).toContain('days');
    expect(dictionaries.de['plan.days']).toContain('Tage');
    expect(dictionaries.en['plan.days']).not.toBe('{days} d');
  });
});
