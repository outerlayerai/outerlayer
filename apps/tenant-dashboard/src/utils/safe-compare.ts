import { timingSafeEqual } from "node:crypto";

/**
 * Timing-safe string comparison.
 * Returns false immediately if lengths differ (unavoidable timing leak),
 * then uses `timingSafeEqual` for constant-time byte comparison.
 */
export function safeCompare(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}
