import { describe, expect, it } from 'vitest';
import type { TaskEntry } from './contract';
import { inboxOf, missingOf, triageKey } from './inbox';

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
