/**
 * Date Utilities for ClickHouse
 * Feature: 007-analytics-architecture-evaluation
 *
 * Handles date formatting for ClickHouse DateTime64 compatibility.
 * ClickHouse DateTime64 cannot parse ISO 8601 format with 'T' separator and 'Z' suffix.
 */

/**
 * Formats a Date object for ClickHouse DateTime64 queries.
 *
 * ClickHouse DateTime64 expects format: 'YYYY-MM-DD HH:mm:ss.SSS'
 * JavaScript toISOString() returns: '2024-01-15T22:02:33.664Z'
 *
 * This function converts ISO format to ClickHouse-compatible format
 * by replacing 'T' with a space and removing 'Z'.
 *
 * @param date - Date object to format
 * @returns Formatted date string for ClickHouse DateTime64
 *
 * @example
 * ```typescript
 * const date = new Date('2024-01-15T22:02:33.664Z');
 * formatDateForClickHouse(date);
 * // Returns: '2024-01-15 22:02:33.664'
 * ```
 */
export function formatDateForClickHouse(date: Date): string {
  return date.toISOString().replace('T', ' ').replace('Z', '');
}

/**
 * Formats an ISO date string for ClickHouse DateTime64 queries.
 *
 * If the input is already in ClickHouse-compatible format (no 'T' or 'Z'),
 * it returns the string unchanged.
 *
 * @param isoString - ISO 8601 date string (e.g., '2024-01-15T22:02:33.664Z')
 * @returns Formatted date string for ClickHouse DateTime64
 *
 * @example
 * ```typescript
 * formatISOForClickHouse('2024-01-15T22:02:33.664Z');
 * // Returns: '2024-01-15 22:02:33.664'
 *
 * formatISOForClickHouse('2024-01-15 22:02:33.664');
 * // Returns: '2024-01-15 22:02:33.664' (unchanged)
 * ```
 */
export function formatISOForClickHouse(isoString: string): string {
  return isoString.replace('T', ' ').replace('Z', '');
}

/**
 * Gets the default start date for traces queries (7 days ago).
 * Returns in ClickHouse-compatible format.
 */
export function getDefaultTracesStartDate(): string {
  return formatDateForClickHouse(new Date(Date.now() - 7 * 24 * 60 * 60 * 1000));
}

/**
 * Gets the default start date for sessions queries (7 days ago).
 * Returns in ClickHouse-compatible format.
 */
export function getDefaultSessionsStartDate(): string {
  return formatDateForClickHouse(new Date(Date.now() - 7 * 24 * 60 * 60 * 1000));
}

/**
 * Gets the current date/time in ClickHouse-compatible format.
 */
export function getCurrentDateForClickHouse(): string {
  return formatDateForClickHouse(new Date());
}

/**
 * Converts a ClickHouse DateTime64 string back to ISO 8601.
 *
 * ClickHouse returns timestamps as 'YYYY-MM-DD HH:mm:ss.SSS' (space
 * separator, no zone). OpenAPI `format: date-time` requires ISO 8601
 * with a 'T' separator and explicit zone (we use 'Z' — the CH values
 * are stored in UTC per the schema).
 *
 * Inputs that already look ISO-ish (contain 'T' or end in 'Z') pass
 * through unchanged. Empty/nullish inputs return an empty string so
 * callers can still spread the field into a response object without
 * conditional branching.
 *
 * @example
 * clickHouseToISO('2024-01-15 22:02:33.664') // '2024-01-15T22:02:33.664Z'
 * clickHouseToISO('2024-01-15T22:02:33.664Z') // unchanged
 */
export function clickHouseToISO(value: string | null | undefined): string {
  if (!value) return '';
  if (value.includes('T') || value.endsWith('Z')) return value;
  return `${value.replace(' ', 'T')}Z`;
}

/**
 * Converts an ISO 8601 datetime to a ClickHouse `Date` literal (UTC).
 *
 * Several analytics queries filter on `toDate(Timestamp) >= {startDate:Date}`
 * because they hit the `proj_hourly` / `proj_by_model` / `proj_by_user`
 * projections, which are keyed on `toDate(Timestamp)`. ClickHouse's `Date`
 * parser rejects anything beyond `YYYY-MM-DD`, so we can't bind an ISO
 * string directly — Schemathesis caught this by passing
 * `2000-01-01T00:00:00Z` and crashing the query with "only 10 of 20 bytes
 * was parsed".
 *
 * This helper is the one correct normalization:
 *  - Parses via `new Date()` so timezone offsets are resolved (if the
 *    schema ever accepts them — today's `z.string().datetime()` without
 *    `{offset:true}` only allows 'Z', but we shouldn't bake that assumption
 *    in).
 *  - Emits UTC date so the downstream Date comparison is in the same zone
 *    as the stored `Timestamp` values.
 *  - Throws on invalid input rather than silently passing garbage — the
 *    handler's Zod validation should catch this first, but the throw is
 *    defense-in-depth for direct service callers (tests, internal code).
 *
 * @example
 * isoToClickHouseDate('2024-01-15T00:00:00Z')       // '2024-01-15'
 * isoToClickHouseDate('2024-01-15T23:00:00-05:00')  // '2024-01-16' (UTC)
 * isoToClickHouseDate('2024-01-15')                 // '2024-01-15' (passthrough)
 */
export function isoToClickHouseDate(iso: string): string {
  // Short-circuit for date-only strings to avoid unnecessary Date parsing
  // (and its inherent lossy handling of pure YYYY-MM-DD as "midnight
  // local" on some engines).
  if (/^\d{4}-\d{2}-\d{2}$/.test(iso)) return iso;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) {
    throw new Error(`isoToClickHouseDate: invalid date string: ${iso}`);
  }
  return d.toISOString().slice(0, 10);
}
