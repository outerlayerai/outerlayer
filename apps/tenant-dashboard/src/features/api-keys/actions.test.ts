/**
 * Tests for the api-keys server actions on the `authorizedAction` spine.
 *
 * Supabase is exercised through MSW (session, membership, permission RPCs,
 * and the `api_key` row reads/writes) — no hand-rolled client mocks. Only
 * the key-store mint (`mintApiKeySystem`) and the entitlement limit check
 * (`checkApiKeyLimit`) are mocked at the module boundary, mirroring how the
 * pre-migration exemplar mocked `mintApiKey` and `EntitlementService`.
 */

import { http, HttpResponse } from 'msw';
import type { User } from '@supabase/supabase-js';
import { server } from '@/test-helpers/msw-server';
import {
  seedApiKeysMswState,
  seedSupabaseAuth,
  seedMembershipMswState,
  seedPermissionsMswState,
  getInsertedAuditLogRows,
} from '@/test-helpers/msw-handlers';

// The request tenant (the resolved, URL-derived tenant every test intends —
// TENANT below) travels as the `X-Tenant-Id` header. Overriding it here
// (rather than the global no-op stub) is what lets the stale-claim test
// prove the REQUEST tenant wins over a differing JWT claim.
vi.mock('next/headers', async () => {
  const { getSupabaseTestCookieStore } = await import('@/test-helpers/supabase-session');
  return {
    cookies: () => getSupabaseTestCookieStore(),
    headers: () => ({
      get: (name: string) => (name === 'x-tenant-id' ? 'tenant-1' : undefined),
    }),
  };
});

const SUPABASE_URL = 'http://localhost:54321';
const TENANT = 'tenant-1';
const APP_ID = 'app-1';

const mockUser: User = {
  id: 'user-1',
  email: 'test@example.com',
  app_metadata: { tenant_id: TENANT },
  user_metadata: {},
  aud: 'authenticated',
  created_at: '2026-01-01T00:00:00Z',
};

function seedAuthedMember(
  opts: { permissions?: string[]; orgPermissions?: string[]; claimTenant?: string } = {},
) {
  seedSupabaseAuth({
    user: opts.claimTenant
      ? { ...mockUser, app_metadata: { tenant_id: opts.claimTenant } }
      : mockUser,
  });
  seedMembershipMswState({
    memberships: [
      { id: 'm1', user_id: 'user-1', tenant_id: TENANT, role: 'owner', status: 'active' },
    ],
    tenants: [{ tenant_id: TENANT, organization_name: 'org-1' }],
  });
  seedPermissionsMswState({
    // `deleteApiKeyAction` declares the ORG-scoped `api_key.delete` at the
    // wrapper (a coarse pre-check) and re-checks it APP-scoped inside the
    // handler (the authoritative check) — both allow-lists matter.
    allowedPermissions: opts.orgPermissions ?? ['api_key.delete'],
    allowedAppPermissions: {
      // The default caller is an owner-equivalent for this app: every write
      // verb these tests grant onto a minted/edited key, PLUS the api_key.*
      // verbs the actions themselves are gated on. `get_current_user_app_permissions`
      // (the clamp's source) reads this SAME allow-list.
      [APP_ID]: opts.permissions ?? [
        'api_key.insert',
        'api_key.update',
        'api_key.delete',
        'trace.write',
        'score.write',
      ],
    },
  });
}

vi.mock('@/lib/system/api-key-limit', () => ({
  checkApiKeyLimit: vi.fn(),
  buildDeniedInfo: vi.fn((key: string, result: Record<string, unknown>) => ({
    featureKey: key,
    featureDisplayName: 'API Keys',
    requiredTier: 'growth',
    ...result,
  })),
}));

vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

