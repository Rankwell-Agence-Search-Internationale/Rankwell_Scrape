import { dailyBatch, daysUntilEndOfMonth } from './calendar';

describe('daysUntilEndOfMonth', () => {
  it.each([
    ['31-day month, 26th', new Date(2026, 0, 26), 5],
    ['31-day month, last day', new Date(2026, 0, 31), 0],
    ['30-day month, 25th', new Date(2026, 3, 25), 5],
    ['30-day month, 26th is only 4 before', new Date(2026, 3, 26), 4],
    ['February 2026 (28 days), 23rd', new Date(2026, 1, 23), 5],
    ['February 2028 (leap), 24th', new Date(2028, 1, 24), 5],
    ['December 26th (year boundary)', new Date(2026, 11, 26), 5],
  ])('%s', (_label, date, expected) => {
    expect(daysUntilEndOfMonth(date)).toBe(expected);
  });
});

describe('dailyBatch', () => {
  const day = (n: number) => new Date(2026, 0, n);

  it('takes exactly `size` items', () => {
    expect(dailyBatch(1164, 200, day(1))).toHaveLength(200);
  });

  it('continues where the previous day stopped', () => {
    const d1 = dailyBatch(1164, 200, day(1));
    const d2 = dailyBatch(1164, 200, day(2));
    expect(d2[0]).toBe((d1[199] + 1) % 1164);
  });

  it('wraps past the end instead of running short', () => {
    const batch = dailyBatch(10, 4, day(1));
    expect(batch).toHaveLength(4);
    expect(new Set(batch).size).toBe(4);
    expect(Math.max(...batch)).toBeLessThan(10);
  });

  it('covers every index within ceil(total/size) days', () => {
    const total = 1164, size = 200;
    const seen = new Set<number>();
    for (let d = 1; d <= Math.ceil(total / size); d++) {
      dailyBatch(total, size, day(d)).forEach(i => seen.add(i));
    }
    expect(seen.size).toBe(total);
  });

  it('stays continuous across a month boundary', () => {
    const jan31 = dailyBatch(1164, 200, new Date(2026, 0, 31));
    const feb1 = dailyBatch(1164, 200, new Date(2026, 1, 1));
    expect(feb1[0]).toBe((jan31[199] + 1) % 1164);
  });

  it('returns every index, once, when the list is smaller than a batch', () => {
    expect(dailyBatch(5, 200, day(1))).toEqual([0, 1, 2, 3, 4]);
  });

  it.each([[0, 200], [1164, 0], [0, 0]])('is empty for total=%i size=%i', (total, size) => {
    expect(dailyBatch(total, size, day(1))).toEqual([]);
  });
});
