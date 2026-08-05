/**
 * Date Utilities Tests
 * Feature: 007-analytics-architecture-evaluation
 *
 * Tests for ClickHouse date formatting utilities.
 *
 * Background: ClickHouse DateTime64 cannot parse ISO 8601 format with
 * 'T' separator and 'Z' timezone suffix. The error is:
 * "Value 2024-01-15T22:02:33.664Z cannot be parsed as DateTime64"
 */

import {
  formatDateForClickHouse,
  formatISOForClickHouse,
  getDefaultTracesStartDate,
  getDefaultSessionsStartDate,
  getCurrentDateForClickHouse,
  clickHouseToISO,
  isoToClickHouseDate,
} from '../date-utils';

describe('formatDateForClickHouse', () => {
  it('should convert Date to ClickHouse DateTime64 format', () => {
    const date = new Date('2024-01-15T22:02:33.664Z');
    const result = formatDateForClickHouse(date);

    expect(result).toBe('2024-01-15 22:02:33.664');
  });

  it('should remove T separator', () => {
    const date = new Date('2024-06-01T12:00:00.000Z');
    const result = formatDateForClickHouse(date);

    expect(result).not.toContain('T');
    expect(result).toContain(' ');
  });

  it('should remove Z timezone suffix', () => {
    const date = new Date('2024-06-01T12:00:00.000Z');
    const result = formatDateForClickHouse(date);

    expect(result).not.toContain('Z');
  });

  it('should preserve millisecond precision', () => {
    const date = new Date('2024-01-15T22:02:33.123Z');
    const result = formatDateForClickHouse(date);

    expect(result).toContain('.123');
  });

  it('should handle midnight correctly', () => {
    const date = new Date('2024-01-01T00:00:00.000Z');
    const result = formatDateForClickHouse(date);

    expect(result).toBe('2024-01-01 00:00:00.000');
  });

  it('should handle end of day correctly', () => {
    const date = new Date('2024-12-31T23:59:59.999Z');
    const result = formatDateForClickHouse(date);

    expect(result).toBe('2024-12-31 23:59:59.999');
  });
});

describe('formatISOForClickHouse', () => {
  it('should convert ISO string to ClickHouse format', () => {
    const result = formatISOForClickHouse('2024-01-15T22:02:33.664Z');

    expect(result).toBe('2024-01-15 22:02:33.664');
  });

  it('should handle string without milliseconds', () => {
    const result = formatISOForClickHouse('2024-01-15T22:02:33Z');

    expect(result).toBe('2024-01-15 22:02:33');
  });

  it('should leave already-formatted string unchanged', () => {
    const alreadyFormatted = '2024-01-15 22:02:33.664';
    const result = formatISOForClickHouse(alreadyFormatted);

    expect(result).toBe(alreadyFormatted);
  });

  it('should handle date-only strings', () => {
    const result = formatISOForClickHouse('2024-01-15');

    expect(result).toBe('2024-01-15');
  });
});

describe('getDefaultTracesStartDate', () => {
  it('should return date 7 days ago in ClickHouse format', () => {
    const before = Date.now();
    const result = getDefaultTracesStartDate();
    const after = Date.now();

    // Should not contain T or Z
    expect(result).not.toContain('T');
    expect(result).not.toContain('Z');

    // Should be a valid date string approximately 7 days ago
    const parsedResult = new Date(result.replace(' ', 'T') + 'Z');
    const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;
    expect(parsedResult.getTime()).toBeGreaterThanOrEqual(before - sevenDaysMs - 1000);
    expect(parsedResult.getTime()).toBeLessThanOrEqual(after - sevenDaysMs + 1000);
  });
});

describe('getDefaultSessionsStartDate', () => {
  it('should return date 7 days ago in ClickHouse format', () => {
    const before = Date.now();
    const result = getDefaultSessionsStartDate();
    const after = Date.now();

    // Should not contain T or Z
    expect(result).not.toContain('T');
    expect(result).not.toContain('Z');

    // Should be a valid date string approximately 7 days ago
    const parsedResult = new Date(result.replace(' ', 'T') + 'Z');
    const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;
    expect(parsedResult.getTime()).toBeGreaterThanOrEqual(before - sevenDaysMs - 1000);
    expect(parsedResult.getTime()).toBeLessThanOrEqual(after - sevenDaysMs + 1000);
  });
});