const mockMintApiKeySystem = vi.hoisted(() =>
  vi.fn(async () => ({
    plaintext: 'sk_outerlayer_new',
    row: {
      id: 'uuid-1',
      api_key_id: 'key_1',
      key_prefix: 'sk_outerlayer_xxxx',
      permissions: [],
      name: 'n',
      environment_id: 'env',
      created_at: new Date().toISOString(),
      expires_at: null,
    },
  })),
);
vi.mock('@/lib/system/mint-api-key', () => ({ mintApiKeySystem: mockMintApiKeySystem }));

import { checkApiKeyLimit } from '@/lib/system/api-key-limit';
import * as auditLogModule from '@/lib/system/audit-log';
import { createApiKeyAction, deleteApiKeyAction, updateApiKeyPermissionsAction } from './actions';

const mockCheckLimit = checkApiKeyLimit as unknown as ReturnType<typeof vi.fn>;

function resetMintDefault() {
  mockMintApiKeySystem.mockResolvedValue({
    plaintext: 'sk_outerlayer_new',
    row: {
      id: 'uuid-1',
      api_key_id: 'key_1',
      key_prefix: 'sk_outerlayer_xxxx',
      permissions: [],
      name: 'n',
      environment_id: 'env',
      created_at: new Date().toISOString(),
      expires_at: null,
    },
  });
}

describe('createApiKeyAction — entitlement enforcement', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetMintDefault();
    seedAuthedMember();
  });

  // proves AC-060-03
  it('should block API key creation when at the limit', async () => {
    seedApiKeysMswState({
      apiKeys: Array.from({ length: 25 }, (_, index) => ({
        id: `existing-key-${index + 1}`,
        api_key_id: `k-${index + 1}`,
        app_id: 'app-1',
        name: `Existing key ${index + 1}`,
        tenant_id: 'tenant-1',
      })),
    });

    mockCheckLimit.mockResolvedValue({ allowed: false, limit: 25, currentCount: 25, requiredTier: 'growth' });

    const result = await createApiKeyAction({ name: 'My Key', appId: 'app-1' });

    expect(mockCheckLimit).toHaveBeenCalledWith('tenant-1');
    expect(mockMintApiKeySystem).not.toHaveBeenCalled();
    expect(result).toEqual({
      ok: true,
      data: expect.objectContaining({
        ok: false,
        errorCode: 'entitlement_denied',
        entitlement: expect.objectContaining({ featureKey: 'max_api_keys' }),
      }),
    });
  });

  it('should allow API key creation when under the limit and mint through the key-store', async () => {
    seedApiKeysMswState({
      apiKeys: Array.from({ length: 10 }, (_, index) => ({
        id: `existing-key-${index + 1}`,
        api_key_id: `k-${index + 1}`,
        app_id: 'app-1',
        name: `Existing key ${index + 1}`,
        tenant_id: 'tenant-1',
      })),
    });

    mockCheckLimit.mockResolvedValue({ allowed: true, limit: 25, currentCount: 10 });

    const result = await createApiKeyAction({ name: 'My Key', appId: 'app-1' });

    expect(mockCheckLimit).toHaveBeenCalledWith('tenant-1');
    expect(result).toEqual({ ok: true, data: { ok: true, apiKey: 'sk_outerlayer_new' } });
    expect(mockMintApiKeySystem).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: 'tenant-1',
        appId: 'app-1',
        name: 'My Key',
        permissions: [],
        environmentId: 'env-default-1',
        allowedEnvKinds: null,
      }),
    );
    // Key creation lands in the tenant trail with the grant surface...
    const auditRows = getInsertedAuditLogRows();
    expect(auditRows).toEqual([
      expect.objectContaining({
        tenant_id: 'tenant-1',
        actor_id: 'user-1',
        actor_label: 'test@example.com',
        action_type: 'api_key_created',
        target_type: 'api_key',
        target_id: 'uuid-1',
        target_identifier: 'My Key',
        details: { app_id: 'app-1', environment_id: 'env-default-1', allowed_env_kinds: null },
        after_state: { permissions: [] },
      }),
    ]);
    // ...and NEVER the secret material.
    expect(JSON.stringify(auditRows)).not.toContain('sk_outerlayer_new');
  });

  it('still reports success when the audit write throws — a recording failure must not mask a completed mint', async () => {
    seedApiKeysMswState({ apiKeys: [] });
    mockCheckLimit.mockResolvedValue({ allowed: true, limit: 25, currentCount: 0 });
    const writeAuditLogSpy = vi
      .spyOn(auditLogModule, 'writeAuditLog')
      .mockRejectedValueOnce(new Error('audit sink unavailable'));

    const result = await createApiKeyAction({ name: 'My Key', appId: 'app-1' });

    expect(result).toEqual({ ok: true, data: { ok: true, apiKey: 'sk_outerlayer_new' } });
    writeAuditLogSpy.mockRestore();
  });

  it('mints a kind-scoped key with NO env pin and allowed_env_kinds', async () => {
    seedApiKeysMswState({ apiKeys: [] });
    mockCheckLimit.mockResolvedValue({ allowed: true, limit: 25, currentCount: 0 });

    const result = await createApiKeyAction({
      name: 'CI Key',
      appId: 'app-1',
      permissions: ['trace.write'],
      allowedEnvKinds: ['preview'],
    });

    expect(result).toEqual({ ok: true, data: { ok: true, apiKey: 'sk_outerlayer_new' } });
    expect(mockMintApiKeySystem).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'CI Key',
        appId: 'app-1',
        environmentId: null,
        allowedEnvKinds: ['preview'],
        permissions: ['trace.write'],
      }),
    );
  });

  it('rejects an invalid env kind before any DB work', async () => {
    const result = await createApiKeyAction({
      name: 'Bad',
      appId: 'app-1',
      permissions: ['trace.write'],
      allowedEnvKinds: ['bogus'],
    });
    expect(result).toEqual({
      ok: true,
      data: { ok: false, errorCode: 'invalid_env_kinds', message: 'Invalid env kinds: bogus' },
    });
    expect(mockCheckLimit).not.toHaveBeenCalled();
    expect(mockMintApiKeySystem).not.toHaveBeenCalled();
  });

  it('checks the entitlement limit by tenant alone — the count is computed inside checkApiKeyLimit, not passed in', async () => {
    seedApiKeysMswState({ apiKeys: [] });
    mockCheckLimit.mockResolvedValue({ allowed: false, limit: 25, currentCount: 0, requiredTier: 'growth' });

    await createApiKeyAction({ name: 'My Key', appId: 'app-1' });

    expect(mockCheckLimit).toHaveBeenCalledWith('tenant-1');
    expect(mockCheckLimit).toHaveBeenCalledTimes(1);
  });
});

