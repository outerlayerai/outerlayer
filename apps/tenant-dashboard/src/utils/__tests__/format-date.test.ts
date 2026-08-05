import { describe, expect, it } from 'vitest';

import {
  DATE_FORMAT_OPTIONS,
  formatLocalDate,
  RESERVED_CH,
  type LocalDateFormat,
} from '../format-date';

/* These assert on SHAPE and on the absence of a pinned timezone rather than on
 * exact clock strings, because the correct rendering depends on the host's own
 * zone and locale — which is the whole point of formatting client-side.
 *
 * Reassigning `process.env.TZ` mid-run is not an option: under this runner it
 * does not reach `Intl`, so a formatter built afterwards still resolves the
 * original zone and a "different timezone" test would pass while proving
 * nothing. */

const AT = '2026-07-30T14:45:07Z';
const SHAPES: Record<LocalDateFormat, RegExp> = {
  /* These pin the en-US ordering the test runner produces — month name first,
   * then day, then year. They are NOT locale-agnostic: a runner under de-DE
   * emits "30. Juli 2026" and would fail them. That is an accepted bound, since
   * the point of these is to catch a change to the FIELD SELECTION, and the
   * runner's locale is fixed. Month abbreviations vary in length (3-5 chars
   * with an optional period) even within en, hence the loose letter class. */
  dateTime: /^[A-Za-z]{3,5}\.? \d{1,2}, \d{4}, \d{1,2}:\d{2}(:\d{2})?( [AP]M)?$/,
  date: /^[A-Za-z]{3,5}\.? \d{1,2}, \d{4}$/,
  monthDayTime: /^[A-Za-z]{3,5}\.? \d{1,2}, \d{1,2}:\d{2}( [AP]M)?$/,
  monthDay: /^[A-Za-z]{3,5}\.? \d{1,2}$/,
  numericDate: /^\d{1,2}\/\d{1,2}\/\d{4}$/,
  numericDateTime: /^\d{1,2}\/\d{1,2}\/\d{4}, \d{1,2}:\d{2}:\d{2}( [AP]M)?$/,
  // Bare hour: "2 PM" in en-US, a 24-hour number plus locale trimmings elsewhere.
  hour: /^\d{1,2}(\D.*)?$/,
};

describe('formatLocalDate', () => {
  /* The regression this guards is someone adding `timeZone: 'UTC'` to a format
   * to make it deterministic: it would render every visitor a clock time that
   * is not theirs, and a date-only format would put a near-midnight timestamp
   * on the wrong day. Checking the options directly catches that on any host,
   * including a CI runner that already sits in UTC and where a behavioural
   * assertion would pass vacuously. */
  it('pins no timezone in any format, leaving the visitor own zone to format the value', () => {
    for (const [name, options] of Object.entries(DATE_FORMAT_OPTIONS)) {
      expect(options.timeZone, `${name} must not pin a timezone`).toBeUndefined();
    }
  });

  it('pins no locale either, so the separators follow the visitor', () => {
    // A pinned locale would show a German visitor "Jul 30" mid-sentence.
    const reference = new Intl.DateTimeFormat(undefined, DATE_FORMAT_OPTIONS.monthDayTime);
    expect(formatLocalDate(AT, 'monthDayTime')).toBe(reference.format(new Date(AT)));
  });

  it('renders each format to its documented shape', () => {
    for (const format of Object.keys(SHAPES) as LocalDateFormat[]) {
      expect(formatLocalDate(AT, format), format).toMatch(SHAPES[format]);
    }
  });

  it('renders the same instant identically however it is expressed', () => {
    const millis = Date.parse(AT);
    expect(formatLocalDate(millis, 'numericDateTime')).toBe(formatLocalDate(AT, 'numericDateTime'));
    expect(formatLocalDate(new Date(millis), 'numericDateTime')).toBe(
      formatLocalDate(AT, 'numericDateTime')
    );
  });

  it('returns null for every value with no real timestamp behind it', () => {
    expect(formatLocalDate(null, 'date')).toBeNull();
    expect(formatLocalDate(undefined, 'date')).toBeNull();
    expect(formatLocalDate('', 'date')).toBeNull();
    expect(formatLocalDate('not a date', 'date')).toBeNull();
    expect(formatLocalDate(Number.NaN, 'date')).toBeNull();
  });

  /* The placeholder must be at least as wide as the value that replaces it or
   * the fill-in reflows its line. December plus a two-digit day and a 12-hour
   * clock reading "12" is the widest en-US rendering; a locale with longer
   * month names or a longer time pattern can still exceed it, so this bounds
   * the common case rather than guaranteeing every locale. */
  it('reserves at least the width the widest rendering needs', () => {
    for (const format of Object.keys(RESERVED_CH) as LocalDateFormat[]) {
      const widest = formatLocalDate('2026-12-30T12:45:07Z', format)!;
      expect(widest.length, `${format} renders ${widest.length} chars`).toBeLessThanOrEqual(
        RESERVED_CH[format]
      );
    }
  });
});
