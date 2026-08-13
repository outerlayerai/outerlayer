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
import type { SmtpEmailSender, SmtpSendParams } from '../runtime/gateway-context';

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

// ---------------------------------------------------------------------------
// SmtpEmailSender stubs — the interface is two fields (`supported`, `send`),
// so a hand-rolled stub is simpler and more honest than importing a concrete
// runtime adapter (neither `NotSupportedSmtpEmailSender` nor gateway-node's
// Nodemailer-backed one belongs in a gateway-core-only test).
// ---------------------------------------------------------------------------

function unsupportedSmtpSender(): SmtpEmailSender {
  return {
    supported: false,
    async send() {
      throw new Error('unsupportedSmtpSender.send must never be called — supported is false');
    },
  };
}

function fakeSupportedSmtpSender(): SmtpEmailSender & { calls: SmtpSendParams[] } {
  const calls: SmtpSendParams[] = [];
  return {
    supported: true,
    calls,
    async send(params) {
      calls.push(params);
      return { error: null };
    },
  };
}

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

describe('buildManagementEmailService — provider selection matrix', () => {
  it('EMAIL_ENABLED unset + NODE_ENV=production: fails closed with the original unconfigured-provider message', async () => {
    const service = buildManagementEmailService(
      { ...CLOUD_ENV, NODE_ENV: 'production' } as Env,
      unsupportedSmtpSender(),
    );
    const result = await service.sendEmail({ to: 'a@example.com', subject: 'hi', emailType: 'invite', templateParams: {} });
    expect(result.error?.message).toMatch(/No email provider is configured/);
  });

  it('EMAIL_ENABLED unset + NODE_ENV=staging: fails closed the same as production (no dev fallback outside development)', async () => {
    const service = buildManagementEmailService(
      { ...CLOUD_ENV, NODE_ENV: 'staging' } as Env,
      unsupportedSmtpSender(),
    );
    const result = await service.sendEmail({ to: 'a@example.com', subject: 'hi', emailType: 'invite', templateParams: {} });
    expect(result.error?.message).toMatch(/No email provider is configured/);
  });

  it('EMAIL_ENABLED unset + NODE_ENV=development: falls back to log mode, not resend/smtp', async () => {
    const consoleInfo = vi.spyOn(console, 'info').mockImplementation(() => {});
    const service = buildManagementEmailService(
      { ...CLOUD_ENV, NODE_ENV: 'development' } as Env,
      unsupportedSmtpSender(),
    );
    const result = await service.sendEmail({
      to: 'dev@example.com',
      subject: "You've been invited",
      emailType: 'invite',
      templateParams: { inviteLink: 'https://app.example.com/invite/abc', appUrl: 'https://app.example.com', companyName: 'Acme' },
    });
    expect(result.error).toBeNull();
    expect(consoleInfo).toHaveBeenCalledWith(
      '[management-email:log-mode]',
      expect.stringContaining('"to":"dev@example.com"'),
    );
    consoleInfo.mockRestore();
  });

  it('EMAIL_ENABLED=true + EMAIL_PROVIDER=resend with keys set: sends through Resend', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const service = buildManagementEmailService(
      {
        ...CLOUD_ENV,
        NODE_ENV: 'production',
        EMAIL_ENABLED: 'true',
        EMAIL_PROVIDER: 'resend',
        RESEND_API_KEY: 're_test_key',
        FROM_EMAIL: 'noreply@example.com',
        REPLY_TO_EMAIL: 'support@example.com',
      } as Env,
      unsupportedSmtpSender(),
    );

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

  it('EMAIL_ENABLED=true + resend but RESEND_API_KEY unset: fails closed rather than falling back to log/smtp', async () => {
    const service = buildManagementEmailService(
      { ...CLOUD_ENV, NODE_ENV: 'production', EMAIL_ENABLED: 'true', EMAIL_PROVIDER: 'resend', FROM_EMAIL: 'noreply@example.com' } as Env,
      unsupportedSmtpSender(),
    );
    const result = await service.sendEmail({ to: 'a@example.com', subject: 'hi', emailType: 'invite', templateParams: {} });
    expect(result.error?.message).toMatch(/No email provider is configured/);
  });

  it('surfaces a non-2xx Resend response as an error rather than a fabricated success', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('invalid to address', { status: 422 })));

    const service = buildManagementEmailService(
      {
        ...CLOUD_ENV,
        NODE_ENV: 'production',
        EMAIL_ENABLED: 'true',
        EMAIL_PROVIDER: 'resend',
        RESEND_API_KEY: 're_test_key',
        FROM_EMAIL: 'noreply@example.com',
      } as Env,
      unsupportedSmtpSender(),
    );

    const result = await service.sendEmail({
      to: 'bad@',
      subject: 'x',
      emailType: 'role_changed',
      templateParams: { appUrl: 'https://app.example.com', orgName: 'Acme', oldRole: 'read', newRole: 'admin' },
    });

    expect(result.error?.message).toContain('422');
    vi.unstubAllGlobals();
  });

  it('EMAIL_ENABLED=true + EMAIL_PROVIDER=smtp on a runtime without SMTP support (CF Worker): fails closed at config validation, never calls send()', async () => {
    const sender = unsupportedSmtpSender();
    const service = buildManagementEmailService(
      { ...CLOUD_ENV, NODE_ENV: 'production', EMAIL_ENABLED: 'true', EMAIL_PROVIDER: 'smtp', SMTP_HOST: 'localhost', FROM_EMAIL: 'noreply@example.com' } as Env,
      sender,
    );
    const result = await service.sendEmail({ to: 'a@example.com', subject: 'hi', emailType: 'invite', templateParams: {} });
    expect(result.error?.message).toMatch(/Cloudflare Workers cannot open raw SMTP sockets/);
  });

  it('EMAIL_ENABLED=true + EMAIL_PROVIDER=smtp on a runtime WITH SMTP support: delivers via the injected sender', async () => {
    const sender = fakeSupportedSmtpSender();
    const service = buildManagementEmailService(
      {
        ...CLOUD_ENV,
        NODE_ENV: 'production',
        EMAIL_ENABLED: 'true',
        EMAIL_PROVIDER: 'smtp',
        SMTP_HOST: 'localhost',
        SMTP_PORT: 1025,
        SMTP_SECURE: 'false',
        FROM_EMAIL: 'noreply@example.com',
      } as Env,
      sender,
    );

    const result = await service.sendEmail({
      to: 'invitee@example.com',
      subject: "You've been invited to join Acme",
      emailType: 'invite',
      templateParams: { inviteLink: 'https://app.example.com/invite/abc', appUrl: 'https://app.example.com', companyName: 'Acme' },
    });

    expect(result.error).toBeNull();
    expect(sender.calls).toHaveLength(1);
    expect(sender.calls[0]).toMatchObject({
      host: 'localhost',
      port: 1025,
      secure: false,
      to: 'invitee@example.com',
      from: 'AgentMark <noreply@example.com>',
      subject: "You've been invited to join Acme",
    });
    expect(sender.calls[0].html).toContain('Acme');
  });

  it('EMAIL_ENABLED=true + smtp supported but SMTP_HOST unset: fails closed rather than attempting a connection', async () => {
    const sender = fakeSupportedSmtpSender();
    const service = buildManagementEmailService(
      { ...CLOUD_ENV, NODE_ENV: 'production', EMAIL_ENABLED: 'true', EMAIL_PROVIDER: 'smtp', FROM_EMAIL: 'noreply@example.com' } as Env,
      sender,
    );
    const result = await service.sendEmail({ to: 'a@example.com', subject: 'hi', emailType: 'invite', templateParams: {} });
    expect(result.error?.message).toMatch(/SMTP_HOST is not configured/);
    expect(sender.calls).toHaveLength(0);
  });

  it('EMAIL_ENABLED=true + EMAIL_PROVIDER=log in production: refuses rather than logging recipient data', async () => {
    const service = buildManagementEmailService(
      { ...CLOUD_ENV, NODE_ENV: 'production', EMAIL_ENABLED: 'true', EMAIL_PROVIDER: 'log' } as Env,
      unsupportedSmtpSender(),
    );
    const result = await service.sendEmail({ to: 'a@example.com', subject: 'hi', emailType: 'invite', templateParams: {} });
    expect(result.error?.message).toMatch(/EMAIL_PROVIDER=log is not permitted/);
  });

  it('EMAIL_ENABLED=true + EMAIL_PROVIDER=log in development: logs the structured line with a directly usable (entity-decoded) invite link, never the full HTML', async () => {
    const consoleInfo = vi.spyOn(console, 'info').mockImplementation(() => {});
    const service = buildManagementEmailService(
      { ...CLOUD_ENV, NODE_ENV: 'development', EMAIL_ENABLED: 'true', EMAIL_PROVIDER: 'log' } as Env,
      unsupportedSmtpSender(),
    );

    // A real invite URL has multiple query params — the renderer HTML-escapes
    // the joining `&` to `&amp;` in the attribute value. Logging that literally
    // would hand a developer a broken URL to curl/paste.
    const inviteLink =
      'https://app.example.com/auth/confirm?token_hash=abc123&type=invite&next=/auth/new-password';
    const result = await service.sendEmail({
      to: 'dev@example.com',
      subject: "You've been invited to join Acme",
      emailType: 'invite',
      templateParams: { inviteLink, appUrl: 'https://app.example.com', companyName: 'Acme' },
    });

    expect(result.error).toBeNull();
    expect(consoleInfo).toHaveBeenCalledOnce();
    const [tag, line] = consoleInfo.mock.calls[0] as [string, string];
    expect(tag).toBe('[management-email:log-mode]');
    const parsed = JSON.parse(line);
    expect(parsed).toEqual({
      to: 'dev@example.com',
      subject: "You've been invited to join Acme",
      emailType: 'invite',
      links: [inviteLink],
    });
    // The logged link is the raw, directly usable URL — a literal `&` between
    // query params, never the HTML-escaped `&amp;` the renderer produces.
    expect(parsed.links[0]).toContain('type=invite&next=');
    expect(parsed.links[0]).not.toContain('&amp;');
    // The whole point of log mode: no HTML blob in the log line.
    expect(line).not.toContain('<html');

    consoleInfo.mockRestore();
  });
});
