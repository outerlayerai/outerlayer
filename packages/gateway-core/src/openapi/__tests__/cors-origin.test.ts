import { describe, expect, it } from 'vitest';
import { resolveCorsOrigin } from '../index';
import type { Env } from '../../types';

// Browser fetches to /v1/* (e.g. the trace viewer's fetchBlob) are cross-origin
// and require the gateway to echo an allowed Origin. Prod is covered by
// DASHBOARD_BASE_URL; localhost dev ports are allowlisted. A missing/unknown
// origin must NOT be echoed (no Access-Control-Allow-Origin → browser blocks).
const ctx = (origin: string | undefined, appUrl?: string, nodeEnv?: string) => ({
  req: { header: (name: string) => (name === 'Origin' ? origin : undefined) },
  env: { DASHBOARD_BASE_URL: appUrl, NODE_ENV: nodeEnv } as unknown as Env,
});

describe('resolveCorsOrigin', () => {
  it('echoes an allowlisted localhost dev origin', () => {
    expect(resolveCorsOrigin(ctx('http://localhost:3002'))).toBe('http://localhost:3002');
  });

  it('echoes the configured DASHBOARD_BASE_URL origin', () => {
    expect(resolveCorsOrigin(ctx('https://app.agentmark.co', 'https://app.agentmark.co'))).toBe(
      'https://app.agentmark.co',
    );
  });

  it('returns null for an unknown origin (no CORS echo → browser blocks)', () => {
    expect(resolveCorsOrigin(ctx('https://evil.example.com', 'https://app.agentmark.co'))).toBeNull();
  });

  it('returns null when no Origin header is present (non-browser / same-origin)', () => {
    expect(resolveCorsOrigin(ctx(undefined))).toBeNull();
  });

  it('does not echo a localhost port that is not allowlisted unless set via DASHBOARD_BASE_URL', () => {
    expect(resolveCorsOrigin(ctx('http://localhost:4005'))).toBeNull();
    expect(resolveCorsOrigin(ctx('http://localhost:4005', 'http://localhost:4005'))).toBe(
      'http://localhost:4005',
    );
  });

  // The dev-port allowance is paired with Allow-Credentials, so on a deployed
  // gateway it would let anything serving content on a victim's localhost read
  // credentialed /v1/* responses. A deployed gateway has no localhost caller.
  it.each(['http://localhost:3000', 'http://localhost:3001', 'http://localhost:3002'])(
    'refuses the dev origin %s in production',
    devOrigin => {
      expect(resolveCorsOrigin(ctx(devOrigin, 'https://app.agentmark.co', 'production'))).toBeNull();
    },
  );

  it('still echoes DASHBOARD_BASE_URL in production', () => {
    expect(
      resolveCorsOrigin(ctx('https://app.agentmark.co', 'https://app.agentmark.co', 'production')),
    ).toBe('https://app.agentmark.co');
  });

  it('keeps the dev origins in development', () => {
    expect(resolveCorsOrigin(ctx('http://localhost:3002', undefined, 'development'))).toBe(
      'http://localhost:3002',
    );
  });
});
