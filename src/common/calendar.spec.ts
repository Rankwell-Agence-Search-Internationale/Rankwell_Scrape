import { daysUntilEndOfMonth } from './calendar';

describe('daysUntilEndOfMonth', () => {
  it.each([
    ['31-day month, 26th', new Date(2026, 0, 26), 5],
    ['31-day month, last day', new Date(2026, 0, 31), 0],
    ['30-day month, 25th', new Date(2026, 3, 25), 5],
    ['30-day month, 26th is only 4 before', new Date(2026, 3, 26), 4],
    ['February 2026 (28 days), 23rd', new Date(2026, 1, 23), 5],
    ['February 2026, 28th is the last day', new Date(2026, 1, 28), 0],
    ['February 2028 (leap), 24th', new Date(2028, 1, 24), 5],
    ['December 26th (year boundary)', new Date(2026, 11, 26), 5],
    ['first of the month', new Date(2026, 8, 1), 29],
  ])('%s', (_label, date, expected) => {
    expect(daysUntilEndOfMonth(date)).toBe(expected);
  });
});
