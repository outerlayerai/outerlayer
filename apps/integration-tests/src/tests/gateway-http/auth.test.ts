/**
 * Auth boundary tests for the gateway.
 *
 * Motivation: Schemathesis fuzz runs have flagged `ignored_auth` violations
 * on several endpoints (requests that succeed without auth where the spec
 * says authentication is required). These tests pin the expected behaviour
 * at the HTTP boundary so regressions surface immediately with a named
 * failing test rather than as part of a 485-case fuzz report.
 *
 * Coverage: `/v1/spans` is used as a representative authenticated GET
 * (requires the `span.read` permission). The auth middleware runs before
 * the handler, so a request with no query params is fine — auth is
 * rejected (or accepted) before any handler-level validation runs.
 */

import { describe, it, expect } from 'vitest';
import { gatewayFetch } from './client';

const ENDPOINT = '/v1/spans';

describe('gateway auth boundaries', () => {
  it('rejects requests with no Authorization header', async () => {
    const res = await gatewayFetch(ENDPOINT, { noAuth: true });
    expect(res.status).toBe(401);
  });

  it('rejects requests with no X-Outerlayer-App-Id header', async () => {
    const res = await gatewayFetch(ENDPOINT, { noAppId: true });
    expect(res.status).toBe(401);
  });

  it('rejects a well-formed but unknown app id', async () => {
    // Valid UUID that won't match any row in Supabase.
    const res = await gatewayFetch(ENDPOINT, {
      appId: '00000000-0000-0000-0000-000000000000',
    });
    expect(res.status).toBe(401);
  });

  it('rejects a malformed (non-UUID) app id', async () => {
    const res = await gatewayFetch(ENDPOINT, { appId: 'not-a-uuid' });
    // Accept either 401 (auth rejected) or 400 (input validation).
    expect([400, 401]).toContain(res.status);
  });

  it('accepts a valid seeded app id (passes auth, whatever the handler does next)', async () => {
    const res = await gatewayFetch(ENDPOINT);
    // Auth passed iff we got anything other than 401. The handler may
    // return 200/500 depending on ClickHouse availability — that's not
    // what this suite is pinning.
    expect(res.status).not.toBe(401);
  });
});
