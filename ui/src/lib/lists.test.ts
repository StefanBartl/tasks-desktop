import { describe, expect, it } from 'vitest';
import { freshFilter } from './filter';
import {
  MAX_LISTS,
  MAX_NAME,
  activeList,
  cleanName,
  makeList,
  parseListMemory,
  serializeListMemory,
  vaultKey,
  withList,
  withoutList,
} from './lists';

const doing = () => ({ ...freshFilter(), statuses: ['doing'] });

describe('names', () => {
  it('trims and collapses spaces, and refuses empty, long and control characters', () => {
    expect(cleanName('  small   and worth it ')).toBe('small and worth it');
    expect(cleanName('   ')).toBeNull();
    expect(cleanName('x'.repeat(MAX_NAME))).not.toBeNull();
    expect(cleanName('x'.repeat(MAX_NAME + 1))).toBeNull();
    expect(cleanName('a\u0007b')).toBeNull();
  });
});

describe('lists', () => {
  it('keeps the filter and the order, never the search words', () => {
    const list = makeList('Doing', { ...doing(), query: 'secret words' }, 'roi');
    expect(list.sort).toBe('roi');
    expect(list.filter).not.toContain('secret');
    expect(JSON.parse(list.filter).statuses).toEqual(['doing']);
  });

  it('replaces a list of the same name whatever the case, and adds another', () => {
    const a = makeList('Doing', doing(), 'default');
    const b = makeList('doing', doing(), 'roi');
    expect(withList([a], b)).toEqual([b]);
    const c = makeList('Other', freshFilter(), 'default');
    expect(withList([a], c)).toEqual([a, c]);
  });

  it('refuses a list past the limit, but still replaces one', () => {
    const full = Array.from({ length: MAX_LISTS }, (_, i) => makeList(`list ${i}`, freshFilter(), 'default'));
    expect(withList(full, makeList('one more', freshFilter(), 'default'))).toBeNull();
    expect(withList(full, makeList('LIST 3', doing(), 'roi'))?.length).toBe(MAX_LISTS);
  });

  it('removes by name', () => {
    const lists = [makeList('A', freshFilter(), 'default'), makeList('B', freshFilter(), 'default')];
    expect(withoutList(lists, 'a').map((l) => l.name)).toEqual(['B']);
    expect(withoutList(lists, 'nothing')).toEqual(lists);
  });

  it('knows which list is the one shown now', () => {
    const lists = [makeList('Doing', doing(), 'default'), makeList('Doing by return', doing(), 'roi')];
    expect(activeList(lists, doing(), 'roi')?.name).toBe('Doing by return');
    expect(activeList(lists, doing(), 'default')?.name).toBe('Doing');
    expect(activeList(lists, freshFilter(), 'default')).toBeUndefined();
    expect(activeList(lists, { ...doing(), query: 'x' }, 'default')?.name).toBe('Doing');
  });
});

describe('the same filter in another order of choices', () => {
  it('is the list that was kept, however the fields were chosen', () => {
    const made = { ...freshFilter(), fields: { tag: ['x'], kind: ['bug'] } };
    const list = makeList('Bugs', made, 'default');
    // Read back, the fields stand in the order of the fields of the page, not of the person's clicks.
    const back = { ...freshFilter(), fields: { kind: ['bug'], tag: ['x'] } };
    expect(activeList([list], back, 'default')?.name).toBe('Bugs');
    expect(activeList([list], made, 'default')?.name).toBe('Bugs');
  });
});

describe('the memory', () => {
  it('survives a round trip, by vault', () => {
    const memory = { '': [makeList('A', doing(), 'severity')], work: [makeList('B', freshFilter(), 'default')] };
    expect(parseListMemory(serializeListMemory(memory))).toEqual(memory);
  });

  it('keeps what it can of a damaged memory', () => {
    expect(parseListMemory(null)).toEqual({});
    expect(parseListMemory('{not json')).toEqual({});
    expect(parseListMemory('[1]')).toEqual({});
    const damaged = JSON.stringify({
      work: [
        { name: 'ok', filter: '{"statuses":["open"]}', sort: 'sideways' },
        { name: '', filter: '{}', sort: 'roi' },
        { name: 'no filter', sort: 'roi' },
        { name: 'OK', filter: '{}', sort: 'roi' },
        7,
      ],
      other: 'x',
    });
    const read = parseListMemory(damaged);
    expect(Object.keys(read)).toEqual(['work']);
    expect(read.work?.map((l) => [l.name, l.sort])).toEqual([['ok', 'default']]);
  });

  it('names the vault of the hub, or none', () => {
    expect(vaultKey('work')).toBe('work');
    expect(vaultKey(null)).toBe('');
    expect(vaultKey(undefined)).toBe('');
  });
});
