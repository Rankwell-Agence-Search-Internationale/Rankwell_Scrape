import {
  DEFAULT_NETLINK_MIN_DATE,
  isWithinWindow,
  parseMinDate,
} from './netlink-window';

const cutoff = new Date('2025-01-01');

describe('isWithinWindow', () => {
  it.each([
    ['exactly the cutoff', '2025-01-01T00:00:00.000Z', true],
    ['after the cutoff', '2026-10-15', true],
    ['the day before', '2024-12-31T23:59:59.000Z', false],
    ['years before', '2021-06-02', false],
  ])('%s -> %s', (_label, creation_date, expected) => {
    expect(isWithinWindow({ creation_date }, cutoff)).toBe(expected);
  });

  it('accepts a Date as well as a string', () => {
    expect(isWithinWindow({ creation_date: new Date('2025-06-01') }, cutoff)).toBe(true);
    expect(isWithinWindow({ creation_date: new Date('2024-06-01') }, cutoff)).toBe(false);
  });

  it.each([
    ['null', null],
    ['undefined', undefined],
    ['empty string', ''],
    ['unparseable', 'not-a-date'],
  ])('keeps a netlink whose date is %s, rather than hiding it forever', (_l, creation_date) => {
    expect(isWithinWindow({ creation_date } as any, cutoff)).toBe(true);
  });
});

describe('parseMinDate', () => {
  it('uses the configured value', () => {
    expect(parseMinDate('2026-03-01').toISOString()).toBe('2026-03-01T00:00:00.000Z');
  });

  it.each([undefined, '', 'tomorrow-ish'])('falls back to the default for %p', value => {
    expect(parseMinDate(value).toISOString()).toBe(
      new Date(DEFAULT_NETLINK_MIN_DATE).toISOString(),
    );
  });
});
