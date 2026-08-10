import { describe, expect, it } from 'vitest';

import { checkEnvReadiness, type ReadinessEnv } from '../env-readiness';

/** Every required var satisfied, nothing degraded beyond the email default. */
const COMPLETE: ReadinessEnv = {
  SUPABASE_SECRET_KEY: 'sb-secret',
  UNKEY_API_KEY: 'unkey',
  API_KEY_PEPPER: 'pepper',
  CRON_SECRET: 'cron',
  FROM_EMAIL: 'hello@corp.com',
  TOKEN_ENCRYPTION_KEY: 'k'.repeat(32),
  OAUTH_STATE_SECRET: 's'.repeat(32),
  GITHUB_APP_PRIVATE_KEY: 'pk',
  GITHUB_APP_WEBHOOK_SECRET: 'whsec',
  EMAIL_ENABLED: 'true',
  DORA_ENVIRONMENT: 'staging',
};

describe('checkEnvReadiness — required config', () => {
  it('reports nothing missing when every required var is set', () => {
    expect(checkEnvReadiness(COMPLETE).missingRequired).toEqual([]);
  });

  it('names each unset required var, in declaration order', () => {
    const { missingRequired } = checkEnvReadiness({});
    expect(missingRequired).toEqual([
      'SUPABASE_SECRET_KEY',
      'UNKEY_API_KEY',
      'API_KEY_PEPPER',
      'CRON_SECRET',
      'FROM_EMAIL',
      'TOKEN_ENCRYPTION_KEY',
      'OAUTH_STATE_SECRET',
    ]);
  });

  // runtimeEnv reads `SUPABASE_SECRET_KEY || SUPABASE_SERVICE_ROLE_KEY`, and
  // deployments still on the legacy name work fine. Reporting them broken would
  // make this check the thing that cries wolf.
  it('accepts the legacy SUPABASE_SERVICE_ROLE_KEY name', () => {
    const { missingRequired } = checkEnvReadiness({
      ...COMPLETE,
      SUPABASE_SECRET_KEY: undefined,
      SUPABASE_SERVICE_ROLE_KEY: 'legacy-secret',
    });
    expect(missingRequired).toEqual([]);
  });

  it('treats an empty string as unset', () => {
    expect(checkEnvReadiness({ ...COMPLETE, CRON_SECRET: '   ' }).missingRequired).toEqual([
      'CRON_SECRET',
    ]);
  });

  it('rejects an HMAC key that is set but shorter than the schema minimum', () => {
    expect(
      checkEnvReadiness({ ...COMPLETE, TOKEN_ENCRYPTION_KEY: 'too-short' }).missingRequired
    ).toEqual(['TOKEN_ENCRYPTION_KEY']);
  });

  // REPLY_TO_EMAIL and DATABASE_URL are `.min(1)` in env.ts but must not be
  // required here: the first resolves to a hardcoded default in runtimeEnv, the
  // second has no consumer at all.
  it.each(['REPLY_TO_EMAIL', 'DATABASE_URL'])(
    'does not require %s, which env.ts declares required but nothing enforces',
    (name) => {
      expect(checkEnvReadiness(COMPLETE).missingRequired).not.toContain(name);
    }
  );
});

describe('checkEnvReadiness — environment', () => {
  it('reports the environment the deployment believes it is', () => {
    expect(checkEnvReadiness(COMPLETE).environment).toBe('staging');
  });

  it("defaults to production when unset, mirroring runtimeEnv", () => {
    expect(checkEnvReadiness({ ...COMPLETE, DORA_ENVIRONMENT: undefined }).environment).toBe(
      'production'
    );
  });
});

describe('checkEnvReadiness — degraded capabilities', () => {
  function capabilities(env: ReadinessEnv): string[] {
    return checkEnvReadiness(env).degraded.map((d) => d.capability);
  }

  it('reports nothing degraded on a fully configured deployment', () => {
    expect(checkEnvReadiness(COMPLETE).degraded).toEqual([]);
  });

  it('flags email delivery when EMAIL_ENABLED is unset', () => {
    const { degraded } = checkEnvReadiness({ ...COMPLETE, EMAIL_ENABLED: undefined });
    expect(degraded).toEqual([
      {
        capability: 'email delivery',
        reason:
          'EMAIL_ENABLED is not truthy — transactional email is intercepted and logged, not sent. Invites report success and deliver nothing.',
      },
    ]);
  });

  it('flags a narrowed recipient allowlist only once delivery is actually on', () => {
    const restricted = { ...COMPLETE, EMAIL_RECIPIENT_ALLOWLIST: '@corp.com' };
    expect(checkEnvReadiness(restricted).degraded).toEqual([
      {
        capability: 'email delivery',
        reason:
          'EMAIL_RECIPIENT_ALLOWLIST is set — mail reaches only @corp.com. Every other recipient is dropped.',
      },
    ]);

    // Delivery off wins: reporting both would imply mail is going somewhere.
    const off = { ...restricted, EMAIL_ENABLED: 'false' };
    expect(checkEnvReadiness(off).degraded).toHaveLength(1);
    expect(checkEnvReadiness(off).degraded[0]?.reason).toContain('EMAIL_ENABLED is not truthy');
  });

  it('flags a restricted signup allowlist', () => {
    expect(capabilities({ ...COMPLETE, SIGNUP_EMAIL_ALLOWLIST: '@corp.com' })).toEqual([
      'self-service registration',
    ]);
  });

  it.each(['GITHUB_APP_PRIVATE_KEY', 'GITHUB_APP_WEBHOOK_SECRET'])(
    'flags the GitHub App when %s alone is unset',
    (name) => {
      expect(capabilities({ ...COMPLETE, [name]: undefined })).toEqual(['GitHub App']);
    }
  );

  it('flags ClickHouse isolation when the read identity is unset but ClickHouse is configured', () => {
    expect(capabilities({ ...COMPLETE, CLICKHOUSE_HOST: 'ch.example' })).toEqual([
      'ClickHouse tenant isolation',
    ]);
  });

  it('stays quiet about ClickHouse isolation when ClickHouse is not configured at all', () => {
    expect(capabilities({ ...COMPLETE, CLICKHOUSE_READ_USER: undefined })).toEqual([]);
  });

  it('flags billing only when explicitly disabled, since runtimeEnv defaults it on', () => {
    expect(capabilities({ ...COMPLETE, BILLING_ENABLED: undefined })).toEqual([]);
    expect(capabilities({ ...COMPLETE, BILLING_ENABLED: 'false' })).toEqual(['billing']);
  });

  it('reports every degraded capability at once rather than stopping at the first', () => {
    expect(
      capabilities({
        ...COMPLETE,
        EMAIL_ENABLED: undefined,
        SIGNUP_EMAIL_ALLOWLIST: '@corp.com',
        GITHUB_APP_PRIVATE_KEY: undefined,
        BILLING_ENABLED: 'false',
      })
    ).toEqual([
      'email delivery',
      'self-service registration',
      'GitHub App',
      'billing',
    ]);
  });
});
