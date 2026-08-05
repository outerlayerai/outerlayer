/**
 * Date formatting in the visitor's own timezone.
 *
 * A date formatted with no explicit locale and timezone resolves against the
 * ambient ones, and those differ between the SSR process and the browser: the
 * server renders one string, the client another, and React reports a hydration
 * mismatch. With a date-only format the divergence is worse than cosmetic — a
 * near-midnight timestamp lands on a different DAY either side.
 *
 * So these formatters run only after mount, in the browser, where the ambient
 * locale and timezone ARE the visitor's. Render them through `LocalDate`
 * (components/local-date) rather than calling them during render: it owns the
 * after-mount guard and reserves the final width so the fill-in shifts nothing.
 *
 * Each format spells its fields out instead of leaning on a locale default, so
 * the STRUCTURE is fixed and only the ordering and separators follow the
 * visitor's locale.
 */

export type LocalDateFormat =
  /** Jul 30, 2026, 02:45 PM */
  | 'dateTime'
  /** Jul 30, 2026 */
  | 'date'
  /** Jul 30, 2:45 PM */
  | 'monthDayTime'
  /** Jul 30 */
  | 'monthDay'
  /** 7/30/2026 */
  | 'numericDate'
  /** 7/30/2026, 2:45:00 PM */
  | 'numericDateTime'
  /** 2 PM */
  | 'hour';

/** Field selection per format. Deliberately free of `timeZone` and of a
 * locale: both must stay ambient so the visitor's own settings format the
 * value. */
export const DATE_FORMAT_OPTIONS: Record<LocalDateFormat, Intl.DateTimeFormatOptions> = {
  dateTime: { month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit' },
  date: { month: 'short', day: 'numeric', year: 'numeric' },
  monthDayTime: { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' },
  monthDay: { month: 'short', day: 'numeric' },
  numericDate: { year: 'numeric', month: 'numeric', day: 'numeric' },
  hour: { hour: 'numeric' },
  numericDateTime: {
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    second: '2-digit',
  },
};

/**
 * Character budget per format, for the placeholder that holds the line's width
 * until the real value lands. Sized to the widest en-US rendering — December,
 * a two-digit day, a 12-hour clock reading "12" — since over-reserving costs a
 * few trailing pixels while under-reserving costs a reflow. A locale with
 * longer month names can still exceed it; this bounds the common case rather
 * than guaranteeing every locale.
 */
export const RESERVED_CH: Record<LocalDateFormat, number> = {
  dateTime: 24,
  date: 14,
  monthDayTime: 17,
  monthDay: 8,
  numericDate: 11,
  numericDateTime: 23,
  hour: 8,
};

/* Built on first use rather than at module scope: constructing an
 * `Intl.DateTimeFormat` is expensive, and the server bundle would otherwise
 * build every format on import to serve values it never renders. Caching keeps
 * the cost to once per format in the browser, where the formatting happens.
 * (Zone capture is not the concern — server and client load separate module
 * instances, so a browser-side formatter reads the browser's zone whenever it
 * is built.) */
const formatters = new Map<LocalDateFormat, Intl.DateTimeFormat>();

function formatterFor(format: LocalDateFormat): Intl.DateTimeFormat {
  const cached = formatters.get(format);
  if (cached) return cached;
  const made = new Intl.DateTimeFormat(undefined, DATE_FORMAT_OPTIONS[format]);
  formatters.set(format, made);
  return made;
}

export type LocalDateValue = string | number | Date | null | undefined;

/**
 * The visitor-local rendering, or `null` when there is nothing real to show —
 * absent, empty, or unparseable input. Callers choose their own absent-value
 * mark rather than inheriting a placeholder from here.
 */
export function formatLocalDate(value: LocalDateValue, format: LocalDateFormat): string | null {
  if (value === null || value === undefined || value === '') return null;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return formatterFor(format).format(date);
}
