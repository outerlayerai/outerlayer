import { env } from '@/env';

/**
 * The email-domain half of the platform-admin boundary.
 *
 * Platform admin requires BOTH an allowed email domain and a `platform_user_role`
 * row. This module owns the first half only — every caller still has to check the
 * role table separately, and a matching domain alone grants nothing.
 *
 * Five surfaces need this check (the server guard, the server-action wrapper,
 * the role-grant action, the platform-admin API auth, and the client hook),
 * and a boundary duplicated that many times drifts: change four of five and
 * the surfaces disagree, which reads as a UI bug while hiding an
 * authorization gap. One source, one predicate, five importers.
 *
 * Isomorphic on purpose — the client hook and the React guard both need it, so
 * nothing here may import `server-only` or touch a server client.
 */

/**
 * Domains whose users may hold a platform role, from
 * `NEXT_PUBLIC_PLATFORM_ADMIN_EMAIL_DOMAIN` (comma-separated for more than one).
 *
 * Configured rather than hardcoded so a self-hoster can gate the platform-admin
 * surface on their own organization instead of inheriting ours. Accepting a list
 * is what makes a domain migration survivable: run both the old and new domain
 * for the cutover, then drop the old one — no code change, no window where
 * every existing admin is locked out.
 *
 * Adding a domain grants platform-admin eligibility to every account on it, so
 * it wants the same scrutiny as a permission grant.
 *
 * Entries are lowercased here; `isAllowedPlatformAdminEmail` lowercases the
 * address, so the comparison is case-insensitive on both sides.
 */
export function allowedPlatformAdminDomains(): string[] {
  return (env.NEXT_PUBLIC_PLATFORM_ADMIN_EMAIL_DOMAIN ?? '')
    .split(',')
    .map((domain) => domain.trim().toLowerCase())
    .filter((domain) => domain.length > 0);
}

/**
 * Whether `email` sits on an allowed platform-admin domain.
 *
 * Compared case-insensitively: the domain half of an address is case-insensitive
 * per RFC 5321, so a signup that capitalized it would otherwise be denied even
 * though it is the same mailbox. Matching is on the full `@domain` suffix, so a
 * lookalike like `user@outerlayer.ai.example.com` does not match, and neither
 * does a sibling registration like `user@notouterlayer.ai`.
 *
 * Returns false for null/undefined/empty rather than throwing — callers reach
 * this with whatever the session gave them, and a throw would surface as a 500
 * on an admin page instead of a clean denial. Likewise returns false when NO
 * domain is configured: "unconfigured" must never degrade to "every address
 * qualifies".
 */
export function isAllowedPlatformAdminEmail(email: string | null | undefined): boolean {
  if (!email) return false;
  const normalized = email.toLowerCase();
  return allowedPlatformAdminDomains().some((domain) => normalized.endsWith(domain));
}

/** Human-readable domain list for the denial messages callers surface. */
export function allowedPlatformAdminDomainsLabel(): string {
  return allowedPlatformAdminDomains().join(', ');
}
