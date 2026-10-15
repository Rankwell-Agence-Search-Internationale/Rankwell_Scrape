/**
 * Netlinks bought before a cutoff are not worth re-checking: the contracts are
 * long over, and they would otherwise take up most of each day's share.
 *
 * `creation_date` is the field to filter on. `period_date` looks like the
 * natural choice but is NULL on about 70% of netlinks and has no value at all
 * from 2025 onwards, so a cutoff applied to it silently drops everything.
 */

/** Netlinks created before this are never checked. Override: NETLINK_MIN_DATE. */
export const DEFAULT_NETLINK_MIN_DATE = '2025-01-01';

/**
 * A netlink is in the window when its creation_date is on or after `minDate`.
 * One with no usable date is kept: dropping it would hide it forever, and a
 * missing date is a data gap rather than evidence the netlink is old.
 */
export function isWithinWindow(
  netlink: { creation_date?: string | Date | null },
  minDate: Date,
): boolean {
  const raw = netlink?.creation_date;
  if (!raw) return true;
  const created = raw instanceof Date ? raw : new Date(raw);
  if (Number.isNaN(created.getTime())) return true;
  return created.getTime() >= minDate.getTime();
}

/**
 * Parse the configured cutoff. An unparseable value falls back to the default
 * rather than throwing, so a typo cannot stop the nightly job.
 */
export function parseMinDate(value?: string): Date {
  const parsed = new Date(value || DEFAULT_NETLINK_MIN_DATE);
  return Number.isNaN(parsed.getTime()) ? new Date(DEFAULT_NETLINK_MIN_DATE) : parsed;
}
