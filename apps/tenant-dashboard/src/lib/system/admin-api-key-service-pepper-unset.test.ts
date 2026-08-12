/**
 * Admin API keys are an optional feature: `ADMIN_API_KEY_PEPPER` unset must
 * not break boot for a deployment that never uses this (self-host
 * generous-default posture) — it must instead fail closed everywhere the
 * pepper would be needed. A dedicated file: it needs the pepper unset for
 * the WHOLE module, whereas `admin-api-key-service.test.ts` relies on the
 * global test setup's truthy `ADMIN_API_KEY_PEPPER` mock.
 */

vi.mock("@/config-global.server", () => ({
  ADMIN_API_KEY_PEPPER: undefined,
  SUPABASE_SECRET_KEY: "test-service-role-key",
}));

import type { SupabaseClient } from "@supabase/supabase-js";
import { createMswRestClient } from "@/test-helpers/rest-client";
import { mintAdminApiKeySystem, verifyAdminApiKeyBearer } from "./admin-api-key-service";

describe("mintAdminApiKeySystem — ADMIN_API_KEY_PEPPER unset", () => {
  it("throws a clear configuration error, before writing any row", async () => {
    const db = createMswRestClient();

    await expect(
      mintAdminApiKeySystem({
        rowClient: db,
        tenantId: "tenant-1",
        name: "key",
        permissions: [],
        expiresAt: null,
        createdBy: "user-1",
      }),
    ).rejects.toThrow(
      "Admin API keys are not configured on this deployment (ADMIN_API_KEY_PEPPER is unset)",
    );
  });
});

describe("verifyAdminApiKeyBearer — ADMIN_API_KEY_PEPPER unset", () => {
  it("rejects a well-formed bearer token as invalid, without any DB lookup", async () => {
    const rpc = vi.fn();
    const fakeAdminClient = { rpc } as unknown as SupabaseClient;

    const result = await verifyAdminApiKeyBearer("Bearer olk_anything", fakeAdminClient);

    expect(result).toBeNull();
    expect(rpc).not.toHaveBeenCalled();
  });
});
