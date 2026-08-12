import { describe, expect, it } from 'vitest';

import { checkConfigPosture, type PostureEnv } from '../env-readiness';

/** A fully configured deployment: nothing switched off, nothing narrowed. */
const COMPLETE: PostureEnv = {
  GITHUB_APP_PRIVATE_KEY: 'pk',
  GITHUB_APP_WEBHOOK_SECRET: 'whsec',
  EMAIL_ENABLED: 'true',
  VERCEL_ENV: 'preview',
};

describe('checkConfigPosture — environment', () => {
  it('reports the platform deployment target', () => {
    expect(checkConfigPosture(COMPLETE).environment).toBe('preview');
  });

  // Off-platform (self-hosting) there is no target to report. Saying so beats
  // guessing 'production' at a self-hoster.
  it('reports unknown when the platform sets no target', () => {
    expect(checkConfigPosture({ ...COMPLETE, VERCEL_ENV: undefined }).environment).toBe(
      'unknown'
    );
  });
});

describe('checkConfigPosture — degraded capabilities', () => {
  function capabilities(env: PostureEnv): string[] {
    return checkConfigPosture(env).degraded.map((d: { capability: string }) => d.capability);
  }

  it('reports nothing degraded on a fully configured deployment', () => {
    expect(checkConfigPosture(COMPLETE).degraded).toEqual([]);
  });

  it('flags email delivery when EMAIL_ENABLED is unset', () => {
    const { degraded } = checkConfigPosture({ ...COMPLETE, EMAIL_ENABLED: undefined });
    expect(degraded).toEqual([
      {
        capability: 'email delivery',
        reason:
          'EMAIL_ENABLED is not truthy — transactional email is intercepted and logged, not sent. Invites report success and deliver nothing.',
      },
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
        GITHUB_APP_PRIVATE_KEY: undefined,
        BILLING_ENABLED: 'false',
      })
    ).toEqual(['email delivery', 'GitHub App', 'billing']);
  });
});
