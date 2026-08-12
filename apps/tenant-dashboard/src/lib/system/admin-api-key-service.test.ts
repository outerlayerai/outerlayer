/**
 * Unit tests for admin-api-key-service: minting (row + digest write) and
 * bearer verification (digest lookup, expiry/revocation fail-closed,
 * best-effort last-used bookkeeping). Supabase is faked at the HTTP layer
 * via MSW (`test-helpers/msw-handlers/admin-api-keys.ts`) — no hand-rolled
 * query-builder stubs.
 */

const requestHeaders = vi.hoisted(() => new Map<string, string>());
vi.mock("next/headers", () => ({
  headers: () => ({ get: (name: string) => requestHeaders.get(name.toLowerCase()) ?? null }),
}));

import { getAdminDataClient } from "./admin-client";
import {
  seedAdminApiKeysMswState,
  getTouchedAdminApiKeyIds,
  seedMembershipMswState,
} from "@/test-helpers/msw-handlers";
import {
  mintAdminApiKeySystem,
  verifyAdminApiKeyBearer,
  resolveAdminApiKeyContext,
  loadBearerServiceContext,
  ADMIN_API_KEY_PREFIX,
} from "./admin-api-key-service";

function requestWithAuth(authorization?: string): Request {
  return new Request("http://localhost/api/orgs/acme/members", {
    headers: authorization ? { authorization } : undefined,
  });
}

function setRequestHeaders(next: { authorization?: string; tenantId?: string }): void {
  requestHeaders.clear();
  if (next.authorization) requestHeaders.set("authorization", next.authorization);
  if (next.tenantId) requestHeaders.set("x-tenant-id", next.tenantId);
}

describe("mintAdminApiKeySystem", () => {
  it("writes the row and a digest that verifies back to the same tenant and permissions", async () => {
    const db = getAdminDataClient();

    const { plaintext, row } = await mintAdminApiKeySystem({
      rowClient: db,
      tenantId: "tenant-1",
      name: "CI automation",
      permissions: ["membership.read", "membership.insert"],
      expiresAt: null,
      createdBy: "user-1",
    });

    expect(plaintext.startsWith(ADMIN_API_KEY_PREFIX)).toBe(true);
    expect(row.admin_api_key_id).toEqual(expect.stringMatching(/^key_/));

    const auth = await verifyAdminApiKeyBearer(`Bearer ${plaintext}`, db);
    expect(auth).toEqual({
      adminApiKeyId: row.id,
      tenantId: "tenant-1",
      permissions: ["membership.read", "membership.insert"],
      createdBy: "user-1",
    });
  });

  it("never returns the same plaintext twice across two mints", async () => {
    const db = getAdminDataClient();
    const first = await mintAdminApiKeySystem({
      rowClient: db,
      tenantId: "tenant-1",
      name: "key-a",
      permissions: [],
      expiresAt: null,
      createdBy: "user-1",
    });
    const second = await mintAdminApiKeySystem({
      rowClient: db,
      tenantId: "tenant-1",
      name: "key-b",
      permissions: [],
      expiresAt: null,
      createdBy: "user-1",
    });
    expect(first.plaintext).not.toEqual(second.plaintext);
  });
});

