/**
 * DeviceAuthService — the approval-time membership resolution and the
 * atomic approve/deny transitions. Exercised against MSW for real.
 */

import { createMswRestClient } from "@/test-helpers/rest-client";
import { seedDeviceAuthMswState, seedMembershipMswState, seedApiKeysMswState, getDeviceAuthMswRows } from "@/test-helpers/msw-handlers";

import type { ServiceContext } from "@/lib/action-kit/service-context";

import { deviceAuthService } from "./service";

const TENANT_ID = "tenant-1";
const APP_ID = "app-1";

function ctx(overrides: Partial<ServiceContext> = {}): ServiceContext {
  return {
    db: createMswRestClient(),
    tenantId: TENANT_ID,
    actor: { userId: "user-1", role: "owner" },
    ...overrides,
  };
}

function seedPending(overrides: Partial<Record<string, unknown>> = {}) {
  seedDeviceAuthMswState([
    {
      id: "r1",
      user_code: "AAAA-BBBB",
      device_code_digest: "d1",
      status: "pending",
      expires_at: new Date(Date.now() + 600_000).toISOString(),
      ...overrides,
    },
  ]);
}

describe("resolveOwnMembershipId", () => {
  it("resolves the caller's own membership id in the request tenant", async () => {
    seedMembershipMswState({ memberships: [{ id: "m-1", user_id: "user-1", tenant_id: TENANT_ID, role: "owner", status: "active" }] });
    expect(await deviceAuthService.resolveOwnMembershipId(ctx())).toBe("m-1");
  });

  it("returns null when the caller has no membership row in this tenant", async () => {
    expect(await deviceAuthService.resolveOwnMembershipId(ctx())).toBeNull();
  });
});

describe("approve", () => {
  it("approves using the caller's own membership id and the app's default environment", async () => {
    seedPending();
    seedMembershipMswState({ memberships: [{ id: "m-1", user_id: "user-1", tenant_id: TENANT_ID, role: "owner", status: "active" }] });
    // apiKeysMswState's default environment fixture: env-default-1 for app-1.
    seedApiKeysMswState({});

    const approved = await deviceAuthService.approve(ctx(), { requestId: "r1", appId: APP_ID });

    expect(approved).toEqual(
      expect.objectContaining({
        status: "approved",
        tenant_id: TENANT_ID,
        app_id: APP_ID,
        environment_id: "env-default-1",
        approver_membership_id: "m-1",
      }),
    );
  });

  it("does not approve when the caller has no membership in this tenant, and never writes", async () => {
    seedPending();

    const approved = await deviceAuthService.approve(ctx(), { requestId: "r1", appId: APP_ID });

    expect(approved).toBeNull();
    expect(getDeviceAuthMswRows()[0]!.status).toBe("pending");
  });

  it("returns null for a request that is no longer pending", async () => {
    seedDeviceAuthMswState([
      { id: "r1", user_code: "AAAA-BBBB", device_code_digest: "d1", status: "denied", expires_at: new Date(Date.now() + 600_000).toISOString() },
    ]);
    seedMembershipMswState({ memberships: [{ id: "m-1", user_id: "user-1", tenant_id: TENANT_ID, role: "owner", status: "active" }] });

    expect(await deviceAuthService.approve(ctx(), { requestId: "r1", appId: APP_ID })).toBeNull();
  });
});

describe("deny", () => {
  it("denies a pending request", async () => {
    seedPending();
    const denied = await deviceAuthService.deny("r1");
    expect(denied?.status).toBe("denied");
  });

  it("returns null for a request that already resolved", async () => {
    seedDeviceAuthMswState([
      { id: "r1", user_code: "AAAA-BBBB", device_code_digest: "d1", status: "approved", expires_at: new Date(Date.now() + 600_000).toISOString() },
    ]);
    expect(await deviceAuthService.deny("r1")).toBeNull();
  });
});
