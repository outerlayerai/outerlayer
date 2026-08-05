/**
 * Tests: `GET /api/orgs/{orgName}/apps/{appId}/agents/blob/{sha256}` — the
 * only route in the agent-sessions domain (a first-party binary-asset route).
 * Sessions list, session detail, and findings are served by
 * `AgentSessionsService`
 * (`../../../../../../../../../features/agent-sessions/service.test.ts`)
 * straight to their React Server Components.
 *
 * The route wears `withApi` and reads ClickHouse. We stub both seams the
 * house way: `buildWithApiMock` injects a tenant context + runs the real Zod
 * validation (so a bad appId/sha256, or a path/query appId mismatch, would
 * still be rejected), and the ClickHouse client is mocked to return one
 * canned row shaped for the blob projection.
 *
 * The capability tokens are minted with the REAL signer, so these tests fail
 * if the route stops checking any claim the mint side stamps.
 */

vi.mock('server-only', () => ({}));

vi.mock('next/server', () => {
  class MockNextResponse {
    status: number;
    _body: unknown;
    constructor(body: unknown, init?: { status?: number }) {
      this._body = body;
      this.status = init?.status ?? 200;
    }
    async json() {
      return this._body;
    }
    static json(body: unknown, init?: { status?: number }) {
      return new MockNextResponse(body, init);
    }
  }
  return { NextResponse: MockNextResponse };
});

const { mockTenantContext } = vi.hoisted(() => ({
  mockTenantContext: Object.freeze({
    userId: 'user-1',
    tenantId: 'tenant-1',
    appId: 'app-1',
    dataRetentionDays: -1,
  }),
}));

vi.mock('@/lib/api/with-api', async () => {
  const { buildWithApiMock } = await import('@/lib/api/__tests__/fixtures');
  return buildWithApiMock(mockTenantContext);
});

const FAT_ROW = {
  mediaType: 'image/png',
  data: Buffer.from('hello').toString('base64'),
};

const mockJson = vi.fn(async () => [FAT_ROW]);
// query() must be a Promise: the route uses `ch.query().then(r => r.json())`.
const mockQuery = vi.fn(() => Promise.resolve({ json: mockJson }));
let mockClient: { query: typeof mockQuery } | null = { query: mockQuery };

vi.mock('@/lib/analytics/client', () => ({
  createTenantReadClient: () => mockClient,
}));

import { GET as blobGET } from '../route';
import { signAgentBlobToken } from '@/features/agent-sessions/blob-url';

/** Matches the OAUTH_STATE_SECRET the shared unit-test env mock supplies. */
const SECRET = 'test-oauth-state-secret-at-least-32-chars';
const SHA = 'a'.repeat(64);

beforeEach(() => {
  vi.clearAllMocks();
  mockClient = { query: mockQuery };
  mockJson.mockResolvedValue([FAT_ROW]);
});

/** A token the route should accept, unless an override breaks one claim. */
const mint = (
  overrides: Partial<{ tenantId: string; appId: string; userId: string; sha256: string }> = {},
  options: { ttlSeconds?: number; now?: () => number } = {},
) =>
  signAgentBlobToken({
    secret: SECRET,
    claims: { tenantId: 'tenant-1', appId: 'app-1', userId: 'user-1', sha256: SHA, ...overrides },
    ...options,
  });

const req = (url: string) => new Request(url);

const get = (token: string, sha256 = SHA, appIdInPath = 'app-1') =>
  blobGET(
    req(
      `http://t/api/orgs/acme/apps/${appIdInPath}/agents/blob/${sha256}?appId=app-1&token=${encodeURIComponent(token)}`,
    ),
    { params: Promise.resolve({ orgName: 'acme', appId: appIdInPath, sha256 }) },
  );

describe('GET /api/orgs/[orgName]/apps/[appId]/agents/blob/[sha256]', () => {
  it('serves the stored bytes with the blob media type', async () => {
    const res = await get(await mint());
    expect(res).toBeInstanceOf(Response);
    expect(res.headers.get('content-type')).toBe('image/png');
    expect(await res.text()).toBe('hello');
  });

  it('caches only for what is left of the token, never past its expiry', async () => {
    const nowSeconds = Math.floor(Date.now() / 1000);
    const res = await get(await mint({}, { ttlSeconds: 120, now: () => nowSeconds }));
    const maxAge = Number(/max-age=(\d+)/.exec(res.headers.get('cache-control') ?? '')?.[1]);
    expect(maxAge).toBeGreaterThan(110);
    expect(maxAge).toBeLessThanOrEqual(120);
  });

  it('404s when the hash is not in the store', async () => {
    mockJson.mockResolvedValue([]);
    const sha = 'b'.repeat(64);
    const res = await get(await mint({ sha256: sha }), sha);
    expect(res.status).toBe(404);
  });

  it('rejects a path appId that does not match the authorized query appId', async () => {
    const res = await get(await mint(), SHA, 'other-app');
    expect(res.status).toBe(400);
  });

  it('rejects a token minted for another person, tenant, or app', async () => {
    for (const claim of [{ userId: 'user-2' }, { tenantId: 'tenant-2' }, { appId: 'app-2' }]) {
      const res = await get(await mint(claim));
      expect(res.status).toBe(403);
    }
  });

  it('rejects a token replayed against a different image', async () => {
    const other = 'c'.repeat(64);
    // The signature is intact; only the hash in the URL changed — the whole
    // point of putting sha256 inside the claims.
    const res = await get(await mint(), other);
    expect(res.status).toBe(403);
  });

  it('rejects an expired token', async () => {
    const longAgo = Math.floor(Date.now() / 1000) - 7200;
    const res = await get(await mint({}, { ttlSeconds: 60, now: () => longAgo }));
    expect(res.status).toBe(403);
  });

  it('rejects a token whose signature was not minted with the deployment secret', async () => {
    const forged = await signAgentBlobToken({
      secret: 'an-attacker-secret-also-32-characters',
      claims: { tenantId: 'tenant-1', appId: 'app-1', userId: 'user-1', sha256: SHA },
    });
    const res = await get(forged);
    expect(res.status).toBe(403);
  });

  it('requires a token at all — a bare hash URL no longer serves bytes', async () => {
    const res = await blobGET(
      req(`http://t/api/orgs/acme/apps/app-1/agents/blob/${SHA}?appId=app-1`),
      { params: Promise.resolve({ orgName: 'acme', appId: 'app-1', sha256: SHA }) },
    );
    expect(res.status).toBe(400);
  });

  it('never touches the store on a rejected token, so failures reveal no hashes', async () => {
    await get(await mint({ userId: 'user-2' }));
    expect(mockQuery).not.toHaveBeenCalled();
  });
});
