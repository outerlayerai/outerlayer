/**
 * `adminApiKeysService` — list and revoke run over the caller's RLS-scoped
 * `ctx.db`. The MSW `admin_api_key` table handler stands in for RLS.
 */

import { createMswRestClient } from "@/test-helpers/rest-client";
import { seedAdminApiKeysMswState } from "@/test-helpers/msw-handlers";
import type { ServiceContext } from "@/lib/action-kit/service-context";

import { adminApiKeysService } from "./service";

function makeCtx(): ServiceContext {
  return {
    db: createMswRestClient(),
    tenantId: "tenant-1",
    actor: { userId: "user-1", role: "owner" },
  };
}

describe("adminApiKeysService.list", () => {
  it("returns the tenant's keys, newest first, without exposing the digest", async () => {
    seedAdminApiKeysMswState({
      adminApiKeys: [
        {
          id: "key-1",
          tenant_id: "tenant-1",
          name: "older",
          admin_api_key_id: "admin_key_1",
          permissions: ["membership.read"],
          created_at: "2026-01-01T00:00:00.000Z",
        },
        {
          id: "key-2",
          tenant_id: "tenant-1",
          name: "newer",
          admin_api_key_id: "admin_key_2",
          permissions: ["membership.read", "membership.insert"],
          created_at: "2026-02-01T00:00:00.000Z",
        },
      ],
    });

    const rows = await adminApiKeysService.list(makeCtx());

    expect(rows.map((r) => r.name)).toEqual(["newer", "older"]);
    expect(Object.keys(rows[0]!)).not.toContain("key_digest");
  });
});

describe("adminApiKeysService.revoke", () => {
  it("stamps revoked_at on an active key", async () => {
    seedAdminApiKeysMswState({
      adminApiKeys: [
        {
          id: "key-1",
          tenant_id: "tenant-1",
          name: "target",
          admin_api_key_id: "admin_key_1",
          permissions: [],
        },
      ],
    });

    const result = await adminApiKeysService.revoke(makeCtx(), "key-1");

    expect(result).toEqual({ ok: true });
    const rows = await adminApiKeysService.list(makeCtx());
    expect(rows[0]!.revoked_at).not.toBeNull();
  });

  it("fails when the key is already revoked, rather than silently no-oping", async () => {
    seedAdminApiKeysMswState({
      adminApiKeys: [
        {
          id: "key-1",
          tenant_id: "tenant-1",
          name: "target",
          admin_api_key_id: "admin_key_1",
          permissions: [],
          revoked_at: "2026-01-01T00:00:00.000Z",
        },
      ],
    });

    const result = await adminApiKeysService.revoke(makeCtx(), "key-1");

    expect(result.ok).toBe(false);
  });
});