describe('createApiKeyAction — permission validation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetMintDefault();
    seedAuthedMember();
    mockCheckLimit.mockResolvedValue({ allowed: true, limit: 25, currentCount: 0 });
  });

  it('rejects unknown permission strings before minting', async () => {
    seedApiKeysMswState({ apiKeys: [] });

    const result = await createApiKeyAction({
      name: 'My Key',
      appId: 'app-1',
      permissions: ['trace.write', 'not-a-real-permission', 'score.write'],
    });

    expect(mockCheckLimit).not.toHaveBeenCalled();
    expect(result).toEqual({
      ok: true,
      data: { ok: false, errorCode: 'invalid_permissions', message: expect.stringContaining('not-a-real-permission') },
    });
    expect(mockMintApiKeySystem).not.toHaveBeenCalled();
  });

  // proves AC-060-01
  it('forwards the requested permissions to the key-store when valid', async () => {
    seedApiKeysMswState({ apiKeys: [] });

    await createApiKeyAction({ name: 'Scoped Key', appId: 'app-1', permissions: ['trace.write', 'score.write'] });

    expect(mockMintApiKeySystem).toHaveBeenCalledTimes(1);
    expect(mockMintApiKeySystem).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: 'tenant-1',
        appId: 'app-1',
        name: 'Scoped Key',
        permissions: ['trace.write', 'score.write'],
      }),
    );
  });
});

