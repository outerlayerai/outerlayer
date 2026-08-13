/**
 * createAdminApiKeyAction / revokeAdminApiKeyAction — gated on
 * `admin_api_key.insert` / `.delete`, clamped to the caller's own held
 * permissions (an unclamped mint is a privilege escalation: an `admin`
 * lacking `sso_config.update` must not be able to hand out a key that
 * outranks them). The context + permission seams are mocked; the write runs
 * for real against the MSW `admin_api_key` table.
 */

import { createMswRestClient } from "@/test-helpers/rest-client";
import { seedAdminApiKeysMswState } from "@/test-helpers/msw-handlers";
import { ADMIN_API_KEY_PREFIX } from "@/lib/system/admin-api-key-service";

const { loadCtxMock, checkPermMock, revalidateMock } = vi.hoisted(() => ({
  loadCtxMock: vi.fn(),
  checkPermMock: vi.fn(),
  revalidateMock: vi.fn(),
}));
vi.mock("@/lib/adapters", () => ({
  loadRequestServiceContext: loadCtxMock,
  checkRequestPermission: checkPermMock,
}));
vi.mock("next/cache", () => ({ revalidatePath: revalidateMock }));

import { createAdminApiKeyAction, revokeAdminApiKeyAction } from "./actions";

const TENANT_ID = "tenant-1";
const ADMIN_API_KEYS_SETTINGS_PATH = "/orgs/[orgName]/settings/admin-api-keys";

beforeEach(() => {
  loadCtxMock.mockResolvedValue({
    db: createMswRestClient(),
    tenantId: TENANT_ID,
    actor: { userId: "user-1", role: "owner" },
  });
  checkPermMock.mockResolvedValue(true);
});

describe("createAdminApiKeyAction", () => {
  // proves AC-059-13
  it("mints a key and returns the plaintext exactly once", async () => {
    const res = await createAdminApiKeyAction({
      name: "CI automation",
      permissions: ["membership.read"],
    });

    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("unreachable");
    expect(res.data).toEqual({ ok: true, apiKey: expect.stringMatching(new RegExp(`^${ADMIN_API_KEY_PREFIX}`)) });
    expect(revalidateMock).toHaveBeenCalledWith(ADMIN_API_KEYS_SETTINGS_PATH, "page");
  });

  it("denies an actor lacking admin_api_key.insert at the wrapper, minting nothing", async () => {
    checkPermMock.mockResolvedValue(false);

    const res = await createAdminApiKeyAction({
      name: "CI automation",
      permissions: ["membership.read"],
    });

    expect(res).toEqual({
      ok: false,
      error: { code: "forbidden", message: "Permission denied: admin_api_key.insert" },
    });
    expect(revalidateMock).not.toHaveBeenCalled();
  });

  // proves AC-059-14
  it("rejects a grant that exceeds the caller's own permissions instead of trimming it", async () => {
    // The wrapper's own admin_api_key.insert check passes; the in-handler
    // clamp denies the specific requested-but-unheld permission.
    checkPermMock.mockImplementation(
      async (_actor: unknown, permission: string) => permission !== "sso_config.update",
    );

    const res = await createAdminApiKeyAction({
      name: "CI automation",
      permissions: ["membership.read", "sso_config.update"],
    });

    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("unreachable");
    expect(res.data).toEqual({
      ok: false,
      message: "Cannot grant permissions you do not hold: sso_config.update",
    });
    expect(revalidateMock).not.toHaveBeenCalled();
  });
});

describe("revokeAdminApiKeyAction", () => {
  it("revokes an active key and revalidates", async () => {
    seedAdminApiKeysMswState({
      adminApiKeys: [
        {
          id: "key-1",
          tenant_id: TENANT_ID,
          name: "target",
          admin_api_key_id: "admin_key_1",
          permissions: [],
        },
      ],
    });

    const res = await revokeAdminApiKeyAction({ id: "key-1" });

    expect(res).toEqual({ ok: true, data: { ok: true } });
    expect(revalidateMock).toHaveBeenCalledWith(ADMIN_API_KEYS_SETTINGS_PATH, "page");
  });

  it("denies an actor lacking admin_api_key.delete, revoking nothing", async () => {
    checkPermMock.mockResolvedValue(false);
    seedAdminApiKeysMswState({
      adminApiKeys: [
        {
          id: "key-1",
          tenant_id: TENANT_ID,
          name: "target",
          admin_api_key_id: "admin_key_1",
          permissions: [],
        },
      ],
    });

    const res = await revokeAdminApiKeyAction({ id: "key-1" });

    expect(res).toEqual({
      ok: false,
      error: { code: "forbidden", message: "Permission denied: admin_api_key.delete" },
    });
    expect(revalidateMock).not.toHaveBeenCalled();
  });
});
