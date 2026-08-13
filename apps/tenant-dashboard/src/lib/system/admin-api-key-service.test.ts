/**
 * Wrapper-wiring tests for the admin-API-key module. Mint/verify/resolve
 * behavior itself (digest hashing, revoked/expired filtering, tenant
 * binding, creator-membership resolution, permission intersection) lives in
 * `@repo/org-management-service` and is covered by its own suite — this
 * file pins that the dashboard wrapper reads `next/headers` and threads
 * `ADMIN_API_KEY_PEPPER` + the service-role client into the package calls
 * correctly.
 */
const requestHeaders = vi.hoisted(() => new Map<string, string>());
vi.mock("next/headers", () => ({
  headers: () => ({ get: (name: string) => requestHeaders.get(name.toLowerCase()) ?? null }),
}));

const { mintAdminApiKeyFn, verifyAdminApiKeyBearerFn, resolveAdminApiKeyContextFn, resolveBearerServiceContextFn } =
  vi.hoisted(() => ({
    mintAdminApiKeyFn: vi.fn(),
    verifyAdminApiKeyBearerFn: vi.fn(),
    resolveAdminApiKeyContextFn: vi.fn(),
    resolveBearerServiceContextFn: vi.fn(),
  }));

vi.mock("@repo/org-management-service", () => ({
  ADMIN_API_KEY_PREFIX: "olk_",
  mintAdminApiKey: mintAdminApiKeyFn,
  verifyAdminApiKeyBearer: verifyAdminApiKeyBearerFn,
  resolveAdminApiKeyContext: resolveAdminApiKeyContextFn,
  resolveBearerServiceContext: resolveBearerServiceContextFn,
}));

vi.mock("@/config-global.server", () => ({
  ADMIN_API_KEY_PEPPER: "test-pepper",
  SUPABASE_SECRET_KEY: "test-service-role-key",
}));

import { getAdminDataClient } from "./admin-client";
import {
  mintAdminApiKeySystem,
  verifyAdminApiKeyBearer,
  resolveAdminApiKeyContext,
  loadBearerServiceContext,
  ADMIN_API_KEY_PREFIX,
} from "./admin-api-key-service";

function setRequestHeaders(next: { authorization?: string }): void {
  requestHeaders.clear();
  if (next.authorization) requestHeaders.set("authorization", next.authorization);
}

describe("admin-api-key-service wrapper", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("re-exports the package's ADMIN_API_KEY_PREFIX", () => {
    expect(ADMIN_API_KEY_PREFIX).toBe("olk_");
  });

  it("mintAdminApiKeySystem injects the pepper and a service-role admin client", async () => {
    mintAdminApiKeyFn.mockResolvedValue({ plaintext: "olk_x", row: { id: "1", admin_api_key_id: "key_1" } });
    const rowClient = getAdminDataClient();

    await mintAdminApiKeySystem({
      rowClient,
      tenantId: "tenant-1",
      name: "key",
      permissions: ["membership.read"],
      expiresAt: null,
      createdBy: "user-1",
    });

    expect(mintAdminApiKeyFn).toHaveBeenCalledWith({
      rowClient,
      tenantId: "tenant-1",
      name: "key",
      permissions: ["membership.read"],
      expiresAt: null,
      createdBy: "user-1",
      pepper: "test-pepper",
      adminClient: expect.anything(),
    });
  });

  it("verifyAdminApiKeyBearer threads the pepper alongside the header and client", async () => {
    verifyAdminApiKeyBearerFn.mockResolvedValue(null);
    const adminClient = getAdminDataClient();

    await verifyAdminApiKeyBearer("Bearer olk_x", adminClient);

    expect(verifyAdminApiKeyBearerFn).toHaveBeenCalledWith("Bearer olk_x", adminClient, "test-pepper");
  });

  it("resolveAdminApiKeyContext extracts the Authorization header off the Request and threads the pepper", async () => {
    resolveAdminApiKeyContextFn.mockResolvedValue({ status: "absent" });
    const adminClient = getAdminDataClient();
    const request = new Request("http://localhost/api/orgs/acme/members", {
      headers: { authorization: "Bearer olk_x" },
    });

    await resolveAdminApiKeyContext(request, "membership.read", adminClient);

    expect(resolveAdminApiKeyContextFn).toHaveBeenCalledWith("Bearer olk_x", adminClient, "test-pepper", "membership.read");
  });

  it("loadBearerServiceContext reads the Authorization header via next/headers and threads orgName + pepper", async () => {
    resolveBearerServiceContextFn.mockResolvedValue({ ok: false, status: 401, message: "Not authenticated" });
    setRequestHeaders({ authorization: "Bearer olk_x" });
    const adminClient = getAdminDataClient();

    const result = await loadBearerServiceContext("acme", adminClient);

    expect(resolveBearerServiceContextFn).toHaveBeenCalledWith({
      authorizationHeader: "Bearer olk_x",
      orgName: "acme",
      adminClient,
      pepper: "test-pepper",
    });
    expect(result).toEqual({ ok: false, status: 401, message: "Not authenticated" });
  });
});
