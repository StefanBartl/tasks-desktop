import { describe, expect, it } from 'vitest';
import { DEFAULT_RANGES, badLink, badTag, bodyFromSections, isWebLink, listEditable, parseTags, rangesOf, tagsChanged, tagsText } from './fields';

describe('the ranges of the engine', () => {
  it('are taken from hello.enums, and the placeholder of the effort is not a size', () => {
    const ranges = rangesOf({
      kind: ['feature', 'bug', 'novelty'],
      effort: ['XS', 'M', '<n>d'],
      value: [1, 2, 3],
      status: ['open'],
    });
    expect(ranges.kinds).toEqual(['feature', 'bug', 'novelty']);
    expect(ranges.efforts).toEqual(['XS', 'M']);
    expect(ranges.values).toEqual([1, 2, 3]);
  });

  it('take the statuses, priorities, actors, categories and severities of the engine, each on its own', () => {
    const ranges = rangesOf({
      status: ['open', 'review'],
      prio: [1, 2, 3, 4],
      actor: ['me', 'bot'],
      category: ['docs', 'legal'],
      severity: ['low', 'blocker'],
    });
    expect(ranges.statuses).toEqual(['open', 'review']);
    expect(ranges.prios).toEqual([1, 2, 3, 4]);
    expect(ranges.actors).toEqual(['me', 'bot']);
    expect(ranges.categories).toEqual(['docs', 'legal']);
    expect(ranges.severities).toEqual(['low', 'blocker']);
    // A field that is not a list of words or numbers keeps the default, the others do not change it.
    // A word or a number named twice is one choice.
    expect(rangesOf({ status: ['open', 'open', 'doing'], prio: [1, 1, 2] })).toMatchObject({ statuses: ['open', 'doing'], prios: [1, 2] });
    const bad = rangesOf({ status: 'open', prio: ['1'], actor: [''], category: [7], severity: [] });
    expect(bad).toEqual(DEFAULT_RANGES);
  });

  it('keep the default for what is missing or not what it should be (an answer is data)', () => {
    for (const bad of [undefined, null, 'x', 5, [], {}, { kind: 'bug', effort: [1], value: ['1'] }, { kind: [], effort: ['<n>d'], value: [1.5] }]) {
      expect(rangesOf(bad), JSON.stringify(bad)).toEqual(DEFAULT_RANGES);
    }
    // One good field does not make the others good.
    expect(rangesOf({ kind: ['bug'], value: [-1] })).toEqual({ ...DEFAULT_RANGES, kinds: ['bug'] });
    // Not a long list, not a long word, not a huge number.
    expect(rangesOf({ kind: Array.from({ length: 51 }, (_, i) => `k${i}`) }).kinds).toEqual(DEFAULT_RANGES.kinds);
    expect(rangesOf({ kind: ['x'.repeat(41)] }).kinds).toEqual(DEFAULT_RANGES.kinds);
    expect(rangesOf({ value: [100000] }).values).toEqual(DEFAULT_RANGES.values);
  });
});

describe('a list as one line', () => {
  it('is editable unless an entry holds a comma, which would be cut in two', () => {
    expect(listEditable(undefined)).toBe(true);
    expect(listEditable([])).toBe(true);
    expect(listEditable(['docs/a.md', 'repo@abc1234'])).toBe(true);
    expect(listEditable(['docs/a,b.md'])).toBe(false);
  });

  it('is not editable when typing the line back would clean the list up (blanks, empty, repeated)', () => {
    expect(listEditable(['a.md', 'a.md'])).toBe(false);
    expect(listEditable([' a.md'])).toBe(false);
    expect(listEditable(['a.md '])).toBe(false);
    expect(listEditable(['a.md', ''])).toBe(false);
    expect(listEditable([' '])).toBe(false);
  });
});

