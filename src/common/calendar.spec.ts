import { daysUntilEndOfMonth, dailyShare } from './calendar';

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

describe('dailyShare', () => {
  const coveredOverMonth = (total: number, year: number, month: number) => {
    const lastDay = new Date(year, month + 1, 0).getDate();
    const seen: number[] = [];
    for (let day = 1; day <= lastDay; day++) {
      const { start, end } = dailyShare(total, new Date(year, month, day));
      for (let i = start; i < end; i++) seen.push(i);
    }
    return seen;
  };

  it.each([
    ['31-day month', 1997, 2026, 9],
    ['30-day month', 1997, 2026, 10],
    ['February (28 days)', 1997, 2026, 1],
    ['leap February (29 days)', 1997, 2028, 1],
    ['fewer items than days', 10, 2026, 9],
    ['exact multiple', 310, 2026, 9],
  ])('%s: every index checked exactly once', (_label, total, year, month) => {
    const seen = coveredOverMonth(total, year, month);
    expect(seen).toEqual(Array.from({ length: total }, (_, i) => i));
  });

  it('spreads the load evenly instead of front-loading it', () => {
    // 1997 over 31 days: 64 or 65 a day, never 200 on some days and 0 on others
    for (let day = 1; day <= 31; day++) {
      const { start, end } = dailyShare(1997, new Date(2026, 9, day));
      expect(end - start).toBeGreaterThanOrEqual(64);
      expect(end - start).toBeLessThanOrEqual(65);
    }
  });

  it('returns an empty range when there is nothing to check', () => {
    expect(dailyShare(0, new Date(2026, 9, 14))).toEqual({ start: 0, end: 0 });
  });
});
