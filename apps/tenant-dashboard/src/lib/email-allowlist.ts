/**
 * Email allowlist matching for `EMAIL_RECIPIENT_ALLOWLIST` — which recipients a
 * deployment will actually deliver to.
 *
 * Pure and free of `server-only`, so the matching is testable on its own and
 * reusable if another seam ever needs the same address-or-domain syntax. Env
 * reading stays with the caller.
 */

/**
 * Allowlist entries, normalized to lowercase. Comma-separated; an entry is
 * either a whole address (`someone@example.com`) or a domain suffix written
 * with its leading `@` (`@example.com`).
 *
 * An empty result means unrestricted. That is the hosted-production posture for
 * both seams, and it is why the default is open rather than closed: a missing
 * var must never silently stop customer mail or lock out customer signups.
 * A non-empty value is for a deployment serving a known, bounded set of humans
 * — staging dogfooding — where anything else is by definition a mistake.
 */
export function parseEmailAllowlist(raw: string | undefined): string[] {
  return (raw ?? '')
    .split(',')
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry.length > 0);
}

/**
 * Whether `email` is permitted under `allowlist`. An empty allowlist permits
 * everything (see {@link parseEmailAllowlist}).
 *
 * Domain entries match on the `@domain` suffix, so `@example.com` covers
 * `a@example.com` but NOT `a@evil-example.com` or `a@sub.example.com` — the
 * `@` is part of the comparison precisely so a lookalike domain ending in the
 * allowed one can't slip through.
 */
export function isEmailAllowed(email: string, allowlist: string[]): boolean {
  if (allowlist.length === 0) return true;
  const normalized = email.trim().toLowerCase();
  return allowlist.some((entry) =>
    entry.startsWith('@') ? normalized.endsWith(entry) : normalized === entry
  );
}
