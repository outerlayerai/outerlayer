/**
 * `buildManagementEntitlementGate` and `buildManagementEmailService` — the
 * two seams that closed the "gateway invite doesn't enforce seat caps" and
 * "gateway invite never emails" gaps documented in `management-adapters.ts`.
 *
 * The override → tier → hobby-default resolution rules themselves are
 * pinned in `@repo/entitlements`'s own suite; these tests prove THIS
 * adapter's wiring — that it hands `max_users` / `app_level_roles` to that
 * resolver with the right tenant/key, applies the self-host generous
 * default the same way the gateway's other quota-gated routes do, and
 * shapes `buildDeniedInfo` from the result.
 */
import { describe, it, expect, vi } from 'vitest';
import { UNLIMITED } from '@repo/tier-config';
import { buildManagementEntitlementGate, buildManagementEmailService } from './management-adapters';
import type { Env } from '../types';
import type { SystemAdminClient } from './system-client';

// ---------------------------------------------------------------------------
// Minimal fake of the two postgrest queries the shared resolver issues
// (`tenant_entitlement_override` override read, `billing` tier read) — not a
// general-purpose Supabase fake, just enough chain surface for
// `.from(table).select(...).eq(...).maybeSingle()`.
// ---------------------------------------------------------------------------

function fakeAdminClient(config: {
  tier?: string;
  overrides?: Record<string, boolean | number>;
}): SystemAdminClient {
  const from = (table: string) => {
    const filters: Record<string, string> = {};
    const chain = {
      select: () => chain,
      eq: (col: string, value: string) => {
        filters[col] = value;
        return chain;
      },
      maybeSingle: async () => {
        if (table === 'billing') {
          return { data: config.tier ? { tier_id: config.tier } : null, error: null };
        }
        if (table === 'tenant_entitlement_override') {
          const key = filters.entitlement_key;
          const value = key ? config.overrides?.[key] : undefined;
          return { data: value === undefined ? null : { value: { v: value } }, error: null };
        }
        throw new Error(`fakeAdminClient: unexpected table "${table}"`);
      },
    };
    return chain;
  };
  return { from } as unknown as SystemAdminClient;
}

function throwingAdminClient(): SystemAdminClient {
  return {
    from() {
      throw new Error('fakeAdminClient: must not be read on the self-host path');
    },
  } as unknown as SystemAdminClient;
}

const CLOUD_ENV = { OUTERLAYER_SELF_HOSTED: undefined } as unknown as Env;
const SELF_HOST_ENV = { OUTERLAYER_SELF_HOSTED: 'true' } as unknown as Env;

describe('buildManagementEntitlementGate — max_users (checkLimit)', () => {
  it('denies at the tier cap with the same deny-info fields the dashboard produces', async () => {
    const admin = fakeAdminClient({ tier: 'hobby' }); // max_users: hobby=2
    const gate = buildManagementEntitlementGate(admin, CLOUD_ENV);

    const result = await gate.checkLimit('t1', 'max_users', 2);
    expect(result).toEqual({
      allowed: false,
      limit: 2,
      currentCount: 2,
      requiredTier: 'growth', // growth is UNLIMITED for max_users — first tier that lifts the cap
    });

    const deniedInfo = gate.buildDeniedInfo('max_users', result);
    expect(deniedInfo).toEqual({
      entitlement: 'max_users',
      limit: 2,
      currentCount: 2,
      requiredTier: 'growth',
    });
  });

  it('allows one under the tier cap', async () => {
    const admin = fakeAdminClient({ tier: 'hobby' });
    const gate = buildManagementEntitlementGate(admin, CLOUD_ENV);

    expect(await gate.checkLimit('t1', 'max_users', 1)).toEqual({
      allowed: true,
      limit: 2,
      currentCount: 1,
    });
  });

  it('an explicit tenant_entitlement_override still wins over the tier default', async () => {
    const admin = fakeAdminClient({ tier: 'hobby', overrides: { max_users: 100 } });
    const gate = buildManagementEntitlementGate(admin, CLOUD_ENV);

    expect(await gate.checkLimit('t1', 'max_users', 50)).toEqual({
      allowed: true,
      limit: 100,
      currentCount: 50,
    });
  });

  it('self-host resolves unlimited without reading the admin client', async () => {
    const gate = buildManagementEntitlementGate(throwingAdminClient(), SELF_HOST_ENV);

    expect(await gate.checkLimit('t1', 'max_users', 10_000)).toEqual({
      allowed: true,
      limit: UNLIMITED,
      currentCount: 10_000,
    });
  });

  it('a key outside the shared tier-config matrix resolves open, not fail-closed', async () => {
    const admin = fakeAdminClient({ tier: 'hobby' });
    const gate = buildManagementEntitlementGate(admin, CLOUD_ENV);

    expect(await gate.checkLimit('t1', 'not_a_tier_config_key', 999)).toEqual({
      allowed: true,
      limit: UNLIMITED,
      currentCount: 999,
    });
  });
});

