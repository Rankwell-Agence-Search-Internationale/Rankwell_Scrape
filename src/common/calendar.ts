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
