/**
 * `managementApiKeysService` — list and revoke run over the caller's RLS-scoped
 * `ctx.db`. The MSW `management_api_key` table handler stands in for RLS.
 */

import { createMswRestClient } from "@/test-helpers/rest-client";
import { seedManagementApiKeysMswState } from "@/test-helpers/msw-handlers";
import type { ServiceContext } from "@/lib/action-kit/service-context";

import { managementApiKeysService } from "./service";

function makeCtx(): ServiceContext {
  return {
    db: createMswRestClient(),
    tenantId: "tenant-1",
    actor: { userId: "user-1", role: "owner" },
  };
}

describe("managementApiKeysService.list", () => {
  // proves AC-059-15
  it("returns the tenant's keys, newest first, without exposing the digest", async () => {
    seedManagementApiKeysMswState({
      managementApiKeys: [
        {
          id: "key-1",
          tenant_id: "tenant-1",
          name: "older",
          management_api_key_id: "admin_key_1",
          permissions: ["membership.read"],
          created_at: "2026-01-01T00:00:00.000Z",
        },
        {
          id: "key-2",
          tenant_id: "tenant-1",
          name: "newer",
          management_api_key_id: "admin_key_2",
          permissions: ["membership.read", "membership.insert"],
          created_at: "2026-02-01T00:00:00.000Z",
        },
      ],
    });

    const rows = await managementApiKeysService.list(makeCtx());

    expect(rows.map((r) => r.name)).toEqual(["newer", "older"]);
    expect(Object.keys(rows[0]!)).not.toContain("key_digest");
  });
});

describe("managementApiKeysService.revoke", () => {
  // proves AC-059-16
  it("stamps revoked_at on an active key", async () => {
    seedManagementApiKeysMswState({
      managementApiKeys: [
        {
          id: "key-1",
          tenant_id: "tenant-1",
          name: "target",
          management_api_key_id: "admin_key_1",
          permissions: [],
        },
      ],
    });

    const result = await managementApiKeysService.revoke(makeCtx(), "key-1");

    expect(result).toEqual({ ok: true });
    const rows = await managementApiKeysService.list(makeCtx());
    expect(rows[0]!.revoked_at).not.toBeNull();
  });

  // proves AC-059-16
  it("fails when the key is already revoked, rather than silently no-oping", async () => {
    seedManagementApiKeysMswState({
      managementApiKeys: [
        {
          id: "key-1",
          tenant_id: "tenant-1",
          name: "target",
          management_api_key_id: "admin_key_1",
          permissions: [],
          revoked_at: "2026-01-01T00:00:00.000Z",
        },
      ],
    });

    const result = await managementApiKeysService.revoke(makeCtx(), "key-1");

    expect(result.ok).toBe(false);
  });
});
