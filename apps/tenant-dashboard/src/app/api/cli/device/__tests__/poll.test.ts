// @vitest-environment node
/**
 * Tests: POST /api/cli/device/poll
 *
 * The single-use consume→mint transition and the enumeration-safe status
 * contract this endpoint's security rests on (see supabase/schemas/
 * 24-device-auth.sql and lib/system/device-auth.ts's docstrings).
 */

vi.mock('server-only', () => ({}));

vi.mock('next/server', () => ({
  NextResponse: {
    json: (body: unknown, init?: { status?: number }) => ({
      status: init?.status ?? 200,
      json: async () => body,
    }),
  },
}));

vi.mock('@/lib/observability/server-logger', () => ({
  serverLogger: { error: vi.fn() },
}));

// Not substring-preserving — real digests never contain the plaintext they
// hash, and one of the tests below asserts that invariant on the stored row.
function fakeDigest(plaintext: string): string {
  let h = 0;
  for (let i = 0; i < plaintext.length; i += 1) h = (Math.imul(31, h) + plaintext.charCodeAt(i)) | 0;
  return `h${(h >>> 0).toString(16)}`;
}

const mockMintApiKey = vi.fn();
vi.mock('@repo/api-key-service', () => ({
  hashApiKey: vi.fn(async (plaintext: string) => fakeDigest(plaintext)),
  mintApiKey: (...args: unknown[]) => mockMintApiKey(...args),
}));

import {
  seedDeviceAuthMswState,
  seedSupabaseMswState,
  seedMembershipMswState,
  seedApiKeysMswState,
  getDeviceAuthMswRows,
} from '@/test-helpers/msw-handlers';
import { POST } from '../poll/route';

const TENANT = 'tenant-1';
const APP = 'app-1';

function pollRequest(deviceCode: string) {
  return new Request('http://localhost/api/cli/device/poll', {
    method: 'POST',
    body: JSON.stringify({ device_code: deviceCode }),
  });
}

function seedApprovedRow(overrides: Partial<Record<string, unknown>> = {}) {
  seedDeviceAuthMswState([
    {
      id: 'r1',
      user_code: 'AAAA-BBBB',
      device_code_digest: fakeDigest('the-device-code'),
      status: 'approved',
      expires_at: new Date(Date.now() + 600_000).toISOString(),
      tenant_id: TENANT,
      app_id: APP,
      environment_id: 'env-1',
      approver_membership_id: 'member-1',
      ...overrides,
    },
  ]);
}

function seedMintTargets() {
  seedSupabaseMswState({ apps: [{ id: APP, tenant_id: TENANT, name: 'My App' }] });
  seedMembershipMswState({ tenants: [{ tenant_id: TENANT, organization_name: 'acme' }] });
  seedSupabaseMswState({ billing: [{ tenant_id: TENANT, tier_id: 'hobby' }] });
}

beforeEach(() => {
  mockMintApiKey.mockReset();
  mockMintApiKey.mockResolvedValue({
    plaintext: 'sk_outerlayer_minted',
    row: { id: 'key-1', api_key_id: 'k-1', name: 'CLI Device Login - r1' },
  });
});

describe('POST /api/cli/device/poll — validation', () => {
  it('400s on a missing device_code', async () => {
    const res = await POST(new Request('http://localhost/api/cli/device/poll', { method: 'POST', body: JSON.stringify({}) }));
    expect(res.status).toBe(400);
  });

  it('400s on invalid JSON', async () => {
    const res = await POST(new Request('http://localhost/api/cli/device/poll', { method: 'POST', body: 'not json' }));
    expect(res.status).toBe(400);
  });
});

