/**
 * The email-domain half of the platform-admin boundary.
 *
 * This predicate is the single gate five surfaces consult (server guard,
 * server-action wrapper, role-grant action, platform-admin API auth, client
 * hook), so a
 * false positive here grants platform-admin eligibility everywhere at once. The
 * cases below pin both directions: exactly the configured domain is admitted,
 * and every near-miss shape is refused.
 *
 * The bug class the `@` prefix guards against is a lookalike suffix match — a
 * bare `outerlayer.ai` would admit `attacker@notouterlayer.ai`.
 *
 * `@/env` is a true seam here — t3-env reads process.env at module load, so the
 * test sets the resolved value directly rather than mutating process.env and
 * reasoning about import order.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// vi.hoisted: the vi.mock factory is hoisted above the module body, so the
// object it returns cannot be a plain top-level const.
const mockEnv = vi.hoisted(() => ({ NEXT_PUBLIC_PLATFORM_ADMIN_EMAIL_DOMAIN: '@outerlayer.ai' }));

vi.mock('@/env', () => ({ env: mockEnv }));

import {
  allowedPlatformAdminDomains,
  allowedPlatformAdminDomainsLabel,
  isAllowedPlatformAdminEmail,
} from '../platform-admin-domain';

beforeEach(() => {
  mockEnv.NEXT_PUBLIC_PLATFORM_ADMIN_EMAIL_DOMAIN = '@outerlayer.ai';
});

describe('allowedPlatformAdminDomains', () => {
  it('defaults to exactly the outerlayer.ai domain', () => {
    // Pinned as an exact list, not a length check: adding a domain grants
    // platform-admin eligibility to every account on it, so a new entry should
    // fail here and be reviewed rather than slip in.
    expect(allowedPlatformAdminDomains()).toEqual(['@outerlayer.ai']);
  });

  it('parses a comma-separated list, trimming and lowercasing each entry', () => {
    mockEnv.NEXT_PUBLIC_PLATFORM_ADMIN_EMAIL_DOMAIN = ' @OuterLayer.ai , @agentmark.co ';

    expect(allowedPlatformAdminDomains()).toEqual(['@outerlayer.ai', '@agentmark.co']);
  });

  it('drops empty entries from a trailing or doubled comma', () => {
    mockEnv.NEXT_PUBLIC_PLATFORM_ADMIN_EMAIL_DOMAIN = '@outerlayer.ai,,';

    expect(allowedPlatformAdminDomains()).toEqual(['@outerlayer.ai']);
  });

  it('renders the domains for denial copy', () => {
    expect(allowedPlatformAdminDomainsLabel()).toBe('@outerlayer.ai');

    mockEnv.NEXT_PUBLIC_PLATFORM_ADMIN_EMAIL_DOMAIN = '@outerlayer.ai,@agentmark.co';
    expect(allowedPlatformAdminDomainsLabel()).toBe('@outerlayer.ai, @agentmark.co');
  });
});

describe('isAllowedPlatformAdminEmail', () => {
  it('admits an address on the allowed domain', () => {
    expect(isAllowedPlatformAdminEmail('ryan@outerlayer.ai')).toBe(true);
  });

  it('admits the domain in any casing', () => {
    // The domain half of an address is case-insensitive (RFC 5321). A
    // case-sensitive check would deny the same mailbox purely on how the user
    // typed it at signup.
    expect(isAllowedPlatformAdminEmail('Ryan@OuterLayer.AI')).toBe(true);
    expect(isAllowedPlatformAdminEmail('ryan@OUTERLAYER.AI')).toBe(true);
  });

  it('admits the domain in any casing when the CONFIGURED value is capitalized too', () => {
    mockEnv.NEXT_PUBLIC_PLATFORM_ADMIN_EMAIL_DOMAIN = '@OuterLayer.AI';

    expect(isAllowedPlatformAdminEmail('ryan@outerlayer.ai')).toBe(true);
  });

  it('refuses the old company domain', () => {
    // The switch to @outerlayer.ai is a revocation: @agentmark.co accounts must
    // lose platform-admin eligibility, which is the whole point of the change.
    expect(isAllowedPlatformAdminEmail('ryan@agentmark.co')).toBe(false);
  });

  it('refuses a lookalike that merely CONTAINS the domain', () => {
    // The match is on the `@domain` suffix, so an attacker-controlled host that
    // embeds the allowed domain earlier in the string gets nothing.
    expect(isAllowedPlatformAdminEmail('ryan@outerlayer.ai.example.com')).toBe(false);
    expect(isAllowedPlatformAdminEmail('outerlayer.ai@example.com')).toBe(false);
  });

  it('refuses a domain that merely ENDS with the allowed one without the @', () => {
    // `endsWith('@outerlayer.ai')` includes the `@`, so a sibling registration
    // like `notouterlayer.ai` cannot satisfy it.
    expect(isAllowedPlatformAdminEmail('ryan@notouterlayer.ai')).toBe(false);
  });

  it('refuses empty, null, and undefined rather than throwing', () => {
    // Callers pass whatever the session held; a missing email is not an
    // allowed domain, and a throw here would surface as a 500 on an admin page.
    expect(isAllowedPlatformAdminEmail('')).toBe(false);
    expect(isAllowedPlatformAdminEmail(null)).toBe(false);
    expect(isAllowedPlatformAdminEmail(undefined)).toBe(false);
  });

  it('admits either domain during a two-domain migration cutover', () => {
    // The reason the list is configurable: running both domains for the cutover
    // is what keeps the switch from locking every existing admin out at once.
    mockEnv.NEXT_PUBLIC_PLATFORM_ADMIN_EMAIL_DOMAIN = '@outerlayer.ai,@agentmark.co';

    expect(isAllowedPlatformAdminEmail('ryan@outerlayer.ai')).toBe(true);
    expect(isAllowedPlatformAdminEmail('ryan@agentmark.co')).toBe(true);
    // A near-miss is still refused with a list configured.
    expect(isAllowedPlatformAdminEmail('ryan@notagentmark.co')).toBe(false);
  });

  it('follows the configured domain rather than a hardcoded one', () => {
    // A self-hoster gates on their own organization, not ours.
    mockEnv.NEXT_PUBLIC_PLATFORM_ADMIN_EMAIL_DOMAIN = '@selfhosted.example';

    expect(isAllowedPlatformAdminEmail('ops@selfhosted.example')).toBe(true);
    expect(isAllowedPlatformAdminEmail('ryan@outerlayer.ai')).toBe(false);
  });

  // Unreachable in a booted app (runtimeEnv always supplies a value), but the
  // wrong failure mode here would be catastrophic: an unset domain must not mean
  // "everyone qualifies", and must not throw either — that turns a
  // misconfiguration into a 500 on every platform-admin route.
  it.each(['', undefined])('refuses every address when the domain is %j', (unset) => {
    mockEnv.NEXT_PUBLIC_PLATFORM_ADMIN_EMAIL_DOMAIN = unset as string;

    expect(isAllowedPlatformAdminEmail('ryan@outerlayer.ai')).toBe(false);
    expect(isAllowedPlatformAdminEmail('anyone@anywhere.example')).toBe(false);
    expect(allowedPlatformAdminDomains()).toEqual([]);
  });
});
