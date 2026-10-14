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
 * The slice [start, end) of a `total`-item list that `date` is responsible for
 * when the list is spread evenly over its month. Every index falls in exactly
 * one day of any month length, and daily sizes differ by at most one, so a
 * list checked this way is fully covered each month without idle days.
 */
export function dailyShare(total: number, date: Date = new Date()): { start: number; end: number } {
  const daysInMonth = new Date(date.getFullYear(), date.getMonth() + 1, 0).getDate();
  const day = date.getDate();
  return {
    start: Math.floor(((day - 1) * total) / daysInMonth),
    end: Math.floor((day * total) / daysInMonth),
  };
}
