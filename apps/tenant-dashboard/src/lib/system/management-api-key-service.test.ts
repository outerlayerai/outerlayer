/**
 * Wrapper-wiring tests for the management-API-key module. Mint/verify/resolve
 * behavior itself (digest hashing, revoked/expired filtering, tenant
 * binding, creator-membership resolution, permission intersection) lives in
 * `@repo/org-management-service` and is covered by its own suite — this
 * file pins that the dashboard wrapper reads `next/headers` and threads
 * `MANAGEMENT_API_KEY_PEPPER` + the service-role client into the package calls
 * correctly.
 */
const requestHeaders = vi.hoisted(() => new Map<string, string>());
vi.mock("next/headers", () => ({
  headers: () => ({ get: (name: string) => requestHeaders.get(name.toLowerCase()) ?? null }),
}));

const { mintManagementApiKeyFn, verifyManagementApiKeyBearerFn, resolveManagementApiKeyContextFn, resolveBearerServiceContextFn } =
  vi.hoisted(() => ({
    mintManagementApiKeyFn: vi.fn(),
    verifyManagementApiKeyBearerFn: vi.fn(),
    resolveManagementApiKeyContextFn: vi.fn(),
    resolveBearerServiceContextFn: vi.fn(),
  }));

vi.mock("@repo/org-management-service", () => ({
  MANAGEMENT_API_KEY_PREFIX: "olk_",
  mintManagementApiKey: mintManagementApiKeyFn,
  verifyManagementApiKeyBearer: verifyManagementApiKeyBearerFn,
  resolveManagementApiKeyContext: resolveManagementApiKeyContextFn,
  resolveBearerServiceContext: resolveBearerServiceContextFn,
}));

vi.mock("@/config-global.server", () => ({
  MANAGEMENT_API_KEY_PEPPER: "test-pepper",
  SUPABASE_SECRET_KEY: "test-service-role-key",
}));

import { getAdminDataClient } from "./admin-client";
import {
  mintManagementApiKeySystem,
  verifyManagementApiKeyBearer,
  resolveManagementApiKeyContext,
  loadBearerServiceContext,
  MANAGEMENT_API_KEY_PREFIX,
} from "./management-api-key-service";

function setRequestHeaders(next: { authorization?: string }): void {
  requestHeaders.clear();
  if (next.authorization) requestHeaders.set("authorization", next.authorization);
}

describe("management-api-key-service wrapper", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("re-exports the package's MANAGEMENT_API_KEY_PREFIX", () => {
    expect(MANAGEMENT_API_KEY_PREFIX).toBe("olk_");
  });

  it("mintManagementApiKeySystem injects the pepper and a service-role admin client", async () => {
    mintManagementApiKeyFn.mockResolvedValue({ plaintext: "olk_x", row: { id: "1", management_api_key_id: "key_1" } });
    const rowClient = getAdminDataClient();

    await mintManagementApiKeySystem({
      rowClient,
      tenantId: "tenant-1",
      name: "key",
      permissions: ["membership.read"],
      expiresAt: null,
      createdBy: "user-1",
    });

    expect(mintManagementApiKeyFn).toHaveBeenCalledWith({
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

  it("verifyManagementApiKeyBearer threads the pepper alongside the header and client", async () => {
    verifyManagementApiKeyBearerFn.mockResolvedValue(null);
    const adminClient = getAdminDataClient();

    await verifyManagementApiKeyBearer("Bearer olk_x", adminClient);

    expect(verifyManagementApiKeyBearerFn).toHaveBeenCalledWith("Bearer olk_x", adminClient, "test-pepper");
  });

  it("resolveManagementApiKeyContext extracts the Authorization header off the Request and threads the pepper", async () => {
    resolveManagementApiKeyContextFn.mockResolvedValue({ status: "absent" });
    const adminClient = getAdminDataClient();
    const request = new Request("http://localhost/api/orgs/acme/members", {
      headers: { authorization: "Bearer olk_x" },
    });

    await resolveManagementApiKeyContext(request, "membership.read", adminClient);

    expect(resolveManagementApiKeyContextFn).toHaveBeenCalledWith("Bearer olk_x", adminClient, "test-pepper", "membership.read");
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