// Same authorization model as packages/gateway-core's CreateApiKey clamp:
// a caller must not be able to mint (or edit) a key more powerful than
// themselves. An unclamped grant is a direct privilege escalation — a
// `write` member picking "Full Access" would receive a key that outranks
// them (app.delete, api_key.delete on other members' keys, full read).
describe('createApiKeyAction — clamped to the caller\'s own permissions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetMintDefault();
    mockCheckLimit.mockResolvedValue({ allowed: true, limit: 25, currentCount: 0 });
  });

  // proves AC-060-02
  it('rejects a grant the caller does not themselves hold, and mints nothing', async () => {
    // The caller holds api_key.insert (so the wrapper's own gate passes) but
    // NOT environment.delete — a permission a caller could request onto a
    // minted key without holding it themselves, absent the clamp below.
    seedAuthedMember({ permissions: ['api_key.insert'] });
    seedApiKeysMswState({ apiKeys: [] });

    const result = await createApiKeyAction({
      name: 'Escalated Key',
      appId: 'app-1',
      permissions: ['environment.delete'],
    });

    expect(result).toEqual({
      ok: true,
      data: {
        ok: false,
        errorCode: 'permissions_exceed_caller',
        message: expect.stringContaining('environment.delete'),
      },
    });
    expect(mockMintApiKeySystem).not.toHaveBeenCalled();
    expect(mockCheckLimit).not.toHaveBeenCalled();
  });

  it('allows an exact-parity grant — a caller may reproduce their own authority', async () => {
    seedAuthedMember({ permissions: ['api_key.insert', 'trace.write'] });
    seedApiKeysMswState({ apiKeys: [] });

    const result = await createApiKeyAction({
      name: 'Parity Key',
      appId: 'app-1',
      permissions: ['trace.write'],
    });

    expect(result).toEqual({ ok: true, data: { ok: true, apiKey: 'sk_outerlayer_new' } });
  });

  it('fails closed (rejects) when the permission-set RPC errors', async () => {
    seedAuthedMember({ permissions: ['api_key.insert'] });
    seedApiKeysMswState({ apiKeys: [] });
    server.use(
      http.post(`${SUPABASE_URL}/rest/v1/rpc/get_current_user_app_permissions`, () =>
        HttpResponse.json({ message: 'rpc exploded' }, { status: 500 }),
      ),
    );

    const result = await createApiKeyAction({
      name: 'Any Key',
      appId: 'app-1',
      permissions: ['trace.write'],
    });

    expect(result).toEqual({
      ok: true,
      data: { ok: false, errorCode: 'permissions_exceed_caller', message: expect.any(String) },
    });
    expect(mockMintApiKeySystem).not.toHaveBeenCalled();
  });
});

// proves AC-2
describe('createApiKeyAction — stale JWT claim', () => {
  it('inserts under the REQUEST tenant, not a stale claim naming a different tenant', async () => {
    // The session claim names tenant-b; the actor's real, permission-checked
    // membership (and this action's tenant scoping) is tenant-1.
    seedAuthedMember({ claimTenant: 'tenant-b' });
    seedApiKeysMswState({ apiKeys: [] });
    mockCheckLimit.mockResolvedValue({ allowed: true, limit: 25, currentCount: 0 });
    resetMintDefault();

    await createApiKeyAction({ name: 'My Key', appId: 'app-1' });

    expect(mockMintApiKeySystem).toHaveBeenCalledWith(expect.objectContaining({ tenantId: 'tenant-1' }));
  });
});

// proves AC-4
describe('createApiKeyAction — denial auditing', () => {
  it('denies creation, audits the denial, and mints nothing', async () => {
    seedAuthedMember({ permissions: [] }); // no api_key.insert on app-1
    seedApiKeysMswState({ apiKeys: [] });
    resetMintDefault();

    const result = await createApiKeyAction({ name: 'My Key', appId: 'app-1' });

    expect(result).toEqual({
      ok: false,
      error: { code: 'forbidden', message: 'Permission denied: api_key.insert' },
    });
    expect(mockMintApiKeySystem).not.toHaveBeenCalled();
    expect(getInsertedAuditLogRows()).toEqual([
      expect.objectContaining({
        tenant_id: 'tenant-1',
        actor_id: 'user-1',
        action_type: 'permission_denied',
        target_type: 'permission',
        target_identifier: 'api_key.insert',
        details: { scope: 'app', app_id: 'app-1' },
      }),
    ]);
  });
});

