import { describe, expect, it } from 'vitest';
import type { TaskEntry } from './contract';
import { INBOX_PAGE, inboxOf, missingOf, shownCount, triageKey } from './inbox';

const t = (id: string, extra: Partial<TaskEntry> = {}) => ({ id, ...extra }) as unknown as TaskEntry;

describe('the inbox', () => {
  it('holds the tasks that lack a priority, an effort or a written actor, in the order they came', () => {
    const sorted = t('a', { prio: 2, effort: 'S', actor: 'cdx', actor_written: true });
    const noPrio = t('b', { effort: 'S', actor: 'me', actor_written: true });
    const noEffort = t('c', { prio: 1, actor: 'me', actor_written: true });
    const derivedActor = t('d', { prio: 1, effort: 'M', actor: 'me' });
    expect(inboxOf([sorted, noPrio, noEffort, derivedActor]).map((x) => x.id)).toEqual(['b', 'c', 'd']);
    expect(missingOf(noPrio)).toEqual(['prio']);
    expect(missingOf(noEffort)).toEqual(['effort']);
    expect(missingOf(derivedActor)).toEqual(['actor']);
    expect(missingOf(t('e'))).toEqual(['prio', 'effort', 'actor']);
    expect(missingOf(sorted)).toEqual([]);
  });
});

describe('the keys', () => {
  it('name a priority, an effort and an actor', () => {
    expect(triageKey('2', false)).toEqual({ field: 'prio', value: 2 });
    expect(triageKey('a', false)).toEqual({ field: 'effort', value: 'XS' });
    expect(triageKey('s', false)).toEqual({ field: 'effort', value: 'S' });
    expect(triageKey('d', false)).toEqual({ field: 'effort', value: 'M' });
    expect(triageKey('f', false)).toEqual({ field: 'effort', value: 'L' });
    expect(triageKey('F', true)).toEqual({ field: 'effort', value: 'XL' });
    expect(triageKey('m', false)).toEqual({ field: 'actor', value: 'me' });
    expect(triageKey('p', false)).toEqual({ field: 'actor', value: 'pair' });
    expect(triageKey('i', false)).toEqual({ field: 'actor', value: 'cdx' });
  });

  it('read the case from Shift, not from the letter', () => {
    // CapsLock gives a capital F without Shift: that is an L, not an XL.
    expect(triageKey('F', false)).toEqual({ field: 'effort', value: 'L' });
    // Shift with another letter is not a key of the inbox.
    expect(triageKey('S', true)).toBeNull();
    expect(triageKey('M', true)).toBeNull();
  });

  it('leave every other key alone', () => {
    for (const key of ['0', '4', 'j', 'k', 'g', 'c', 'x', 'Enter', 'Escape', ' ']) {
      expect(triageKey(key, false), key).toBeNull();
    }
  });
});

describe('the page of the inbox', () => {
  const rows = Array.from({ length: 250 }, (_, i) => ({ id: `pub/t${i}` }));

  it('draws one page, or all rows when there are fewer', () => {
    expect(INBOX_PAGE).toBe(100);
    expect(shownCount(rows, null, INBOX_PAGE)).toBe(100);
    expect(shownCount(rows.slice(0, 7), null, INBOX_PAGE)).toBe(7);
    expect(shownCount([], null, INBOX_PAGE)).toBe(0);
  });

  it('grows with the limit and stops at the end of the list', () => {
    expect(shownCount(rows, null, 200)).toBe(200);
    expect(shownCount(rows, null, 300)).toBe(250);
  });

  it('draws the selected row, however far down it is, and the rows above it', () => {
    expect(shownCount(rows, 'pub/t99', INBOX_PAGE)).toBe(100);
    expect(shownCount(rows, 'pub/t100', INBOX_PAGE)).toBe(101);
    expect(shownCount(rows, 'pub/t249', INBOX_PAGE)).toBe(250);
  });

  it('ignores a selection that is not in the list', () => {
    expect(shownCount(rows, 'pub/gone', INBOX_PAGE)).toBe(100);
  });
});
