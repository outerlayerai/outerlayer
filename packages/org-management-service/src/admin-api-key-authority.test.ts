/**
 * Unit tests for admin-api-key-authority: minting (row + digest write) and
 * bearer verification/resolution. Supabase is faked in-memory — this package
 * has no MSW/Postgrest fixture harness of its own (that's dashboard test
 * infra), so tables and RPCs are modeled directly as small stores, mirroring
 * `verify_admin_api_key`'s revoked/expired filtering and `role_permissions`'
 * lookup semantics without depending on real Postgres.
 */
import { describe, it, expect, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  ADMIN_API_KEY_PREFIX,
  mintAdminApiKey,
  verifyAdminApiKeyBearer,
  resolveAdminApiKeyContext,
  resolveBearerServiceContext,
} from './admin-api-key-authority';

const PEPPER = 'test-pepper-value';

interface FakeAdminApiKeyRow {
  id: string;
  tenant_id: string;
  admin_api_key_id: string;
  name: string;
  permissions: string[];
  key_digest?: string;
  revoked_at?: string | null;
  expires_at?: string | null;
  created_by?: string | null;
  last_used_at?: string | null;
}

interface FakeMembershipRow {
  user_id: string;
  tenant_id: string;
  role: string;
  status: string;
  custom_role_id?: string | null;
}

interface FakeState {
  adminApiKeys: FakeAdminApiKeyRow[];
  tenants: Array<{ tenant_id: string; organization_name: string }>;
  memberships: FakeMembershipRow[];
  rolePermissions: Record<string, string[]>;
  touchedIds: string[];
}

let nextId = 0;

function makeFakeAdminClient(overrides: Partial<FakeState> = {}): { client: SupabaseClient; state: FakeState } {
  const state: FakeState = {
    adminApiKeys: [],
    tenants: [],
    memberships: [],
    rolePermissions: { owner: ['membership.read', 'membership.insert', 'membership.update', 'membership.delete'], write: ['membership.read', 'membership.insert'], read: ['membership.read'] },
    touchedIds: [],
    ...overrides,
  };

  const client = {
    from(table: string) {
      if (table === 'admin_api_key') {
        return {
          insert(payload: Record<string, unknown>) {
            return {
              select() {
                return {
                  single: async () => {
                    const row: FakeAdminApiKeyRow = {
                      id: `row-${nextId++}`,
                      tenant_id: payload.tenant_id as string,
                      admin_api_key_id: payload.admin_api_key_id as string,
                      name: payload.name as string,
                      permissions: payload.permissions as string[],
                      expires_at: (payload.expires_at as string | null) ?? null,
                      created_by: (payload.created_by as string | null) ?? null,
                      revoked_at: null,
                    };
                    state.adminApiKeys.push(row);
                    return { data: row, error: null };
                  },
                };
              },
            };
          },
          delete() {
            const chain = {
              eq: (_col: string, val: string) => {
                state.adminApiKeys = state.adminApiKeys.filter((r) => r.id !== val);
                return Promise.resolve({ error: null });
              },
            };
            return chain;
          },
        };
      }
      if (table === 'tenant') {
        return {
          select() {
            return {
              ilike: (_col: string, pattern: string) => {
                const literal = pattern.toLowerCase();
                return {
                  limit: () => ({
                    maybeSingle: async () => {
                      const match = state.tenants.find(
                        (t) => t.organization_name.toLowerCase() === literal,
                      );
                      return { data: match ? { tenant_id: match.tenant_id } : null, error: null };
                    },
                  }),
                };
              },
            };
          },
        };
      }
      if (table === 'membership') {
        return {
          select() {
            const filters: Record<string, unknown> = {};
            const chain = {
              eq(col: string, val: unknown) {
                filters[col] = val;
                return chain;
              },
              maybeSingle: async () => {
                const match = state.memberships.find(
                  (m) =>
                    m.user_id === filters.user_id &&
                    m.tenant_id === filters.tenant_id &&
                    m.status === filters.status,
                );
                return {
                  data: match ? { role: match.role, custom_role_id: match.custom_role_id ?? null } : null,
                  error: null,
                };
              },
            };
            return chain;
          },
        };
      }
      if (table === 'role_permissions') {
        return {
          select() {
            return {
              eq: async (_col: string, role: string) => ({
                data: (state.rolePermissions[role] ?? []).map((permission) => ({ permission })),
                error: null,
              }),
            };
          },
        };
      }
      throw new Error(`unstubbed table: ${table}`);
    },
    rpc: vi.fn(async (fn: string, args: Record<string, unknown>) => {
      if (fn === 'set_admin_api_key_secret') {
        const row = state.adminApiKeys.find((r) => r.id === args.p_admin_api_key_id);
        if (row) row.key_digest = args.p_key_digest as string;
        return { error: null };
      }
      if (fn === 'verify_admin_api_key') {
        const now = Date.now();
        const row = state.adminApiKeys.find(
          (r) =>
            r.key_digest === args.p_key_digest &&
            !r.revoked_at &&
            (!r.expires_at || new Date(r.expires_at).getTime() > now),
        );
        if (!row) return { data: null, error: null };
        return {
          data: {
            adminApiKeyId: row.id,
            tenantId: row.tenant_id,
            permissions: row.permissions,
            createdBy: row.created_by ?? null,
          },
          error: null,
        };
      }
      if (fn === 'touch_admin_api_key_last_used') {
        state.touchedIds.push(args.p_admin_api_key_id as string);
        return { error: null };
      }
      throw new Error(`unstubbed rpc: ${fn}`);
    }),
  } as unknown as SupabaseClient;

  return { client, state };
}