// proves AC-4
describe('updateApiKeyPermissionsAction — denial auditing', () => {
  it('denies the edit, audits the denial, and touches no row', async () => {
    seedAuthedMember({ permissions: [] }); // no api_key.update on app-1
    let patchCalled = false;
    server.use(
      http.patch(`${SUPABASE_URL}/rest/v1/api_key`, () => {
        patchCalled = true;
        return HttpResponse.json([]);
      }),
    );

    const result = await updateApiKeyPermissionsAction({
      apiKeyId: 'k1',
      appId: 'app-1',
      permissions: ['trace.write'],
    });

    expect(result).toEqual({
      ok: false,
      error: { code: 'forbidden', message: 'Permission denied: api_key.update' },
    });
    expect(patchCalled).toBe(false);
    expect(getInsertedAuditLogRows()).toEqual([
      expect.objectContaining({
        tenant_id: 'tenant-1',
        actor_id: 'user-1',
        action_type: 'permission_denied',
        target_type: 'permission',
        target_identifier: 'api_key.update',
        details: { scope: 'app', app_id: 'app-1' },
      }),
    ]);
  });
});

describe('createApiKeyAction — mint-failure mapping', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetMintDefault();
    seedAuthedMember();
    mockCheckLimit.mockResolvedValue({ allowed: true, limit: 25, currentCount: 0 });
  });

  it('maps a PostgREST duplicate-name failure (23505) through the api-key database handler', async () => {
    seedApiKeysMswState({ apiKeys: [] });
    const raw = 'duplicate key value violates unique constraint "uc_api_key"';
    mockMintApiKeySystem.mockRejectedValueOnce({ code: '23505', message: raw });

    const result = await createApiKeyAction({ name: 'Dupe Key', appId: 'app-1' });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.data.ok).toBe(false);
    if (result.data.ok) throw new Error('unreachable');
    expect(result.data.message).toMatch(/already exists/i);
    expect(result.data.message).not.toBe(raw);
  });

  it('surfaces a code-less mint failure as its plain message (no handler mapping)', async () => {
    seedApiKeysMswState({ apiKeys: [] });
    mockMintApiKeySystem.mockRejectedValueOnce(new Error('mint exploded'));

    const result = await createApiKeyAction({ name: 'My Key', appId: 'app-1' });

    expect(result).toEqual({
      ok: true,
      data: { ok: false, errorCode: 'mint_failed', message: 'mint exploded' },
    });
  });
});

