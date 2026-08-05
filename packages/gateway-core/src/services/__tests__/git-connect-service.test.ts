/**
 * GitConnectService — URL builder + config validation tests.
 *
 * Covers the install URL shape, state-token round-trip, and the
 * `GitConnectConfigurationError` path (missing/failed slug resolution).
 */

import { describe, it, expect } from 'vitest';
import {
  GitConnectService,
  GitConnectConfigurationError,
} from '../git-connect-service';
import { verifyGitConnectState } from '../../lib/git-connect-state';

const SECRET = 'test-secret-at-least-32-characters-long-for-hmac';
const APP_ID = '11111111-1111-4111-8111-111111111111';
const TENANT_ID = '22222222-2222-4222-8222-222222222222';

function makeService(overrides: Partial<ConstructorParameters<typeof GitConnectService>[0]> = {}) {
  return new GitConnectService({
    oauthStateSecret: SECRET,
    resolveGithubAppSlug: async () => 'agentmark-prod',
    ...overrides,
  });
}

describe('GitConnectService — GitHub', () => {
  it('builds an install URL pointing at github.com/apps/<slug>', async () => {
    const service = makeService();
    const result = await service.buildAuthorizationUrl({
      appId: APP_ID,
      tenantId: TENANT_ID,
      provider: 'github',
    });
    const url = new URL(result.authorizationUrl);

    expect(url.origin).toBe('https://github.com');
    expect(url.pathname).toBe('/apps/agentmark-prod/installations/new');
    expect(url.searchParams.get('state')).toBe(result.state);
  });

  it('URL-encodes the slug (defense against funky slugs from GET /app)', async () => {
    const service = makeService({ resolveGithubAppSlug: async () => 'foo bar' });
    const result = await service.buildAuthorizationUrl({
      appId: APP_ID,
      tenantId: TENANT_ID,
      provider: 'github',
    });
    expect(result.authorizationUrl).toContain('/apps/foo%20bar/installations/new');
  });

  it('embeds a state token that round-trips to the input app + tenant', async () => {
    const service = makeService();
    const result = await service.buildAuthorizationUrl({
      appId: APP_ID,
      tenantId: TENANT_ID,
      provider: 'github',
    });
    const verified = await verifyGitConnectState({ secret: SECRET, token: result.state });
    expect(verified.ok).toBe(true);
    if (verified.ok) {
      expect(verified.payload.app_id).toBe(APP_ID);
      expect(verified.payload.tenant_id).toBe(TENANT_ID);
      expect(verified.payload.provider).toBe('github');
    }
  });

  it('throws GitConnectConfigurationError when the slug resolves empty', async () => {
    const service = makeService({ resolveGithubAppSlug: async () => '' });
    await expect(
      service.buildAuthorizationUrl({
        appId: APP_ID,
        tenantId: TENANT_ID,
        provider: 'github',
      }),
    ).rejects.toBeInstanceOf(GitConnectConfigurationError);
  });

  it('propagates a resolver failure (GET /app down) as-is', async () => {
    const boom = new GitConnectConfigurationError('GET /app failed (status=401)');
    const service = makeService({
      resolveGithubAppSlug: async () => {
        throw boom;
      },
    });
    await expect(
      service.buildAuthorizationUrl({
        appId: APP_ID,
        tenantId: TENANT_ID,
        provider: 'github',
      }),
    ).rejects.toBe(boom);
  });

});

describe('GitConnectService — common behaviour', () => {
  it('returns expires_at as ISO-8601 matching the signed payload exp', async () => {
    const service = makeService();
    const result = await service.buildAuthorizationUrl({
      appId: APP_ID,
      tenantId: TENANT_ID,
      provider: 'github',
    });
    expect(result.expiresAt).toBe(
      new Date(result.payload.exp * 1000).toISOString(),
    );
    // ISO-8601 sanity check.
    expect(Number.isNaN(Date.parse(result.expiresAt))).toBe(false);
  });

  it('mints a fresh nonce per call', async () => {
    const service = makeService();
    const a = await service.buildAuthorizationUrl({
      appId: APP_ID,
      tenantId: TENANT_ID,
      provider: 'github',
    });
    const b = await service.buildAuthorizationUrl({
      appId: APP_ID,
      tenantId: TENANT_ID,
      provider: 'github',
    });
    expect(a.payload.nonce).not.toBe(b.payload.nonce);
    expect(a.state).not.toBe(b.state);
  });
});