describe('mintAdminApiKey', () => {
  it('writes the row and a digest that verifies back to the same tenant and permissions', async () => {
    const { client } = makeFakeAdminClient();

    const { plaintext, row } = await mintAdminApiKey({
      rowClient: client,
      adminClient: client,
      pepper: PEPPER,
      tenantId: 'tenant-1',
      name: 'CI automation',
      permissions: ['membership.read', 'membership.insert'],
      expiresAt: null,
      createdBy: 'user-1',
    });

    expect(plaintext.startsWith(ADMIN_API_KEY_PREFIX)).toBe(true);
    expect(row.admin_api_key_id).toEqual(expect.stringMatching(/^key_/));

    const auth = await verifyAdminApiKeyBearer(`Bearer ${plaintext}`, client, PEPPER);
    expect(auth).toEqual({
      adminApiKeyId: row.id,
      tenantId: 'tenant-1',
      permissions: ['membership.read', 'membership.insert'],
      createdBy: 'user-1',
    });
  });

  it('never returns the same plaintext twice across two mints', async () => {
    const { client } = makeFakeAdminClient();
    const first = await mintAdminApiKey({
      rowClient: client, adminClient: client, pepper: PEPPER, tenantId: 'tenant-1',
      name: 'key-a', permissions: [], expiresAt: null, createdBy: 'user-1',
    });
    const second = await mintAdminApiKey({
      rowClient: client, adminClient: client, pepper: PEPPER, tenantId: 'tenant-1',
      name: 'key-b', permissions: [], expiresAt: null, createdBy: 'user-1',
    });
    expect(first.plaintext).not.toEqual(second.plaintext);
  });

  it('throws a clear configuration error, before writing any row, when the pepper is unset', async () => {
    const { client, state } = makeFakeAdminClient();

    await expect(
      mintAdminApiKey({
        rowClient: client, adminClient: client, pepper: undefined, tenantId: 'tenant-1',
        name: 'key', permissions: [], expiresAt: null, createdBy: 'user-1',
      }),
    ).rejects.toThrow('Admin API keys are not configured on this deployment (ADMIN_API_KEY_PEPPER is unset)');
    expect(state.adminApiKeys).toEqual([]);
  });

  it('deletes the row when the digest RPC fails, rather than leaving an unverifiable key', async () => {
    const { client, state } = makeFakeAdminClient();
    client.rpc = vi.fn(async (fn: string) => {
      if (fn === 'set_admin_api_key_secret') return { error: new Error('rpc failed') };
      throw new Error(`unexpected rpc: ${fn}`);
    }) as unknown as SupabaseClient['rpc'];

    await expect(
      mintAdminApiKey({
        rowClient: client, adminClient: client, pepper: PEPPER, tenantId: 'tenant-1',
        name: 'key', permissions: [], expiresAt: null, createdBy: 'user-1',
      }),
    ).rejects.toThrow();
    expect(state.adminApiKeys).toEqual([]);
  });
});