describe('deleteApiKeyAction', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // proves AC-1, AC-10
  it('deletes the api_key row by id and nothing else — and audits the revocation', async () => {
    seedAuthedMember();
    seedApiKeysMswState({
      apiKeys: [
        { id: 'key-uuid-1', api_key_id: 'k1', app_id: 'app-1', name: 'x', tenant_id: 'tenant-1', permissions: ['trace.write'] },
      ],
    });

    let deleteUrl: URL | undefined;
    server.use(
      http.delete(`${SUPABASE_URL}/rest/v1/api_key`, ({ request }) => {
        deleteUrl = new URL(request.url);
        return HttpResponse.json([{ id: 'key-uuid-1' }]);
      }),
    );

    const result = await deleteApiKeyAction({ id: 'key-uuid-1' });

    expect(result).toEqual({ ok: true, data: { ok: true } });
    expect(deleteUrl?.searchParams.get('id')).toBe('eq.key-uuid-1');
    expect(getInsertedAuditLogRows()).toEqual([
      expect.objectContaining({
        tenant_id: 'tenant-1',
        actor_id: 'user-1',
        actor_label: 'test@example.com',
        action_type: 'api_key_deleted',
        target_type: 'api_key',
        target_id: 'key-uuid-1',
        target_identifier: 'x',
        details: { app_id: 'app-1' },
        before_state: { permissions: ['trace.write'] },
      }),
    ]);
  });

  // proves AC-5 — mutation-verified: fails if the handler's explicit
  // app-scoped check is removed (the wrapper's org-scoped declaration alone
  // is deliberately NOT sufficient for this action).
  // proves AC-060-05
  it('leaves the row untouched, returns forbidden (not internal_error), and audits the denial when api_key.delete is missing on this app', async () => {
    seedAuthedMember({ permissions: [] });
    seedApiKeysMswState({
      apiKeys: [
        { id: 'key-uuid-1', api_key_id: 'k1', app_id: 'app-1', name: 'x', tenant_id: 'tenant-1', permissions: ['trace.write'] },
      ],
    });

    let deleteHit = false;
    server.use(
      http.delete(`${SUPABASE_URL}/rest/v1/api_key`, () => {
        deleteHit = true;
        return HttpResponse.json([]);
      }),
    );

    const result = await deleteApiKeyAction({ id: 'key-uuid-1' });

    expect(deleteHit).toBe(false);
    expect(result).toEqual({
      ok: false,
      error: { code: 'forbidden', message: 'Permission denied: api_key.delete' },
    });
    expect(getInsertedAuditLogRows()).toEqual([
      expect.objectContaining({
        tenant_id: 'tenant-1',
        actor_id: 'user-1',
        action_type: 'permission_denied',
        target_type: 'permission',
        target_identifier: 'api_key.delete',
        details: { scope: 'app', app_id: 'app-1' },
      }),
    ]);
  });

  // proves AC-4 — the wrapper-level org-scoped denial (an ordinary member
  // holding api_key.delete nowhere at all, the most common denial) must
  // still audit. The row lookup never runs, so no app id is available; the
  // row written here is org-scoped, distinct from the app-scoped row the
  // test above pins.
  it('audits the denial at org scope when the caller holds api_key.delete on no app at all', async () => {
    seedAuthedMember({ orgPermissions: [] });
    let lookupHit = false;
    server.use(
      http.get(`${SUPABASE_URL}/rest/v1/api_key`, () => {
        lookupHit = true;
        return HttpResponse.json([]);
      }),
    );

    const result = await deleteApiKeyAction({ id: 'key-uuid-1' });

    expect(lookupHit).toBe(false);
    expect(result).toEqual({
      ok: false,
      error: { code: 'forbidden', message: 'Permission denied: api_key.delete' },
    });
    expect(getInsertedAuditLogRows()).toEqual([
      expect.objectContaining({
        tenant_id: 'tenant-1',
        actor_id: 'user-1',
        action_type: 'permission_denied',
        target_type: 'permission',
        target_identifier: 'api_key.delete',
        details: { scope: 'org' },
      }),
    ]);
  });

  // proves AC-6 — mutation-verified: fails against a fire-and-forget
  // DELETE that only checks `error` (RLS denies by matching zero rows, no error).
  it('reports failure when the DELETE matches zero rows under RLS', async () => {
    seedAuthedMember();
    seedApiKeysMswState({
      apiKeys: [
        { id: 'key-uuid-1', api_key_id: 'k1', app_id: 'app-1', name: 'x', tenant_id: 'tenant-1', permissions: [] },
      ],
    });
    server.use(http.delete(`${SUPABASE_URL}/rest/v1/api_key`, () => HttpResponse.json([])));

    const result = await deleteApiKeyAction({ id: 'key-uuid-1' });

    expect(result).toEqual({ ok: true, data: { ok: false, message: 'Delete matched no rows' } });
  });
});

