/**
 * Relative-time shaping for the adoption overlays' "last used" annotations.
 * Pure so the bucketing (minutes/hours/days, and the boundaries between them)
 * is asserted directly; the components only translate the returned parts.
 *
 * Timestamps arrive as ClickHouse `YYYY-MM-DD HH:MM:SS` strings in UTC.
 * The unit ceiling is days — adoption data has a 90-day horizon, so month or
 * year units would never be exercised honestly.
 */

interface RelativeTimeParts {
  unit: "now" | "minutes" | "hours" | "days";
  count: number;
}

/** Epoch millis for a ClickHouse UTC timestamp string, or `null` if unparseable. */
export function parseAdoptionTimestamp(raw: string | null): number | null {
  if (!raw) return null;
  const ms = Date.parse(`${raw.replace(" ", "T")}Z`);
  return Number.isNaN(ms) ? null : ms;
}

/**
 * Bucketed distance from `nowMs` back to `raw`. `null` when the timestamp is
 * absent or unparseable — the caller renders nothing rather than a fake time.
 * A timestamp in the future (clock skew) clamps to "now".
 */
export function relativeTimeParts(raw: string | null, nowMs: number): RelativeTimeParts | null {
  const ms = parseAdoptionTimestamp(raw);
  if (ms === null) return null;
  const deltaMin = Math.floor((nowMs - ms) / 60_000);
  if (deltaMin < 1) return { unit: "now", count: 0 };
  if (deltaMin < 60) return { unit: "minutes", count: deltaMin };
  const deltaHours = Math.floor(deltaMin / 60);
  if (deltaHours < 24) return { unit: "hours", count: deltaHours };
  return { unit: "days", count: Math.floor(deltaHours / 24) };
}