describe('buildManagementEntitlementGate — app_level_roles (canAccess)', () => {
  it('denies on a tier without the entitlement', async () => {
    const admin = fakeAdminClient({ tier: 'hobby' }); // app_level_roles: hobby=false
    const gate = buildManagementEntitlementGate(admin, CLOUD_ENV);
    expect(await gate.canAccess('t1', 'app_level_roles')).toBe(false);
  });

  it('allows on a tier with the entitlement', async () => {
    const admin = fakeAdminClient({ tier: 'team' }); // app_level_roles: team=true
    const gate = buildManagementEntitlementGate(admin, CLOUD_ENV);
    expect(await gate.canAccess('t1', 'app_level_roles')).toBe(true);
  });

  it('an override still wins over the tier default', async () => {
    const admin = fakeAdminClient({ tier: 'hobby', overrides: { app_level_roles: true } });
    const gate = buildManagementEntitlementGate(admin, CLOUD_ENV);
    expect(await gate.canAccess('t1', 'app_level_roles')).toBe(true);
  });

  it('self-host resolves the EE key closed (unlicensed default) without reading the admin client', async () => {
    const gate = buildManagementEntitlementGate(throwingAdminClient(), SELF_HOST_ENV);
    expect(await gate.canAccess('t1', 'app_level_roles')).toBe(false);
  });

  it('a key outside the shared matrix resolves open', async () => {
    const admin = fakeAdminClient({ tier: 'hobby' });
    const gate = buildManagementEntitlementGate(admin, CLOUD_ENV);
    expect(await gate.canAccess('t1', 'not_a_tier_config_key')).toBe(true);
  });
});

describe('buildManagementEmailService', () => {
  it('fails closed with the unconfigured-provider error when RESEND_API_KEY/FROM_EMAIL are unset', async () => {
    const service = buildManagementEmailService({ ...CLOUD_ENV } as Env);
    const result = await service.sendEmail({
      to: 'a@example.com',
      subject: 'hi',
      emailType: 'invite',
      templateParams: {},
    });
    expect(result.error?.message).toMatch(/No email provider is configured/);
  });

  it('sends through Resend when both env vars are configured', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const service = buildManagementEmailService({
      ...CLOUD_ENV,
      RESEND_API_KEY: 're_test_key',
      FROM_EMAIL: 'noreply@example.com',
      REPLY_TO_EMAIL: 'support@example.com',
    } as Env);

    const result = await service.sendEmail({
      to: 'invitee@example.com',
      subject: "You've been invited to join Acme",
      emailType: 'invite',
      templateParams: { inviteLink: 'https://app.example.com/invite/abc', appUrl: 'https://app.example.com', companyName: 'Acme' },
    });

    expect(result.error).toBeNull();
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.resend.com/emails');
    expect(init.method).toBe('POST');
    expect(init.headers).toMatchObject({
      Authorization: 'Bearer re_test_key',
      'Content-Type': 'application/json',
    });
    const body = JSON.parse(init.body as string);
    expect(body.from).toBe('AgentMark <noreply@example.com>');
    expect(body.reply_to).toBe('support@example.com');
    expect(body.to).toEqual(['invitee@example.com']);
    expect(body.subject).toBe("You've been invited to join Acme");
    expect(body.html).toContain('Acme');

    vi.unstubAllGlobals();
  });

  it('surfaces a non-2xx Resend response as an error rather than a fabricated success', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('invalid to address', { status: 422 })));

    const service = buildManagementEmailService({
      ...CLOUD_ENV,
      RESEND_API_KEY: 're_test_key',
      FROM_EMAIL: 'noreply@example.com',
    } as Env);

    const result = await service.sendEmail({
      to: 'bad@',
      subject: 'x',
      emailType: 'role_changed',
      templateParams: { appUrl: 'https://app.example.com', orgName: 'Acme', oldRole: 'read', newRole: 'admin' },
    });

    expect(result.error?.message).toContain('422');
    vi.unstubAllGlobals();
  });
});
