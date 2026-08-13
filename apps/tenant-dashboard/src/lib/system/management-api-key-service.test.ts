/**
 * Wrapper-wiring tests for the management-API-key module. Mint behavior
 * itself (digest hashing, row/digest write ordering) lives in
 * `@repo/org-management-service` and is covered by its own suite — this file
 * pins that the dashboard wrapper threads `MANAGEMENT_API_KEY_PEPPER` + the
 * service-role client into the package's mint call correctly.
 */
const { mintManagementApiKeyFn } = vi.hoisted(() => ({
  mintManagementApiKeyFn: vi.fn(),
}));

vi.mock("@repo/org-management-service", () => ({
  MANAGEMENT_API_KEY_PREFIX: "olk_",
  mintManagementApiKey: mintManagementApiKeyFn,
}));

vi.mock("@/config-global.server", () => ({
  MANAGEMENT_API_KEY_PEPPER: "test-pepper",
  SUPABASE_SECRET_KEY: "test-service-role-key",
}));

import { getAdminDataClient } from "./admin-client";
import { mintManagementApiKeySystem, MANAGEMENT_API_KEY_PREFIX } from "./management-api-key-service";

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
});
