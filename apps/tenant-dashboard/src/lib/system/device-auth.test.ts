/**
 * lib/system/device-auth — the CLI device-code login handshake's only
 * access path to `public.device_auth_request`. Exercised for real against
 * MSW (@/test-helpers/msw-handlers/device-auth), not a mocked Supabase
 * client, so the query shape (eq/gt/is filters) is genuinely proven.
 */

import { seedDeviceAuthMswState, getDeviceAuthMswRows } from '@/test-helpers/msw-handlers';

import {
  createDeviceAuthRequest,
  findPendingRequestByUserCode,
  approveDeviceAuthRequest,
  denyDeviceAuthRequest,
  findRequestByDeviceCode,
  consumeApprovedDeviceAuthRequest,
  resolveApproverUserId,
  DEVICE_AUTH_TTL_SECONDS,
} from './device-auth';

// hashApiKey needs a real API_KEY_PEPPER, which the shared test env mock does
// not provide (only tests that mock @repo/api-key-service touch this path).
// A deterministic-but-not-substring-preserving stand-in: real digests never
// contain the plaintext they hash, and this file asserts that invariant, so
// the fake must not either.
function fakeDigest(plaintext: string): string {
  let h = 0;
  for (let i = 0; i < plaintext.length; i += 1) h = (Math.imul(31, h) + plaintext.charCodeAt(i)) | 0;
  return `h${(h >>> 0).toString(16)}`;
}
vi.mock('@repo/api-key-service', () => ({
  hashApiKey: vi.fn(async (plaintext: string) => fakeDigest(plaintext)),
}));

const future = (secondsFromNow: number) => new Date(Date.now() + secondsFromNow * 1000).toISOString();
const past = (secondsAgo: number) => new Date(Date.now() - secondsAgo * 1000).toISOString();

describe('createDeviceAuthRequest', () => {
  it('creates a pending row with an 8-char user code and a digested device code, never storing the plaintext', async () => {
    const result = await createDeviceAuthRequest();

    expect(result.userCode).toMatch(/^[0-9A-HJ-NP-TV-Z]{4}-[0-9A-HJ-NP-TV-Z]{4}$/);
    expect(result.deviceCode.length).toBeGreaterThan(20);
    expect(result.ttlSeconds).toBe(DEVICE_AUTH_TTL_SECONDS);

    const rows = getDeviceAuthMswRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual(
      expect.objectContaining({
        user_code: result.userCode,
        device_code_digest: fakeDigest(result.deviceCode),
        status: 'pending',
      }),
    );
    // The plaintext device code appears NOWHERE in the stored row.
    expect(JSON.stringify(rows[0])).not.toContain(result.deviceCode);
  });
});

describe('findPendingRequestByUserCode', () => {
  it('finds a live pending row by its user code', async () => {
    seedDeviceAuthMswState([
      { id: 'r1', user_code: 'AAAA-BBBB', device_code_digest: 'd1', status: 'pending', expires_at: future(600) },
    ]);
    const row = await findPendingRequestByUserCode('AAAA-BBBB');
    expect(row?.id).toBe('r1');
  });

  it('returns null for an expired row even if its status column still reads pending', async () => {
    seedDeviceAuthMswState([
      { id: 'r1', user_code: 'AAAA-BBBB', device_code_digest: 'd1', status: 'pending', expires_at: past(1) },
    ]);
    expect(await findPendingRequestByUserCode('AAAA-BBBB')).toBeNull();
  });

  it('returns null for a code that already left pending (approved/denied/consumed)', async () => {
    seedDeviceAuthMswState([
      { id: 'r1', user_code: 'AAAA-BBBB', device_code_digest: 'd1', status: 'approved', expires_at: future(600) },
    ]);
    expect(await findPendingRequestByUserCode('AAAA-BBBB')).toBeNull();
  });

  it('returns null for an unknown user code', async () => {
    expect(await findPendingRequestByUserCode('ZZZZ-ZZZZ')).toBeNull();
  });
});

describe('approveDeviceAuthRequest', () => {
  it('transitions a pending row to approved and stamps the approval fields', async () => {
    seedDeviceAuthMswState([
      { id: 'r1', user_code: 'AAAA-BBBB', device_code_digest: 'd1', status: 'pending', expires_at: future(600) },
    ]);
    const row = await approveDeviceAuthRequest({
      id: 'r1',
      tenantId: 'tenant-1',
      appId: 'app-1',
      environmentId: 'env-1',
      approverMembershipId: 'member-1',
    });
    expect(row).toEqual(
      expect.objectContaining({
        status: 'approved',
        tenant_id: 'tenant-1',
        app_id: 'app-1',
        environment_id: 'env-1',
        approver_membership_id: 'member-1',
      }),
    );
    expect(row?.approved_at).toBeTruthy();
  });

  it('refuses to approve a row that is not pending — returns null, no write', async () => {
    seedDeviceAuthMswState([
      { id: 'r1', user_code: 'AAAA-BBBB', device_code_digest: 'd1', status: 'denied', expires_at: future(600) },
    ]);
    const row = await approveDeviceAuthRequest({
      id: 'r1',
      tenantId: 'tenant-1',
      appId: 'app-1',
      environmentId: null,
      approverMembershipId: 'member-1',
    });
    expect(row).toBeNull();
    expect(getDeviceAuthMswRows()[0]!.status).toBe('denied');
  });

  it('refuses to approve an expired row even while status is still pending', async () => {
    seedDeviceAuthMswState([
      { id: 'r1', user_code: 'AAAA-BBBB', device_code_digest: 'd1', status: 'pending', expires_at: past(1) },
    ]);
    const row = await approveDeviceAuthRequest({
      id: 'r1',
      tenantId: 'tenant-1',
      appId: 'app-1',
      environmentId: null,
      approverMembershipId: 'member-1',
    });
    expect(row).toBeNull();
  });
});