describe("verifyAdminApiKeyBearer", () => {
  it("returns null when the Authorization header is missing", async () => {
    const auth = await verifyAdminApiKeyBearer(null, getAdminDataClient());
    expect(auth).toBeNull();
  });

  it("returns null for a non-Bearer scheme", async () => {
    const auth = await verifyAdminApiKeyBearer("Basic dXNlcjpwYXNz", getAdminDataClient());
    expect(auth).toBeNull();
  });

  it("returns null for a Bearer token that isn't an admin API key (wrong prefix)", async () => {
    const auth = await verifyAdminApiKeyBearer("Bearer sk_outerlayer_notanadminkey", getAdminDataClient());
    expect(auth).toBeNull();
  });

  it("returns null for a well-formed but unknown key", async () => {
    const auth = await verifyAdminApiKeyBearer(`Bearer ${ADMIN_API_KEY_PREFIX}doesnotexist`, getAdminDataClient());
    expect(auth).toBeNull();
  });

  it("returns null for a revoked key, even with a correct digest on file", async () => {
    const db = getAdminDataClient();
    const { plaintext, row } = await mintAdminApiKeySystem({
      rowClient: db,
      tenantId: "tenant-1",
      name: "revoked-key",
      permissions: ["membership.read"],
      expiresAt: null,
      createdBy: "user-1",
    });
    seedAdminApiKeysMswState({
      adminApiKeys: [
        {
          id: row.id,
          tenant_id: "tenant-1",
          name: "revoked-key",
          admin_api_key_id: row.admin_api_key_id,
          permissions: ["membership.read"],
          revoked_at: "2026-01-01T00:00:00.000Z",
        },
      ],
    });

    const auth = await verifyAdminApiKeyBearer(`Bearer ${plaintext}`, db);
    expect(auth).toBeNull();
  });

  it("returns null for an expired key", async () => {
    const db = getAdminDataClient();
    const { plaintext, row } = await mintAdminApiKeySystem({
      rowClient: db,
      tenantId: "tenant-1",
      name: "expired-key",
      permissions: ["membership.read"],
      expiresAt: null,
      createdBy: "user-1",
    });
    seedAdminApiKeysMswState({
      adminApiKeys: [
        {
          id: row.id,
          tenant_id: "tenant-1",
          name: "expired-key",
          admin_api_key_id: row.admin_api_key_id,
          permissions: ["membership.read"],
          expires_at: "2020-01-01T00:00:00.000Z",
        },
      ],
    });

    const auth = await verifyAdminApiKeyBearer(`Bearer ${plaintext}`, db);
    expect(auth).toBeNull();
  });

  it("touches last_used_at on a successful verify", async () => {
    const db = getAdminDataClient();
    const { plaintext, row } = await mintAdminApiKeySystem({
      rowClient: db,
      tenantId: "tenant-1",
      name: "active-key",
      permissions: ["membership.read"],
      expiresAt: null,
      createdBy: "user-1",
    });

    await verifyAdminApiKeyBearer(`Bearer ${plaintext}`, db);

    expect(getTouchedAdminApiKeyIds()).toEqual([row.id]);
  });
});

describe("resolveAdminApiKeyContext", () => {
  it("returns 'absent' when the request carries no Authorization header — the caller should try session auth", async () => {
    const result = await resolveAdminApiKeyContext(requestWithAuth(), undefined, getAdminDataClient());
    expect(result).toEqual({ status: "absent" });
  });

  it("returns 'absent' for a Bearer token that isn't an admin API key — a gateway sk_ key, say", async () => {
    const result = await resolveAdminApiKeyContext(
      requestWithAuth("Bearer sk_outerlayer_notanadminkey"),
      undefined,
      getAdminDataClient(),
    );
    expect(result).toEqual({ status: "absent" });
  });

  it("returns 'invalid' — never 'absent' — for a well-formed but unknown/expired/revoked admin key, so callers fail closed instead of falling through to session auth", async () => {
    const result = await resolveAdminApiKeyContext(
      requestWithAuth(`Bearer ${ADMIN_API_KEY_PREFIX}doesnotexist`),
      undefined,
      getAdminDataClient(),
    );
    expect(result).toEqual({ status: "invalid" });
  });

  it("returns 'ok' with a ServiceContext-shaped context carrying the key's tenant and a synthetic actor id, for a live key", async () => {
    const db = getAdminDataClient();
    const { plaintext, row } = await mintAdminApiKeySystem({
      rowClient: db,
      tenantId: "tenant-1",
      name: "automation",
      permissions: ["membership.read", "membership.insert"],
      expiresAt: null,
      createdBy: "user-1",
    });

    const result = await resolveAdminApiKeyContext(requestWithAuth(`Bearer ${plaintext}`), undefined, db);

    expect(result).toEqual({
      status: "ok",
      permissions: ["membership.read", "membership.insert"],
      context: {
        db,
        tenantId: "tenant-1",
        actor: { userId: `admin_api_key:${row.id}`, role: "" },
      },
    });
  });

  it("returns 'forbidden' when a live key doesn't hold the required permission", async () => {
    const db = getAdminDataClient();
    const { plaintext } = await mintAdminApiKeySystem({
      rowClient: db,
      tenantId: "tenant-1",
      name: "read-only",
      permissions: ["membership.read"],
      expiresAt: null,
      createdBy: "user-1",
    });

    const result = await resolveAdminApiKeyContext(
      requestWithAuth(`Bearer ${plaintext}`),
      "membership.delete",
      db,
    );

    expect(result).toEqual({ status: "forbidden", permissions: ["membership.read"] });
  });

  it("returns 'ok' when the live key holds the required permission", async () => {
    const db = getAdminDataClient();
    const { plaintext, row } = await mintAdminApiKeySystem({
      rowClient: db,
      tenantId: "tenant-1",
      name: "deleter",
      permissions: ["membership.delete"],
      expiresAt: null,
      createdBy: "user-1",
    });

    const result = await resolveAdminApiKeyContext(
      requestWithAuth(`Bearer ${plaintext}`),
      "membership.delete",
      db,
    );

    expect(result).toEqual({
      status: "ok",
      permissions: ["membership.delete"],
      context: {
        db,
        tenantId: "tenant-1",
        actor: { userId: `admin_api_key:${row.id}`, role: "" },
      },
    });
  });
});