describe('verifyAdminApiKeyBearer', () => {
  it('returns null when the Authorization header is missing', async () => {
    const { client } = makeFakeAdminClient();
    expect(await verifyAdminApiKeyBearer(null, client, PEPPER)).toBeNull();
  });

  it('returns null for a non-Bearer scheme', async () => {
    const { client } = makeFakeAdminClient();
    expect(await verifyAdminApiKeyBearer('Basic dXNlcjpwYXNz', client, PEPPER)).toBeNull();
  });

  it("returns null for a Bearer token that isn't an admin API key (wrong prefix)", async () => {
    const { client } = makeFakeAdminClient();
    expect(await verifyAdminApiKeyBearer('Bearer sk_outerlayer_notanadminkey', client, PEPPER)).toBeNull();
  });

  it('returns null for a well-formed but unknown key', async () => {
    const { client } = makeFakeAdminClient();
    expect(await verifyAdminApiKeyBearer(`Bearer ${ADMIN_API_KEY_PREFIX}doesnotexist`, client, PEPPER)).toBeNull();
  });

  it('rejects a well-formed bearer token as invalid, without any DB lookup, when the pepper is unset', async () => {
    const { client } = makeFakeAdminClient();
    const result = await verifyAdminApiKeyBearer(`Bearer ${ADMIN_API_KEY_PREFIX}anything`, client, undefined);
    expect(result).toBeNull();
    expect(client.rpc).not.toHaveBeenCalled();
  });

  it('returns null for a revoked key, even with a correct digest on file', async () => {
    const { client, state } = makeFakeAdminClient();
    const { plaintext, row } = await mintAdminApiKey({
      rowClient: client, adminClient: client, pepper: PEPPER, tenantId: 'tenant-1',
      name: 'revoked-key', permissions: ['membership.read'], expiresAt: null, createdBy: 'user-1',
    });
    state.adminApiKeys.find((r) => r.id === row.id)!.revoked_at = '2026-01-01T00:00:00.000Z';

    expect(await verifyAdminApiKeyBearer(`Bearer ${plaintext}`, client, PEPPER)).toBeNull();
  });

  it('returns null for an expired key', async () => {
    const { client, state } = makeFakeAdminClient();
    const { plaintext, row } = await mintAdminApiKey({
      rowClient: client, adminClient: client, pepper: PEPPER, tenantId: 'tenant-1',
      name: 'expired-key', permissions: ['membership.read'], expiresAt: null, createdBy: 'user-1',
    });
    state.adminApiKeys.find((r) => r.id === row.id)!.expires_at = '2020-01-01T00:00:00.000Z';

    expect(await verifyAdminApiKeyBearer(`Bearer ${plaintext}`, client, PEPPER)).toBeNull();
  });

  it('touches last_used_at on a successful verify', async () => {
    const { client, state } = makeFakeAdminClient();
    const { plaintext, row } = await mintAdminApiKey({
      rowClient: client, adminClient: client, pepper: PEPPER, tenantId: 'tenant-1',
      name: 'active-key', permissions: ['membership.read'], expiresAt: null, createdBy: 'user-1',
    });

    await verifyAdminApiKeyBearer(`Bearer ${plaintext}`, client, PEPPER);

    expect(state.touchedIds).toEqual([row.id]);
  });
});