describe('getCurrentDateForClickHouse', () => {
  it('should return current date in ClickHouse format', () => {
    const before = Date.now();
    const result = getCurrentDateForClickHouse();
    const after = Date.now();

    // Should not contain T or Z
    expect(result).not.toContain('T');
    expect(result).not.toContain('Z');

    // Should be approximately now
    const parsedResult = new Date(result.replace(' ', 'T') + 'Z');
    expect(parsedResult.getTime()).toBeGreaterThanOrEqual(before - 1000);
    expect(parsedResult.getTime()).toBeLessThanOrEqual(after + 1000);
  });
});

describe('clickHouseToISO', () => {
  it('converts CH space-separated format to ISO 8601 with Z', () => {
    expect(clickHouseToISO('2024-01-15 22:02:33.664')).toBe('2024-01-15T22:02:33.664Z');
  });

  it('passes through strings that already look ISO', () => {
    expect(clickHouseToISO('2024-01-15T22:02:33.664Z')).toBe('2024-01-15T22:02:33.664Z');
    expect(clickHouseToISO('2024-01-15T22:02:33Z')).toBe('2024-01-15T22:02:33Z');
  });

  it('returns empty string for null/undefined/empty — safe to spread', () => {
    expect(clickHouseToISO(null)).toBe('');
    expect(clickHouseToISO(undefined)).toBe('');
    expect(clickHouseToISO('')).toBe('');
  });
});

describe('isoToClickHouseDate', () => {
  it('extracts UTC date from ISO 8601 with Z', () => {
    expect(isoToClickHouseDate('2024-01-15T22:02:33.664Z')).toBe('2024-01-15');
    expect(isoToClickHouseDate('2024-01-15T00:00:00Z')).toBe('2024-01-15');
  });

  it('normalizes offset timezones to UTC — critical for correctness when schema accepts offsets', () => {
    // UTC-5 at 23:00 is UTC+0 04:00 the NEXT day — naive slicing would miss this.
    expect(isoToClickHouseDate('2024-01-15T23:00:00-05:00')).toBe('2024-01-16');
    // UTC+8 at 03:00 is UTC+0 19:00 the PREVIOUS day.
    expect(isoToClickHouseDate('2024-01-15T03:00:00+08:00')).toBe('2024-01-14');
  });

  it('passes through date-only strings unchanged (no Date parsing — avoids engine-specific local-TZ surprises)', () => {
    expect(isoToClickHouseDate('2024-01-15')).toBe('2024-01-15');
  });

  it('throws on garbage input rather than silently producing bad queries', () => {
    expect(() => isoToClickHouseDate('not-a-date')).toThrow(/invalid date string/);
    expect(() => isoToClickHouseDate('')).toThrow(/invalid date string/);
  });

  it('converts a full ISO instant, the shape that crashes an unconverted query', () => {
    // Passing `2000-01-01T00:00:00Z` raw to a `{startDate:Date}` param
    // crashes the /v1/metrics query; it must be narrowed to a date first.
    expect(isoToClickHouseDate('2000-01-01T00:00:00Z')).toBe('2000-01-01');
  });
});

describe('ClickHouse DateTime64 compatibility', () => {
  it('should produce format that ClickHouse can parse', () => {
    // This test documents the expected format for ClickHouse DateTime64
    // Format: 'YYYY-MM-DD HH:mm:ss.SSS'
    const result = formatDateForClickHouse(new Date('2024-01-15T22:02:33.664Z'));

    // Verify format with regex
    const clickHouseFormat = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3}$/;
    expect(result).toMatch(clickHouseFormat);
  });

  it('should handle the exact error case from production', () => {
    // This is the actual error we saw:
    // "Value 2026-01-15T22:02:33.664Z cannot be parsed as DateTime64"
    const problematicDate = '2026-01-15T22:02:33.664Z';
    const result = formatISOForClickHouse(problematicDate);

    // The result should NOT have the problematic characters
    expect(result).toBe('2026-01-15 22:02:33.664');
    expect(result).not.toContain('T');
    expect(result).not.toContain('Z');
  });
});