describe("loadBearerServiceContext", () => {
  it("returns 401 for an invalid/unknown bearer token", async () => {
    setRequestHeaders({ authorization: `Bearer ${ADMIN_API_KEY_PREFIX}doesnotexist`, tenantId: "tenant-1" });

    const result = await loadBearerServiceContext(getAdminDataClient());

    expect(result).toEqual({ ok: false, status: 401, message: "Not authenticated" });
  });

  it("returns 403 when the key's tenant does not match the URL-resolved request tenant", async () => {
    const db = getAdminDataClient();
    const { plaintext } = await mintAdminApiKeySystem({
      rowClient: db,
      tenantId: "tenant-1",
      name: "cross-org key",
      permissions: ["membership.read"],
      expiresAt: null,
      createdBy: "creator-1",
    });
    setRequestHeaders({ authorization: `Bearer ${plaintext}`, tenantId: "tenant-2" });

    const result = await loadBearerServiceContext(db);

    expect(result).toEqual({
      ok: false,
      status: 403,
      message: "This key does not belong to this organization",
    });
  });

  it("returns 403 when the request resolves no tenant at all (unmapped org URL)", async () => {
    const db = getAdminDataClient();
    const { plaintext } = await mintAdminApiKeySystem({
      rowClient: db,
      tenantId: "tenant-1",
      name: "key",
      permissions: [],
      expiresAt: null,
      createdBy: "creator-1",
    });
    setRequestHeaders({ authorization: `Bearer ${plaintext}` });

    const result = await loadBearerServiceContext(db);

    expect(result).toEqual({
      ok: false,
      status: 403,
      message: "This key does not belong to this organization",
    });
  });

  it("returns 403 when the key's creator is no longer an active member of the tenant", async () => {
    const db = getAdminDataClient();
    const { plaintext } = await mintAdminApiKeySystem({
      rowClient: db,
      tenantId: "tenant-1",
      name: "orphaned key",
      permissions: ["membership.read"],
      expiresAt: null,
      createdBy: "creator-1",
    });
    setRequestHeaders({ authorization: `Bearer ${plaintext}`, tenantId: "tenant-1" });
    // No membership seeded for creator-1 in tenant-1 at all — never joined,
    // or already removed.

    const result = await loadBearerServiceContext(db);

    expect(result).toEqual({
      ok: false,
      status: 403,
      message: "This key's creator is no longer an active member",
    });
  });

  it("returns 403 when the key's creator's membership in the tenant is pending, not active", async () => {
    const db = getAdminDataClient();
    const { plaintext } = await mintAdminApiKeySystem({
      rowClient: db,
      tenantId: "tenant-1",
      name: "key",
      permissions: ["membership.read"],
      expiresAt: null,
      createdBy: "creator-1",
    });
    setRequestHeaders({ authorization: `Bearer ${plaintext}`, tenantId: "tenant-1" });
    seedMembershipMswState({
      memberships: [
        { id: "m-1", user_id: "creator-1", tenant_id: "tenant-1", role: "owner", status: "pending" },
      ],
    });

    const result = await loadBearerServiceContext(db);

    expect(result.ok).toBe(false);
  });

  it("returns an ok ServiceContext attributed to the key's creator, at the creator's CURRENT role, when everything checks out", async () => {
    const db = getAdminDataClient();
    const { plaintext } = await mintAdminApiKeySystem({
      rowClient: db,
      tenantId: "tenant-1",
      name: "automation",
      permissions: ["membership.read", "membership.insert"],
      expiresAt: null,
      createdBy: "creator-1",
    });
    setRequestHeaders({ authorization: `Bearer ${plaintext}`, tenantId: "tenant-1" });
    seedMembershipMswState({
      memberships: [
        { id: "m-1", user_id: "creator-1", tenant_id: "tenant-1", role: "owner", status: "active" },
      ],
    });

    const result = await loadBearerServiceContext(db);

    expect(result).toEqual({
      ok: true,
      keyPermissions: ["membership.read", "membership.insert"],
      ctx: {
        db,
        tenantId: "tenant-1",
        actor: { userId: "creator-1", role: "owner" },
      },
    });
  });

  it("resolves the creator's role, not any mint-time-cached value — a role change after minting is reflected immediately", async () => {
    const db = getAdminDataClient();
    const { plaintext } = await mintAdminApiKeySystem({
      rowClient: db,
      tenantId: "tenant-1",
      name: "automation",
      permissions: ["membership.read"],
      expiresAt: null,
      createdBy: "creator-1",
    });
    setRequestHeaders({ authorization: `Bearer ${plaintext}`, tenantId: "tenant-1" });
    // The creator was an owner at mint time but has since been demoted.
    seedMembershipMswState({
      memberships: [
        { id: "m-1", user_id: "creator-1", tenant_id: "tenant-1", role: "write", status: "active" },
      ],
    });

    const result = await loadBearerServiceContext(db);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.ctx.actor).toEqual({ userId: "creator-1", role: "write" });
    }
  });

  it("drops a permission the creator's CURRENT role no longer holds (demotion after mint), while keeping one it still holds — proves an intersection, not a blanket deny", async () => {
    const db = getAdminDataClient();
    // Minted while the creator was 'owner' — a role that holds both grants —
    // so the key itself carries both.
    const { plaintext } = await mintAdminApiKeySystem({
      rowClient: db,
      tenantId: "tenant-1",
      name: "automation",
      permissions: ["membership.read", "membership.insert"],
      expiresAt: null,
      createdBy: "creator-1",
    });
    setRequestHeaders({ authorization: `Bearer ${plaintext}`, tenantId: "tenant-1" });
    // The creator has since been demoted to 'read', which (per the seeded
    // built-in catalog) holds membership.read but NOT membership.insert.
    seedMembershipMswState({
      memberships: [
        { id: "m-1", user_id: "creator-1", tenant_id: "tenant-1", role: "read", status: "active" },
      ],
    });

    const result = await loadBearerServiceContext(db);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.keyPermissions).toEqual(["membership.read"]);
    }
  });

  it("grants nothing when the creator's CURRENT role holds none of the key's granted permissions", async () => {
    const db = getAdminDataClient();
    const { plaintext } = await mintAdminApiKeySystem({
      rowClient: db,
      tenantId: "tenant-1",
      name: "automation",
      permissions: ["membership.delete"],
      expiresAt: null,
      createdBy: "creator-1",
    });
    setRequestHeaders({ authorization: `Bearer ${plaintext}`, tenantId: "tenant-1" });
    // 'read' holds no membership.* write verbs.
    seedMembershipMswState({
      memberships: [
        { id: "m-1", user_id: "creator-1", tenant_id: "tenant-1", role: "read", status: "active" },
      ],
    });

    const result = await loadBearerServiceContext(db);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.keyPermissions).toEqual([]);
    }
  });

  it("leaves the key's effective permissions unchanged when the creator's role is unchanged from mint time (regression baseline)", async () => {
    const db = getAdminDataClient();
    const { plaintext } = await mintAdminApiKeySystem({
      rowClient: db,
      tenantId: "tenant-1",
      name: "automation",
      permissions: ["membership.read", "membership.insert", "membership.update"],
      expiresAt: null,
      createdBy: "creator-1",
    });
    setRequestHeaders({ authorization: `Bearer ${plaintext}`, tenantId: "tenant-1" });
    seedMembershipMswState({
      memberships: [
        { id: "m-1", user_id: "creator-1", tenant_id: "tenant-1", role: "owner", status: "active" },
      ],
    });

    const result = await loadBearerServiceContext(db);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.keyPermissions).toEqual(["membership.read", "membership.insert", "membership.update"]);
    }
  });

  it("fails closed with 403 when the creator holds a custom role, rather than guessing at its grants", async () => {
    const db = getAdminDataClient();
    const { plaintext } = await mintAdminApiKeySystem({
      rowClient: db,
      tenantId: "tenant-1",
      name: "automation",
      permissions: ["membership.read"],
      expiresAt: null,
      createdBy: "creator-1",
    });
    setRequestHeaders({ authorization: `Bearer ${plaintext}`, tenantId: "tenant-1" });
    seedMembershipMswState({
      memberships: [
        {
          id: "m-1",
          user_id: "creator-1",
          tenant_id: "tenant-1",
          role: "read",
          status: "active",
          custom_role_id: "custom-role-1",
        },
      ],
    });

    const result = await loadBearerServiceContext(db);

    expect(result).toEqual({
      ok: false,
      status: 403,
      message: "This key's creator holds a custom role, which bearer auth does not support yet",
    });
  });
});