function requestAuthHeader(request: Request): string | null {
  return request.headers.get('authorization');
}

function requestWithAuth(authorization?: string): Request {
  return new Request('http://localhost/api/orgs/acme/members', {
    headers: authorization ? { authorization } : undefined,
  });
}

describe('resolveAdminApiKeyContext', () => {
  it('returns absent when the request carries no Authorization header', async () => {
    const { client } = makeFakeAdminClient();
    const result = await resolveAdminApiKeyContext(requestAuthHeader(requestWithAuth()), client, PEPPER);
    expect(result).toEqual({ status: 'absent' });
  });

  it("returns absent for a Bearer token that isn't an admin API key — a gateway sk_ key, say", async () => {
    const { client } = makeFakeAdminClient();
    const result = await resolveAdminApiKeyContext(
      requestAuthHeader(requestWithAuth('Bearer sk_outerlayer_notanadminkey')),
      client,
      PEPPER,
    );
    expect(result).toEqual({ status: 'absent' });
  });

  it("returns invalid — never absent — for a well-formed but unknown key, so callers fail closed instead of falling through to session auth", async () => {
    const { client } = makeFakeAdminClient();
    const result = await resolveAdminApiKeyContext(
      requestAuthHeader(requestWithAuth(`Bearer ${ADMIN_API_KEY_PREFIX}doesnotexist`)),
      client,
      PEPPER,
    );
    expect(result).toEqual({ status: 'invalid' });
  });

  it("returns ok with a ServiceContext-shaped context carrying the key's tenant and a synthetic actor id", async () => {
    const { client } = makeFakeAdminClient();
    const { plaintext, row } = await mintAdminApiKey({
      rowClient: client, adminClient: client, pepper: PEPPER, tenantId: 'tenant-1',
      name: 'automation', permissions: ['membership.read', 'membership.insert'], expiresAt: null, createdBy: 'user-1',
    });

    const result = await resolveAdminApiKeyContext(
      requestAuthHeader(requestWithAuth(`Bearer ${plaintext}`)),
      client,
      PEPPER,
    );

    expect(result).toEqual({
      status: 'ok',
      permissions: ['membership.read', 'membership.insert'],
      context: {
        db: client,
        tenantId: 'tenant-1',
        actor: { userId: `admin_api_key:${row.id}`, role: '' },
      },
    });
  });

  it("returns forbidden when a live key doesn't hold the required permission", async () => {
    const { client } = makeFakeAdminClient();
    const { plaintext } = await mintAdminApiKey({
      rowClient: client, adminClient: client, pepper: PEPPER, tenantId: 'tenant-1',
      name: 'read-only', permissions: ['membership.read'], expiresAt: null, createdBy: 'user-1',
    });

    const result = await resolveAdminApiKeyContext(
      requestAuthHeader(requestWithAuth(`Bearer ${plaintext}`)),
      client,
      PEPPER,
      'membership.delete',
    );

    expect(result).toEqual({ status: 'forbidden', permissions: ['membership.read'] });
  });
});

