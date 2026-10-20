import { describe, expect, it } from 'vitest';
import { dailyFigures } from './daily';

const task = (created?: string, updated?: string) => ({ created, updated }) as never;

describe('the figures of the day', () => {
  it('counts the tasks made today, and the older ones changed today, each once', () => {
    const figures = dailyFigures(
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
    expect(figures).toEqual({ created: 2, changed: 2 });
  });

  it('is zero for an empty vault and a day nothing happened on', () => {
    expect(dailyFigures([], '2026-10-20')).toEqual({ created: 0, changed: 0 });
    expect(dailyFigures([task('2026-01-01', '2026-01-02')], '2026-10-20')).toEqual({ created: 0, changed: 0 });
  });
});