describe('denyDeviceAuthRequest', () => {
  it('transitions a pending row to denied', async () => {
    seedDeviceAuthMswState([
      { id: 'r1', user_code: 'AAAA-BBBB', device_code_digest: 'd1', status: 'pending', expires_at: future(600) },
    ]);
    const row = await denyDeviceAuthRequest('r1');
    expect(row?.status).toBe('denied');
  });

  it('cannot deny a row that already resolved', async () => {
    seedDeviceAuthMswState([
      { id: 'r1', user_code: 'AAAA-BBBB', device_code_digest: 'd1', status: 'approved', expires_at: future(600) },
    ]);
    expect(await denyDeviceAuthRequest('r1')).toBeNull();
    expect(getDeviceAuthMswRows()[0]!.status).toBe('approved');
  });
});

describe('findRequestByDeviceCode', () => {
  it('looks up by the digest of the plaintext code, never the plaintext itself', async () => {
    seedDeviceAuthMswState([
      { id: 'r1', user_code: 'AAAA-BBBB', device_code_digest: fakeDigest('plain-1'), status: 'pending', expires_at: future(600) },
    ]);
    expect((await findRequestByDeviceCode('plain-1'))?.id).toBe('r1');
    expect(await findRequestByDeviceCode('wrong-code')).toBeNull();
  });
});

describe('consumeApprovedDeviceAuthRequest — the single-use guarantee', () => {
  it('consumes an approved, unexpired, not-yet-consumed row exactly once', async () => {
    seedDeviceAuthMswState([
      { id: 'r1', user_code: 'AAAA-BBBB', device_code_digest: fakeDigest('plain-1'), status: 'approved', expires_at: future(600) },
    ]);
    const first = await consumeApprovedDeviceAuthRequest('plain-1');
    expect(first).toEqual(expect.objectContaining({ id: 'r1', status: 'consumed' }));
    expect(first?.consumed_at).toBeTruthy();

    const second = await consumeApprovedDeviceAuthRequest('plain-1');
    expect(second).toBeNull();
  });

  it('two concurrent consume attempts for the same code — exactly one wins', async () => {
    seedDeviceAuthMswState([
      { id: 'r1', user_code: 'AAAA-BBBB', device_code_digest: fakeDigest('plain-1'), status: 'approved', expires_at: future(600) },
    ]);
    const [a, b] = await Promise.all([
      consumeApprovedDeviceAuthRequest('plain-1'),
      consumeApprovedDeviceAuthRequest('plain-1'),
    ]);
    const winners = [a, b].filter((r) => r !== null);
    expect(winners).toHaveLength(1);
    expect(getDeviceAuthMswRows()[0]!.status).toBe('consumed');
  });

  it('never consumes a pending (not yet approved) row', async () => {
    seedDeviceAuthMswState([
      { id: 'r1', user_code: 'AAAA-BBBB', device_code_digest: fakeDigest('plain-1'), status: 'pending', expires_at: future(600) },
    ]);
    expect(await consumeApprovedDeviceAuthRequest('plain-1')).toBeNull();
  });

  it('never consumes an expired row even if status still reads approved', async () => {
    seedDeviceAuthMswState([
      { id: 'r1', user_code: 'AAAA-BBBB', device_code_digest: fakeDigest('plain-1'), status: 'approved', expires_at: past(1) },
    ]);
    expect(await consumeApprovedDeviceAuthRequest('plain-1')).toBeNull();
  });

  it('never consumes a denied row', async () => {
    seedDeviceAuthMswState([
      { id: 'r1', user_code: 'AAAA-BBBB', device_code_digest: fakeDigest('plain-1'), status: 'denied', expires_at: future(600) },
    ]);
    expect(await consumeApprovedDeviceAuthRequest('plain-1')).toBeNull();
  });
});

describe('resolveApproverUserId', () => {
  it('degrades to null rather than throwing when the membership lookup fails', async () => {
    // No membership handler seeded for this id — the shared MSW membership
    // table returns nothing for it, exercising the not-found path.
    expect(await resolveApproverUserId('missing-membership')).toBeNull();
  });
});