describe('updateApiKeyPermissionsAction', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    seedAuthedMember();
  });

  it('issues a real UPDATE keyed by api_key_id + app_id with the permissions payload', async () => {
    seedApiKeysMswState({
      apiKeys: [
        { id: 'key-uuid-1', api_key_id: 'k1', app_id: 'app-1', name: 'CI key', tenant_id: 'tenant-1', permissions: ['trace.read'] },
      ],
    });
    let patchUrl: URL | undefined;
    let patchBody: unknown;
    server.use(
      http.patch(`${SUPABASE_URL}/rest/v1/api_key`, async ({ request }) => {
        patchUrl = new URL(request.url);
        patchBody = await request.json();
        return HttpResponse.json([{ id: 'key-uuid-1' }]);
      }),
    );

    const result = await updateApiKeyPermissionsAction({
      apiKeyId: 'k1',
      appId: 'app-1',
      permissions: ['trace.write', 'score.write'],
    });

    expect(result).toEqual({ ok: true, data: { ok: true } });
    expect(patchUrl?.searchParams.get('api_key_id')).toBe('eq.k1');
    expect(patchUrl?.searchParams.get('app_id')).toBe('eq.app-1');
    expect(patchBody).toEqual({ permissions: ['trace.write', 'score.write'] });
    expect(getInsertedAuditLogRows()).toEqual([
      expect.objectContaining({
        tenant_id: 'tenant-1',
        action_type: 'api_key_updated',
        target_type: 'api_key',
        target_identifier: 'CI key',
        before_state: { permissions: ['trace.read'] },
        after_state: { permissions: ['trace.write', 'score.write'] },
      }),
    ]);
  });

  it('rejects unknown permissions before touching the row', async () => {
    let patchCalled = false;
    server.use(
      http.patch(`${SUPABASE_URL}/rest/v1/api_key`, () => {
        patchCalled = true;
        return HttpResponse.json([]);
      }),
    );

    const result = await updateApiKeyPermissionsAction({
      apiKeyId: 'k1',
      appId: 'app-1',
      permissions: ['bogus.permission'],
    });

    expect(result).toEqual({ ok: true, data: { ok: false, message: 'Invalid permissions: bogus.permission' } });
    expect(patchCalled).toBe(false);
  });

  it('reports failure when the UPDATE matches zero rows under RLS', async () => {
    seedApiKeysMswState({
      apiKeys: [
        { id: 'key-uuid-1', api_key_id: 'k1', app_id: 'app-1', name: 'CI key', tenant_id: 'tenant-1', permissions: [] },
      ],
    });
    server.use(http.patch(`${SUPABASE_URL}/rest/v1/api_key`, () => HttpResponse.json([])));

    const result = await updateApiKeyPermissionsAction({
      apiKeyId: 'k1',
      appId: 'app-1',
      permissions: ['trace.write'],
    });

    expect(result).toEqual({ ok: true, data: { ok: false, message: 'Update matched no rows' } });
  });

  // proves AC-060-06
  it('rejects granting an existing key permissions the caller does not themselves hold', async () => {
    seedAuthedMember({ permissions: ['api_key.update'] });
    let patchCalled = false;
    server.use(
      http.patch(`${SUPABASE_URL}/rest/v1/api_key`, () => {
        patchCalled = true;
        return HttpResponse.json([]);
      }),
    );

    const result = await updateApiKeyPermissionsAction({
      apiKeyId: 'k1',
      appId: 'app-1',
      permissions: ['environment.delete'],
    });

    expect(result).toEqual({
      ok: true,
      data: { ok: false, message: expect.stringContaining('environment.delete') },
    });
    expect(patchCalled).toBe(false);
  });
});

// proves AC-18
describe('features/api-keys/actions boundary', () => {
  it('imports neither the root admin client nor the root server client', async () => {
    const fs = await import('node:fs/promises');
    const source = await fs.readFile(new URL('./actions.ts', import.meta.url), 'utf-8');
    expect(source).not.toContain('@/supabaseAdminClient');
    expect(source).not.toContain('@/supabaseServerClient');
    expect(source).not.toContain('@/sections/');
    expect(source).not.toContain('@/services/');
  });
});
