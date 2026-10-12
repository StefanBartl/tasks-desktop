import { describe, expect, it } from 'vitest';
import { dueTasks, isDue, localToday } from './remind';
import { task } from './fixtures';

describe('reminders', () => {
  it('takes the day of the reader, with leading zeros', () => {
    expect(localToday(new Date(2026, 0, 5))).toBe('2026-01-05');
    expect(localToday(new Date(2026, 11, 31))).toBe('2026-12-31');
  });

  it('is due on the day and after, never before, never for a non-date', () => {
    expect(isDue('2026-03-01', '2026-03-01')).toBe(true);
    expect(isDue('2026-02-28', '2026-03-01')).toBe(true);
    expect(isDue('2026-03-02', '2026-03-01')).toBe(false);
    expect(isDue(undefined, '2026-03-01')).toBe(false);
    expect(isDue('soon', '2026-03-01')).toBe(false);
  });

  it('lists the due ones, the oldest date first and the engine order within a day', () => {
    const list = [
      task('a/one', { remind: '2026-03-01' }),
      task('a/two'),
      task('a/three', { remind: '2026-02-01' }),
      task('a/four', { remind: '2026-03-01' }),
      task('a/later', { remind: '2026-04-01' }),
    ];
    expect(dueTasks(list, '2026-03-01').map((t) => t.id)).toEqual(['a/three', 'a/one', 'a/four']);
  });
});
