import { describe, it, expect } from 'vitest';
import { toIsoTimestamp } from '../../lib/iso-date';

/**
 * Trace/span response schemas declare timestamps as z.string().datetime()
 * (ISO-8601), but ClickHouse returns epoch-ms (and older rows a zoneless
 * datetime string). toIsoTimestamp reconciles both to ISO so clients can
 * parse + time-filter reliably (GAP-0013).
 */
describe('toIsoTimestamp', () => {
  const ms = Date.UTC(2026, 4, 27, 14, 44, 46, 477); // 2026-05-27T14:44:46.477Z
  const ISO = '2026-05-27T14:44:46.477Z';

  it('formats epoch-ms (number) as ISO-8601 UTC', () => {
    expect(toIsoTimestamp(ms)).toBe(ISO);
  });

  it('formats epoch-ms (string — how ClickHouse serializes Int64) as ISO', () => {
    expect(toIsoTimestamp(String(ms))).toBe(ISO);
  });

  it('normalizes a zoneless ClickHouse datetime to ISO UTC', () => {
    expect(toIsoTimestamp('2026-05-27 14:44:46.477000000')).toBe(ISO);
  });

  it('is idempotent on an already-ISO string', () => {
    expect(toIsoTimestamp(ISO)).toBe(ISO);
  });

  it('returns the raw value when it cannot be parsed', () => {
    expect(toIsoTimestamp('not-a-date')).toBe('not-a-date');
  });

  // Date clamps to ±8.64e15 ms from epoch; anything beyond becomes Invalid Date
  // and `.toISOString()` would throw RangeError. The epoch-ms branch must guard
  // for that.
  it('returns the raw value for an out-of-range numeric string (no RangeError)', () => {
    const tooLarge = '99999999999999999999';
    // Returning the raw value (rather than throwing a RangeError) is the
    // regression contract — this assertion both exercises the no-throw path
    // and pins the fallback value.
    expect(toIsoTimestamp(tooLarge)).toBe(tooLarge);
  });
});