describe('tags', () => {
  it('splits on commas, trims, drops empties and duplicates, keeps the order', () => {
    expect(parseTags(' ui,  docs ,, ui ,perf')).toEqual(['ui', 'docs', 'perf']);
    expect(parseTags('')).toEqual([]);
    expect(parseTags(' , ')).toEqual([]);
  });

  it('does not cut a tag: the engine says its limit, and nothing is lost silently', () => {
    expect(parseTags('x'.repeat(200))[0]).toHaveLength(200);
    expect(parseTags('\u{1F600}'.repeat(40))[0]).toBe('\u{1F600}'.repeat(40));
  });

  // The engine's rule, written out (ops.lua / mutate.lua): the characters of a list entry that break the file, and
  // every control character except the tab. Probed against the real engine for U+0000..U+01FF.
  it('refuses what the engine refuses and nothing else', () => {
    const refusedByEngine = (cp: number) =>
      cp <= 0x08 || (cp >= 0x0a && cp <= 0x1f) || (cp >= 0x7f && cp <= 0x9f) || cp === 0x2028 || cp === 0x2029;
    const listBreakers = new Set([',', '[', ']', '"', "'", '#']);
    for (let cp = 0; cp <= 0x1ff; cp += 1) {
      const ch = String.fromCodePoint(cp);
      const expected = refusedByEngine(cp) || listBreakers.has(ch);
      expect(badTag([`a${ch}b`]) !== null, `U+${cp.toString(16)}`).toBe(expected);
    }
    for (const cp of [0x2028, 0x2029]) {
      expect(badTag([`a${String.fromCodePoint(cp)}b`])).not.toBeNull();
    }
    expect(badTag(['ok', 'a#b', 'c'])).toBe('a#b');
    expect(badTag(['fine: but-ok 1.2', 'ünï', 'tab\there'])).toBeNull();
  });

  it('shows the tags and notices a change only when there is one', () => {
    expect(tagsText(['a', 'b'])).toBe('a, b');
    expect(tagsText(undefined)).toBe('');
    expect(tagsChanged(['a', 'b'], 'a,b')).toBe(false);
    expect(tagsChanged(['a', 'b'], 'b, a')).toBe(true);
    expect(tagsChanged(undefined, '')).toBe(false);
    expect(tagsChanged(undefined, 'x')).toBe(true);
    expect(tagsChanged(['a'], '')).toBe(true);
  });
});

describe('the body of a new task from its sections', () => {
  it('is empty when nothing was typed, so the engine writes its own sections', () => {
    expect(bodyFromSections({ context: ' ', acceptance: '', notes: '\n' }, 'de')).toBe('');
  });

  it('keeps the hint of an empty section and gives a plain acceptance line a checkbox', () => {
    const body = bodyFromSections({ context: 'Why', acceptance: 'works\n- [x] kept\n\nlast', notes: '' }, 'en');
    expect(body).toBe(
      [
        '## Context',
        '',
        'Why',
        '',
        '## Acceptance',
        '',
        '- [ ] works',
        '- [x] kept',
        '',
        '- [ ] last',
        '',
        '## Notes',
        '',
        '<!-- Decisions, dead ends, references. -->',
        '',
      ].join('\n'),
    );
  });

  it('uses the German headings', () => {
    expect(bodyFromSections({ context: '', acceptance: '', notes: 'n' }, 'de')).toContain('## Notizen\n\nn');
  });
});

describe('web links', () => {
  it('accept http and https addresses with a host, nothing else', () => {
    expect(isWebLink('https://example.org/a#b')).toBe(true);
    expect(isWebLink('HTTP://example.org')).toBe(true);
    for (const bad of ['javascript:alert(1)', 'ftp://example.org', 'file:///c:/x', 'lua/x.lua', 'https://', 'https:// a', 'https://a\tb', 'data:text/html,x']) {
      expect(isWebLink(bad)).toBe(false);
    }
  });

  it('name the first entry that is none', () => {
    expect(badLink(['https://ok.org', 'javascript:x', 'ftp://y'])).toBe('javascript:x');
    expect(badLink(['https://ok.org'])).toBeNull();
    expect(badLink([])).toBeNull();
  });
});
