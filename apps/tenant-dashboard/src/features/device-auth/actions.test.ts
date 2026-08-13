/**
 * approveDeviceAuthAction / denyDeviceAuthAction — the wrapper-level
 * api_key.insert gate plus the handler-level trace.write clamp that keeps
 * the device mint from out-privileging its approver (mirrors
 * createApiKeyAction's reject-surplus clamp).
 */

import { createMswRestClient } from "@/test-helpers/rest-client";
import {
  seedDeviceAuthMswState,
  seedMembershipMswState,
  seedApiKeysMswState,
  seedPermissionsMswState,
  getDeviceAuthMswRows,
  getInsertedAuditLogRows,
} from "@/test-helpers/msw-handlers";

const { loadCtxMock, checkPermMock } = vi.hoisted(() => ({
  loadCtxMock: vi.fn(),
  checkPermMock: vi.fn(),
}));
vi.mock("@/lib/adapters", () => ({
  loadRequestServiceContext: loadCtxMock,
  checkRequestPermission: checkPermMock,
}));

import { approveDeviceAuthAction, denyDeviceAuthAction } from "./actions";

const TENANT_ID = "tenant-1";
const APP_ID = "app-1";

function seedPending(overrides: Partial<Record<string, unknown>> = {}) {
  seedDeviceAuthMswState([
    {
      id: "11111111-1111-4111-8111-111111111111",
      user_code: "AAAA-BBBB",
      device_code_digest: "d1",
      status: "pending",
      expires_at: new Date(Date.now() + 600_000).toISOString(),
      ...overrides,
    },
  ]);
}

beforeEach(() => {
  loadCtxMock.mockResolvedValue({
    db: createMswRestClient(),
    tenantId: TENANT_ID,
    actor: { userId: "user-1", role: "owner" },
  });
  checkPermMock.mockResolvedValue(true);
  seedMembershipMswState({ memberships: [{ id: "m-1", user_id: "user-1", tenant_id: TENANT_ID, role: "owner", status: "active" }] });
  seedApiKeysMswState({});
});

describe("approveDeviceAuthAction", () => {
  it("approves when the caller holds api_key.insert (wrapper) and trace.write (handler clamp)", async () => {
    seedPending();
    seedPermissionsMswState({ allowedAppPermissions: { [APP_ID]: ["trace.write"] } });

    const res = await approveDeviceAuthAction({ requestId: "11111111-1111-4111-8111-111111111111", appId: APP_ID });

    expect(res).toEqual({ ok: true, data: { ok: true } });
    expect(getDeviceAuthMswRows()[0]!.status).toBe("approved");
  });

  it("denies the wrapper-level api_key.insert check before ever reaching the handler", async () => {
    checkPermMock.mockResolvedValue(false);
    seedPending();

    const res = await approveDeviceAuthAction({ requestId: "11111111-1111-4111-8111-111111111111", appId: APP_ID });

    expect(res).toEqual({ ok: false, error: { code: "forbidden", message: "Permission denied: api_key.insert" } });
    expect(getDeviceAuthMswRows()[0]!.status).toBe("pending");
  });

  it("refuses to approve when the caller holds api_key.insert but NOT trace.write — the device mint must not out-privilege its approver", async () => {
    seedPending();
    seedPermissionsMswState({ allowedAppPermissions: { [APP_ID]: [] } });

    const res = await approveDeviceAuthAction({ requestId: "11111111-1111-4111-8111-111111111111", appId: APP_ID });

    expect(res.ok).toBe(true);
    expect(res).toMatchObject({ data: { ok: false, errorCode: "permissions_exceed_caller" } });
    // Refused before any write — the row never left 'pending'.
    expect(getDeviceAuthMswRows()[0]!.status).toBe("pending");
  });

  it("reports already_resolved for a code that is no longer pending, without throwing", async () => {
    seedPending({ status: "denied" });
    seedPermissionsMswState({ allowedAppPermissions: { [APP_ID]: ["trace.write"] } });

    const res = await approveDeviceAuthAction({ requestId: "11111111-1111-4111-8111-111111111111", appId: APP_ID });

    expect(res).toMatchObject({ ok: true, data: { ok: false, errorCode: "already_resolved" } });
  });

  it("writes a device_login_approved audit row naming the approver, on success", async () => {
    seedPending();
    seedPermissionsMswState({ allowedAppPermissions: { [APP_ID]: ["trace.write"] } });

    await approveDeviceAuthAction({ requestId: "11111111-1111-4111-8111-111111111111", appId: APP_ID });

    const rows = getInsertedAuditLogRows();
    expect(rows).toEqual(
      expect.arrayContaining([expect.objectContaining({ action_type: "device_login_approved", actor_id: "user-1", tenant_id: TENANT_ID })]),
    );
  });

  it("rejects a non-UUID requestId before touching the context (validation error)", async () => {
    const res = await approveDeviceAuthAction({ requestId: "not-a-uuid", appId: APP_ID });
    expect(res).toMatchObject({ ok: false, error: { code: "validation_error" } });
    expect(loadCtxMock).not.toHaveBeenCalled();
  });
});

describe("denyDeviceAuthAction", () => {
  it("denies a pending request", async () => {
    seedPending();
    const res = await denyDeviceAuthAction({ requestId: "11111111-1111-4111-8111-111111111111" });
    expect(res).toEqual({ ok: true, data: { ok: true } });
    expect(getDeviceAuthMswRows()[0]!.status).toBe("denied");
  });

  it("reports already_resolved for a request that already left pending", async () => {
    seedPending({ status: "approved" });
    const res = await denyDeviceAuthAction({ requestId: "11111111-1111-4111-8111-111111111111" });
    expect(res).toMatchObject({ ok: true, data: { ok: false, errorCode: "already_resolved" } });
  });
});
