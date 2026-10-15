import { describe, expect, it } from 'vitest';
import { areaOfId, connectsAreas, crossEdges, pairsOf, touchedAreas } from './cross';
import { task } from './fixtures';

const a1 = task('lib/a1', { blocked_by: ['rules/r1'], after: ['lib/a2'] });
const a2 = task('lib/a2');
const r1 = task('rules/r1');
const r2 = task('rules/r2', { after: ['lib/a2', 'cas/c1'] });
const c1 = task('cas/c1', { blocked_by: ['lib/finished-task', 'nowhere/unknown'] });
const all = [a1, a2, r1, r2, c1];

describe('areaOfId', () => {
  it('is the part before the first slash', () => {
    expect(areaOfId('lib.nvim/some-slug')).toBe('lib.nvim');
    expect(areaOfId('plain')).toBe('plain');
  });
});

describe('crossEdges', () => {
  it('finds a link to an open task of another area, either kind', () => {
    const edges = crossEdges(all);
    expect(edges.map((e) => `${e.from}>${e.to}:${e.kind}`).sort()).toEqual([
      'lib/a1>rules/r1:blocked_by',
      'rules/r2>cas/c1:after',
      'rules/r2>lib/a2:after',
    ]);
    expect(edges.find((e) => e.from === 'lib/a1')).toMatchObject({ fromArea: 'lib', toArea: 'rules' });
  });
  it('leaves out a link inside one area and a link to a task that is not open', () => {
    const edges = crossEdges(all);
    expect(edges.some((e) => e.to === 'lib/a2' && e.from === 'lib/a1')).toBe(false);
    expect(edges.some((e) => e.to === 'lib/finished-task' || e.to === 'nowhere/unknown')).toBe(false);
  });
});

describe('touchedAreas and connectsAreas', () => {
  const touched = touchedAreas(all);
  it('gives a task its own area and the areas it is linked with, in both directions', () => {
    expect([...(touched.get('lib/a1') ?? [])].sort()).toEqual(['lib', 'rules']);
    // r1 is only waited for by a1: it touches lib although it names nothing itself
    expect([...(touched.get('rules/r1') ?? [])].sort()).toEqual(['lib', 'rules']);
    expect([...(touched.get('lib/a2') ?? [])].sort()).toEqual(['lib', 'rules']);
    expect([...(touched.get('cas/c1') ?? [])].sort()).toEqual(['cas', 'rules']);
  });
  it('is true for a task that touches two areas, and for the chosen ones only when chosen', () => {
    expect(connectsAreas(touched.get('lib/a1'), [])).toBe(true);
    expect(connectsAreas(touched.get('rules/r2'), [])).toBe(true);
    // r2 touches rules, lib and cas: with only lib and cas chosen it still links two of them
    expect(connectsAreas(touched.get('rules/r2'), ['lib', 'cas'])).toBe(true);
    // a1 touches lib and rules: with only lib chosen it links one of them
    expect(connectsAreas(touched.get('lib/a1'), ['lib'])).toBe(false);
    expect(connectsAreas(touched.get('lib/a1'), ['lib', 'rules'])).toBe(true);
    expect(connectsAreas(touched.get('lib/a2') && new Set(['lib']), [])).toBe(false);
    expect(connectsAreas(undefined, [])).toBe(false);
  });
});

describe('pairsOf', () => {
  const edges = crossEdges(all);
  it('groups the links by the two areas, the busiest pair first', () => {
    const pairs = pairsOf(edges);
    expect(pairs.map((p) => `${p.a}|${p.b}:${p.edges.length}`)).toEqual(['lib|rules:2', 'cas|rules:1']);
  });
  it('keeps only the links between chosen areas', () => {
    expect(pairsOf(edges, ['lib', 'rules']).map((p) => `${p.a}|${p.b}`)).toEqual(['lib|rules']);
    expect(pairsOf(edges, ['lib'])).toEqual([]);
    expect(pairsOf([], [])).toEqual([]);
  });
});

describe('a name written twice', () => {
  it('is one link, as the engine counts it', () => {
    const x = task('lib/x', { blocked_by: ['rules/y', 'rules/y'], after: ['rules/y', 'rules/y'] });
    const y = task('rules/y');
    const edges = crossEdges([x, y]);
    expect(edges.map((e) => e.kind).sort()).toEqual(['after', 'blocked_by']);
    expect(pairsOf(edges)[0]?.edges).toHaveLength(2);
  });
});