describe('resolveBearerServiceContext', () => {
  it('returns 401 for an invalid/unknown bearer token', async () => {
    const { client } = makeFakeAdminClient({ tenants: [{ tenant_id: 'tenant-1', organization_name: 'acme' }] });

    const result = await resolveBearerServiceContext({
      authorizationHeader: `Bearer ${ADMIN_API_KEY_PREFIX}doesnotexist`,
      orgName: 'acme',
      adminClient: client,
      pepper: PEPPER,
    });

    expect(result).toEqual({ ok: false, status: 401, message: 'Not authenticated' });
  });

  // proves AC-059-17
  it("returns 403 when the key's tenant does not match the tenant the URL org resolves to", async () => {
    const { client } = makeFakeAdminClient({
      tenants: [
        { tenant_id: 'tenant-1', organization_name: 'acme' },
        { tenant_id: 'tenant-2', organization_name: 'other-org' },
      ],
    });
    const { plaintext } = await mintAdminApiKey({
      rowClient: client, adminClient: client, pepper: PEPPER, tenantId: 'tenant-1',
      name: 'cross-org key', permissions: ['membership.read'], expiresAt: null, createdBy: 'creator-1',
    });

    const result = await resolveBearerServiceContext({
      authorizationHeader: `Bearer ${plaintext}`,
      orgName: 'other-org',
      adminClient: client,
      pepper: PEPPER,
    });

    expect(result).toEqual({ ok: false, status: 403, message: 'This key does not belong to this organization' });
  });

  it('returns 403 when the URL org names no tenant at all', async () => {
    const { client } = makeFakeAdminClient({ tenants: [{ tenant_id: 'tenant-1', organization_name: 'acme' }] });
    const { plaintext } = await mintAdminApiKey({
      rowClient: client, adminClient: client, pepper: PEPPER, tenantId: 'tenant-1',
      name: 'key', permissions: [], expiresAt: null, createdBy: 'creator-1',
    });

    const result = await resolveBearerServiceContext({
      authorizationHeader: `Bearer ${plaintext}`,
      orgName: 'no-such-org',
      adminClient: client,
      pepper: PEPPER,
    });

    expect(result).toEqual({ ok: false, status: 403, message: 'This key does not belong to this organization' });
  });

  it('resolves the org name case-insensitively, same as the session path', async () => {
    const { client } = makeFakeAdminClient({
      tenants: [{ tenant_id: 'tenant-1', organization_name: 'acme' }],
      memberships: [{ user_id: 'creator-1', tenant_id: 'tenant-1', role: 'owner', status: 'active' }],
    });
    const { plaintext } = await mintAdminApiKey({
      rowClient: client, adminClient: client, pepper: PEPPER, tenantId: 'tenant-1',
      name: 'key', permissions: ['membership.read'], expiresAt: null, createdBy: 'creator-1',
    });

    const result = await resolveBearerServiceContext({
      authorizationHeader: `Bearer ${plaintext}`,
      orgName: 'ACME',
      adminClient: client,
      pepper: PEPPER,
    });

    expect(result.ok).toBe(true);
  });

  // proves AC-059-19
  it("returns 403 when the key's creator is no longer an active member of the tenant", async () => {
    const { client } = makeFakeAdminClient({ tenants: [{ tenant_id: 'tenant-1', organization_name: 'acme' }] });
    const { plaintext } = await mintAdminApiKey({
      rowClient: client, adminClient: client, pepper: PEPPER, tenantId: 'tenant-1',
      name: 'orphaned key', permissions: ['membership.read'], expiresAt: null, createdBy: 'creator-1',
    });

    const result = await resolveBearerServiceContext({
      authorizationHeader: `Bearer ${plaintext}`,
      orgName: 'acme',
      adminClient: client,
      pepper: PEPPER,
    });

    expect(result).toEqual({ ok: false, status: 403, message: "This key's creator is no longer an active member" });
  });

  it("returns 403 when the key's creator's membership in the tenant is pending, not active", async () => {
    const { client } = makeFakeAdminClient({
      tenants: [{ tenant_id: 'tenant-1', organization_name: 'acme' }],
      memberships: [{ user_id: 'creator-1', tenant_id: 'tenant-1', role: 'owner', status: 'pending' }],
    });
    const { plaintext } = await mintAdminApiKey({
      rowClient: client, adminClient: client, pepper: PEPPER, tenantId: 'tenant-1',
      name: 'key', permissions: ['membership.read'], expiresAt: null, createdBy: 'creator-1',
    });

    const result = await resolveBearerServiceContext({
      authorizationHeader: `Bearer ${plaintext}`,
      orgName: 'acme',
      adminClient: client,
      pepper: PEPPER,
    });

    expect(result.ok).toBe(false);
  });

  it("returns an ok ServiceContext attributed to the key's creator, at the creator's CURRENT role, when everything checks out", async () => {
    const { client } = makeFakeAdminClient({
      tenants: [{ tenant_id: 'tenant-1', organization_name: 'acme' }],
      memberships: [{ user_id: 'creator-1', tenant_id: 'tenant-1', role: 'owner', status: 'active' }],
    });
    const { plaintext } = await mintAdminApiKey({
      rowClient: client, adminClient: client, pepper: PEPPER, tenantId: 'tenant-1',
      name: 'automation', permissions: ['membership.read', 'membership.insert'], expiresAt: null, createdBy: 'creator-1',
    });

    const result = await resolveBearerServiceContext({
      authorizationHeader: `Bearer ${plaintext}`,
      orgName: 'acme',
      adminClient: client,
      pepper: PEPPER,
    });

    expect(result).toEqual({
      ok: true,
      keyPermissions: ['membership.read', 'membership.insert'],
      ctx: {
        db: client,
        tenantId: 'tenant-1',
        actor: { userId: 'creator-1', role: 'owner' },
      },
    });
  });

  it('resolves the creator role, not any mint-time-cached value — a role change after minting is reflected immediately', async () => {
    const { client } = makeFakeAdminClient({
      tenants: [{ tenant_id: 'tenant-1', organization_name: 'acme' }],
      memberships: [{ user_id: 'creator-1', tenant_id: 'tenant-1', role: 'write', status: 'active' }],
    });
    const { plaintext } = await mintAdminApiKey({
      rowClient: client, adminClient: client, pepper: PEPPER, tenantId: 'tenant-1',
      name: 'automation', permissions: ['membership.read'], expiresAt: null, createdBy: 'creator-1',
    });

    const result = await resolveBearerServiceContext({
      authorizationHeader: `Bearer ${plaintext}`,
      orgName: 'acme',
      adminClient: client,
      pepper: PEPPER,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.ctx.actor).toEqual({ userId: 'creator-1', role: 'write' });
    }
  });

  // proves AC-059-20
  it("drops a permission the creator's CURRENT role no longer holds, while keeping one it still holds — proves an intersection, not a blanket deny", async () => {
    const { client } = makeFakeAdminClient({
      tenants: [{ tenant_id: 'tenant-1', organization_name: 'acme' }],
      memberships: [{ user_id: 'creator-1', tenant_id: 'tenant-1', role: 'read', status: 'active' }],
    });
    const { plaintext } = await mintAdminApiKey({
      rowClient: client, adminClient: client, pepper: PEPPER, tenantId: 'tenant-1',
      name: 'automation', permissions: ['membership.read', 'membership.insert'], expiresAt: null, createdBy: 'creator-1',
    });

    const result = await resolveBearerServiceContext({
      authorizationHeader: `Bearer ${plaintext}`,
      orgName: 'acme',
      adminClient: client,
      pepper: PEPPER,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.keyPermissions).toEqual(['membership.read']);
    }
  });

  it("fails closed with 403 when the creator holds a custom role, rather than guessing at its grants", async () => {
    const { client } = makeFakeAdminClient({
      tenants: [{ tenant_id: 'tenant-1', organization_name: 'acme' }],
      memberships: [{ user_id: 'creator-1', tenant_id: 'tenant-1', role: 'read', status: 'active', custom_role_id: 'custom-role-1' }],
    });
    const { plaintext } = await mintAdminApiKey({
      rowClient: client, adminClient: client, pepper: PEPPER, tenantId: 'tenant-1',
      name: 'automation', permissions: ['membership.read'], expiresAt: null, createdBy: 'creator-1',
    });

    const result = await resolveBearerServiceContext({
      authorizationHeader: `Bearer ${plaintext}`,
      orgName: 'acme',
      adminClient: client,
      pepper: PEPPER,
    });

    expect(result).toEqual({
      ok: false,
      status: 403,
      message: "This key's creator holds a custom role, which bearer auth does not support yet",
    });
  });
});
