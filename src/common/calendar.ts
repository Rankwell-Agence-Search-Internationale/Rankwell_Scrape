/**
 * Days from `date` to the last day of its month: 0 on the last day, 5 on the
 * 26th of a 31-day month, the 25th of a 30-day one, or the 23rd of February
 * (24th in a leap year). Month-relative schedules use this instead of a fixed
 * day-of-month so "N days before month end" lands on the right date.
 */
export function daysUntilEndOfMonth(date: Date = new Date()): number {
  const lastDay = new Date(date.getFullYear(), date.getMonth() + 1, 0).getDate();
  return lastDay - date.getDate();
}

/**
 * The `size` items that `date` is responsible for when a list is worked
 * through at a fixed rate, continuing where the previous day left off and
 * wrapping to the front when it reaches the end.
 *
 * Indexing by days-since-epoch rather than day-of-month keeps the rotation
 * continuous across month boundaries, so no netlink is skipped or checked
 * twice because a month was short.
 *
 * The window wraps, so it is returned as explicit indices rather than a
 * [start, end) range: `[0, 50)` plus `[1100, 1164)` cannot be expressed as one
 * slice.
 */
export function dailyBatch(
  total: number,
  size: number,
  date: Date = new Date(),
): number[] {
  if (total <= 0 || size <= 0) return [];
  if (size >= total) return Array.from({ length: total }, (_, i) => i);

  const dayIndex = Math.floor(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) / 86400000);
  const start = ((dayIndex * size) % total + total) % total;
  return Array.from({ length: size }, (_, i) => (start + i) % total);
}
