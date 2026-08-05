/**
 * Coerce any timestamp shape we ever surface on the wire to ISO-8601 UTC (`...Z`).
 *
 * Every public-API response schema declares its timestamp fields as
 * `z.string().datetime()`, which only accepts a `Z` zone. The runtime values
 * we receive arrive in three drift-prone shapes that all violate that
 * contract until normalized — this helper is the single source of truth:
 *
 *   - **epoch-ms** (number or numeric string) — what a ClickHouse query
 *     returns for `toUnixTimestamp64Milli(Timestamp)`.
 *   - **zoneless ClickHouse datetime** (`'YYYY-MM-DD HH:mm:ss.SSS'`, optional
 *     sub-millisecond digits) — the default `FORMAT JSONEachRow`
 *     serialization for `DateTime64`, as returned by ClickHouse-backed routes.
 *   - **ISO-8601 with a numeric offset** (`'…+00:00'`) — how PostgREST
 *     serializes `timestamptz`. Hit by every Supabase-backed read endpoint
 *     (`/v1/environments`, `/v1/api-keys`, `/v1/apps`).
 *
 * Idempotent on already-`Z` ISO strings. Falls back to the raw stringified
 * input when it can't be parsed, so unexpected values surface in the
 * response rather than being silently swallowed.
 */
export function toIsoTimestamp(value: unknown): string {
  const raw = String(value).trim();
  // Epoch-ms — what the ClickHouse traces query serializes. Guard for
  // out-of-range numerics (Date clamps to ±8.64e15ms from epoch; anything
  // beyond becomes Invalid Date and `.toISOString()` would throw RangeError,
  // crashing the handler on a garbage input).
  if (/^\d+$/.test(raw)) {
    const epoch = new Date(Number(raw));
    return Number.isNaN(epoch.getTime()) ? raw : epoch.toISOString();
  }
  // Zoneless ClickHouse datetime — normalize space→T, trim sub-ms precision,
  // and append `Z` when there's no offset. ISO inputs (with `Z` or `+hh:mm`)
  // re-emit via Date#toISOString below, which forces the `Z` form.
  const normalized = raw.replace(' ', 'T').replace(/(\.\d{3})\d*$/, '$1');
  const withZone = /[zZ]|[+-]\d{2}:?\d{2}$/.test(normalized)
    ? normalized
    : `${normalized}Z`;
  const parsed = new Date(withZone);
  return Number.isNaN(parsed.getTime()) ? raw : parsed.toISOString();
}
