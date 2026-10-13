import { describe, expect, it } from 'vitest';
import type { TaskEntry } from './contract';
import {
  FRECENCY_MAX,
  PALETTE_LIMIT,
  bumped,
  frecencyBonus,
  matchScore,
  paletteItems,
  parseFrecency,
  stepIndex,
  taskKey,
  wordScore,
  type PaletteAction,
} from './palette';

const NOW = Date.UTC(2026, 9, 13);
const DAY = 24 * 60 * 60 * 1000;

const task = (id: string, title: string) => ({ id, title }) as unknown as TaskEntry;
const action = (key: string, label: string, hint = ''): PaletteAction => ({ key, label, hint, run: () => undefined });

describe('matching', () => {
  it('ranks the start of the text over the start of a word over the inside of a word over scattered letters', () => {
    const start = wordScore('board view', 'boa');
    const word = wordScore('go to board', 'boa');
    const inside = wordScore('keyboard', 'boa');
    const scattered = wordScore('b-o-x-a', 'boa');
    expect(start).not.toBeNull();
    expect([start, word, inside, scattered].every((s) => s !== null)).toBe(true);
    expect(start as number).toBeGreaterThan(word as number);
    expect(word as number).toBeGreaterThan(inside as number);
    expect(inside as number).toBeGreaterThan(scattered as number);
  });

  it('takes the best place a word occurs at, not the first', () => {
    // The 2 inside "e2e" is the first one, the word "2" at the end is the one that was meant.
    expect(wordScore('palette e2e 2', '2') as number).toBeGreaterThan(wordScore('palette e2e 1', '2') as number);
  });

  it('is no match when a letter is missing or out of order, and ignores the case', () => {
    expect(wordScore('board', 'bz')).toBeNull();
    expect(wordScore('board', 'ob')).toBeNull();
    expect(wordScore('Board', 'BOA')).not.toBeNull();
  });

  it('wants every word of the box somewhere in the text', () => {
    expect(matchScore('Mark all shown', 'mark shown')).not.toBeNull();
    expect(matchScore('Mark all shown', 'mark board')).toBeNull();
    expect(matchScore('anything', '   ')).toBe(0);
  });

  it('counts a letter after a non-ASCII letter as inside a word', () => {
    const inside = wordScore('äxt', 'xt');
    const word = wordScore('a xt', 'xt');
    expect(word as number).toBeGreaterThan(inside as number);
  });
});

describe('frecency', () => {
  it('weighs often and recent, and forgets with the days', () => {
    const fresh = frecencyBonus({ n: 3, last: NOW }, NOW);
    expect(fresh).toBeGreaterThan(frecencyBonus({ n: 1, last: NOW }, NOW));
    expect(frecencyBonus({ n: 3, last: NOW - 28 * DAY }, NOW)).toBeCloseTo(fresh / 4, 5);
    expect(frecencyBonus(undefined, NOW)).toBe(0);
    // A count has a ceiling: a thousand choices do not drown everything else.
    expect(frecencyBonus({ n: 1000, last: NOW }, NOW)).toBe(frecencyBonus({ n: 20, last: NOW }, NOW));
  });

  it('counts a choice and drops the weakest entries past the limit', () => {
    let f = bumped({}, 'action:a', NOW);
    f = bumped(f, 'action:a', NOW + 1);
    expect(f['action:a']).toEqual({ n: 2, last: NOW + 1 });
    let many = {};
    for (let i = 0; i < FRECENCY_MAX + 20; i++) many = bumped(many, `k${i}`, NOW + i * DAY);
    expect(Object.keys(many)).toHaveLength(FRECENCY_MAX);
    // The oldest are the ones that went.
    expect(many).not.toHaveProperty('k0');
    expect(many).toHaveProperty(`k${FRECENCY_MAX + 19}`);
  });

  it('reads back only what it wrote', () => {
    expect(parseFrecency(null)).toEqual({});
    expect(parseFrecency('not json')).toEqual({});
    expect(parseFrecency('[1]')).toEqual({});
    expect(parseFrecency('{"a":{"n":2,"last":5},"b":{"n":"x","last":1},"c":null,"d":{"n":0,"last":1}}')).toEqual({
      a: { n: 2, last: 5 },
    });
  });
});

describe('the list', () => {
  const actions = [
    action('go.today', 'Go to Today'),
    action('go.board', 'Go to Board'),
    action('rescan', 'Read the vault again'),
  ];
  const tasks = [
    task('lib.nvim/board-undo', 'Board: undo after a renumber'),
    task('lib.nvim/other', 'Something else'),
    task('docs/readme', 'Write the readme'),
  ];

  it('shows the actions and nothing else for an empty box, the ones chosen before first', () => {
    const items = paletteItems('', actions, tasks, {}, NOW);
    expect(items.map((i) => i.key)).toEqual(['action:go.today', 'action:go.board', 'action:rescan']);
    const chosen = paletteItems('', actions, tasks, { 'action:rescan': { n: 2, last: NOW } }, NOW);
    expect(chosen[0]?.key).toBe('action:rescan');
  });

  it('shows the tasks chosen before for an empty box, a few at most', () => {
    const f = { [taskKey('docs/readme')]: { n: 1, last: NOW } };
    const items = paletteItems('', actions, tasks, f, NOW);
    expect(items.filter((i) => i.kind === 'task').map((i) => i.key)).toEqual([taskKey('docs/readme')]);
    const many = Array.from({ length: 12 }, (_, i) => task(`a/t${i}`, `T ${i}`));
    const fr = Object.fromEntries(many.map((t) => [taskKey(t.id), { n: 1, last: NOW }]));
    expect(paletteItems('', [], many, fr, NOW).filter((i) => i.kind === 'task')).toHaveLength(5);
  });

  it('matches the id and the title of a task and the label of an action', () => {
    const items = paletteItems('board', actions, tasks, {}, NOW);
    expect(items.map((i) => i.key).sort()).toEqual(['action:go.board', taskKey('lib.nvim/board-undo')].sort());
    expect(paletteItems('readme', actions, tasks, {}, NOW).map((i) => i.key)).toEqual([taskKey('docs/readme')]);
  });

  it('puts the tasks first when a task matches better than any action', () => {
    const items = paletteItems('board-undo', actions, tasks, {}, NOW);
    expect(items[0]?.kind).toBe('task');
    // An action that is named well stays first.
    expect(paletteItems('go to board', actions, tasks, {}, NOW)[0]?.key).toBe('action:go.board');
  });

  it('lifts what was chosen before above an equal match, and keeps the limit', () => {
    const twins = [task('a/x1', 'same title'), task('a/x2', 'same title')];
    const f = { [taskKey('a/x2')]: { n: 2, last: NOW } };
    expect(paletteItems('same', [], twins, f, NOW)[0]?.key).toBe(taskKey('a/x2'));
    const many = Array.from({ length: 100 }, (_, i) => task(`a/t${i}`, `match ${i}`));
    expect(paletteItems('match', [], many, {}, NOW)).toHaveLength(PALETTE_LIMIT);
  });

  it('gives nothing for words that match nothing', () => {
    expect(paletteItems('zzzz', actions, tasks, {}, NOW)).toEqual([]);
  });
});

describe('stepIndex', () => {
  it('stops at the ends and copes with an empty list', () => {
    expect(stepIndex(0, -1, 3)).toBe(0);
    expect(stepIndex(2, 1, 3)).toBe(2);
    expect(stepIndex(1, 1, 3)).toBe(2);
    expect(stepIndex(5, 1, 0)).toBe(0);
  });
});
