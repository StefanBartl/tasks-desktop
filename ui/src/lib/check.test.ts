import { describe, expect, it } from 'vitest';
import { findingsByTask, groundOf, judgeFindings, timeOf, type Finding } from './check';
import type { TaskEntry } from './contract';

const task = (id: string, etag: string) => ({ id, etag }) as unknown as TaskEntry;
const finding = (id: string | undefined, code = 'bad-prio'): Finding =>
  ({ code, severity: 'error', area: 'pub', id, file: 'pub/ROADMAP/tasks/x.md', message: 'm' }) as Finding;

describe('judging the findings of the check', () => {
  const ground = groundOf([task('pub/a', 'e1'), task('pub/b', 'e2'), task('pub/c', 'e3')]);
  const findings = [finding('pub/a'), finding('pub/b'), finding('pub/b', 'bad-effort'), finding('pub/c'), finding(undefined, 'index-stale'), finding('pub/odd', 'unknown-status')];

  it('keeps a finding of a task that is as it was, greys one of a task that changed, drops one of a task that is gone', () => {
    const judged = judgeFindings(findings, ground, [task('pub/a', 'e1'), task('pub/b', 'e2-changed')]);
    expect(judged.valid.filter((f) => f.id === 'pub/a')).toHaveLength(1);
    expect(judged.stale.map((f) => f.id)).toEqual(['pub/b', 'pub/b']);
    expect([...judged.valid, ...judged.stale].some((f) => f.id === 'pub/c')).toBe(false);
    // Two tasks changed or went, however many findings each had.
    expect(judged.changed).toBe(2);
  });

  it('lets a finding about no listed task stand: a file, an unlisted task', () => {
    const judged = judgeFindings(findings, ground, [task('pub/a', 'e1')]);
    expect(judged.valid.map((f) => f.code)).toEqual(['bad-prio', 'index-stale', 'unknown-status']);
  });

  it('holds everything while nothing changed', () => {
    const judged = judgeFindings(findings, ground, [task('pub/a', 'e1'), task('pub/b', 'e2'), task('pub/c', 'e3')]);
    expect(judged.valid).toHaveLength(findings.length);
    expect(judged.stale).toEqual([]);
    expect(judged.changed).toBe(0);
  });

  it('indexes the findings that hold by their task', () => {
    const judged = judgeFindings(findings, ground, [task('pub/a', 'e1'), task('pub/b', 'e2'), task('pub/c', 'e3')]);
    const byTask = findingsByTask(judged.valid);
    expect(byTask.get('pub/b')?.map((f) => f.code)).toEqual(['bad-prio', 'bad-effort']);
    expect(byTask.has('pub/odd')).toBe(true);
    expect([...byTask.keys()]).not.toContain(undefined);
  });

  it('a task without a version is a version of its own', () => {
    const g = groundOf([{ id: 'pub/x' } as unknown as TaskEntry]);
    expect(judgeFindings([finding('pub/x')], g, [{ id: 'pub/x' } as unknown as TaskEntry]).valid).toHaveLength(1);
    expect(judgeFindings([finding('pub/x')], g, [task('pub/x', 'e9')]).stale).toHaveLength(1);
  });
});

describe('the time of a check', () => {
  it('is told in the language of the person, and not at all for a time that is not one', () => {
    expect(timeOf('2026-10-14T13:05:00+02:00', 'en')).toMatch(/\d{2}:\d{2}/);
    expect(timeOf('not a time', 'de')).toBeNull();
    expect(timeOf('', 'de')).toBeNull();
  });
});
