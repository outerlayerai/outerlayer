/**
 * Constant-time string comparison for secret equality checks.
 *
 * XOR-accumulator implementation that always inspects every byte of the
 * shorter input regardless of mismatch position. Prevents remote attackers
 * from inferring a secret one byte at a time via response-time analysis.
 *
 * Length itself is not treated as secret — unequal lengths short-circuit
 * to `false`. For fixed-format tokens (API keys, HMAC secrets) this is
 * standard practice since length is public.
 *
 * Portable JS implementation (no `crypto.subtle.timingSafeEqual` — that is
 * Workers-only and breaks Node-based unit tests). Returns `false` for
 * `null`/`undefined` inputs so callers can drop it in for `a !== b`
 * without adding null checks.
 */
export function timingSafeEqualStrings(
  a: string | undefined | null,
  b: string | undefined | null,
): boolean {
  if (a == null || b == null) return false;
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}