describe('POST /api/cli/device/poll — enumeration-safe status contract', () => {
  it('an unknown device_code reports "expired", identical to a genuinely expired one', async () => {
    const res = await POST(pollRequest('never-issued'));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'expired' });
  });

  it('a pending (not yet approved) code reports "pending"', async () => {
    seedDeviceAuthMswState([
      {
        id: 'r1', user_code: 'AAAA-BBBB', device_code_digest: fakeDigest('the-device-code'),
        status: 'pending', expires_at: new Date(Date.now() + 600_000).toISOString(),
      },
    ]);
    const res = await POST(pollRequest('the-device-code'));
    expect(await res.json()).toEqual({ status: 'pending' });
    expect(mockMintApiKey).not.toHaveBeenCalled();
  });

  it('a denied code reports "denied"', async () => {
    seedDeviceAuthMswState([
      {
        id: 'r1', user_code: 'AAAA-BBBB', device_code_digest: fakeDigest('the-device-code'),
        status: 'denied', expires_at: new Date(Date.now() + 600_000).toISOString(),
      },
    ]);
    const res = await POST(pollRequest('the-device-code'));
    expect(await res.json()).toEqual({ status: 'denied' });
    expect(mockMintApiKey).not.toHaveBeenCalled();
  });

  it('an expired-but-still-pending row reports "expired", not "pending"', async () => {
    seedDeviceAuthMswState([
      {
        id: 'r1', user_code: 'AAAA-BBBB', device_code_digest: fakeDigest('the-device-code'),
        status: 'pending', expires_at: new Date(Date.now() - 1000).toISOString(),
      },
    ]);
    const res = await POST(pollRequest('the-device-code'));
    expect(await res.json()).toEqual({ status: 'expired' });
  });

  it('re-polling an already-consumed code reports "expired" and never mints again', async () => {
    seedDeviceAuthMswState([
      {
        id: 'r1', user_code: 'AAAA-BBBB', device_code_digest: fakeDigest('the-device-code'),
        status: 'consumed', consumed_at: new Date().toISOString(),
        expires_at: new Date(Date.now() + 600_000).toISOString(),
      },
    ]);
    const res = await POST(pollRequest('the-device-code'));
    expect(await res.json()).toEqual({ status: 'expired' });
    expect(mockMintApiKey).not.toHaveBeenCalled();
  });
});

describe('POST /api/cli/device/poll — approved: mint and single-use', () => {
  it('mints a key on the first poll of an approved code and returns it', async () => {
    seedApprovedRow();
    seedMintTargets();

    const res = await POST(pollRequest('the-device-code'));

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({
      status: 'approved',
      key: 'sk_outerlayer_minted',
      app_id: APP,
      base_url: expect.any(String),
      org_name: 'acme',
      app_name: 'My App',
    });
    expect(mockMintApiKey).toHaveBeenCalledTimes(1);
    expect(mockMintApiKey).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: TENANT,
        appId: APP,
        environmentId: 'env-1',
        permissions: ['trace.write'],
        actorMembershipId: 'member-1',
        name: 'CLI Device Login - r1',
      }),
    );
    expect(getDeviceAuthMswRows()[0]!.status).toBe('consumed');
  });

  it('the device_code plaintext never appears in the stored row after consumption', async () => {
    seedApprovedRow();
    seedMintTargets();

    await POST(pollRequest('the-device-code'));

    expect(JSON.stringify(getDeviceAuthMswRows()[0])).not.toContain('the-device-code');
  });

  it('a second poll of the same code after it minted reports "expired" and does not mint again', async () => {
    seedApprovedRow();
    seedMintTargets();

    await POST(pollRequest('the-device-code'));
    const second = await POST(pollRequest('the-device-code'));

    expect(await second.json()).toEqual({ status: 'expired' });
    expect(mockMintApiKey).toHaveBeenCalledTimes(1);
  });

  it('two concurrent polls of the same approved code — exactly one mints', async () => {
    seedApprovedRow();
    seedMintTargets();

    const [a, b] = await Promise.all([POST(pollRequest('the-device-code')), POST(pollRequest('the-device-code'))]);
    const [bodyA, bodyB] = await Promise.all([a.json(), b.json()]);

    const approved = [bodyA, bodyB].filter((body) => body.status === 'approved');
    const notApproved = [bodyA, bodyB].filter((body) => body.status !== 'approved');
    expect(approved).toHaveLength(1);
    expect(notApproved).toHaveLength(1);
    expect(notApproved[0]).toEqual({ status: 'expired' });
    expect(mockMintApiKey).toHaveBeenCalledTimes(1);
  });
});

describe('POST /api/cli/device/poll — entitlement enforcement', () => {
  it('402s and does not return a key when the tenant is at its API-key limit', async () => {
    seedApprovedRow();
    seedSupabaseMswState({ apps: [{ id: APP, tenant_id: TENANT, name: 'My App' }] });
    seedMembershipMswState({ tenants: [{ tenant_id: TENANT, organization_name: 'acme' }] });
    seedSupabaseMswState({ billing: [{ tenant_id: TENANT, tier_id: 'hobby' }] });
    seedApiKeysMswState({
      apiKeys: Array.from({ length: 25 }, (_, i) => ({
        id: `key-${i}`, api_key_id: `k-${i}`, app_id: APP, name: `Key ${i}`, tenant_id: TENANT,
      })),
    });

    const res = await POST(pollRequest('the-device-code'));

    expect(res.status).toBe(402);
    const body = await res.json();
    expect(body.error).toBe('entitlement_denied');
    expect(mockMintApiKey).not.toHaveBeenCalled();
    // The code was already consumed by the atomic transition even though the
    // mint did not happen — it can never be retried, by design (see
    // mint-device-auth-key.ts's docstring on this tradeoff).
    expect(getDeviceAuthMswRows()[0]!.status).toBe('consumed');
  });
});
