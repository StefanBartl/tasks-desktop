import { describe, expect, it } from 'vitest';
import { metricValues } from './daily';

const figures = (tasks: never[], day: string) => {
  const v = metricValues(tasks, null, { since: day, until: day });
  return { created: v.created.value, changed: v.changed.value };
};
const task = (created?: string, updated?: string) => ({ created, updated }) as never;

describe('the figures of the day', () => {
  it('counts the tasks made today, and the older ones changed today, each once', () => {
    const got = figures(
      [
        task('2026-10-20', '2026-10-20'), // made and touched today: new, not changed too
        task('2026-10-20'),
        task('2026-10-01', '2026-10-20'),
        task('2026-10-01', '2026-10-19'),
        task(undefined, '2026-10-20'), // no created date: changed
        task(),
      ],
      '2026-10-20',
    );
    expect(got).toEqual({ created: 2, changed: 2 });
  });

  it('is zero for an empty vault and a day nothing happened on', () => {
    expect(figures([], '2026-10-20')).toEqual({ created: 0, changed: 0 });
    expect(figures([task('2026-01-01', '2026-01-02')], '2026-10-20')).toEqual({ created: 0, changed: 0 });
  });
});
