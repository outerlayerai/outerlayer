/**
 * Wrapper-wiring tests for `MembershipService`. The business logic itself
 * (invite/role-change/removal rules, entitlement gating, atomic audit RPCs)
 * lives in `@repo/org-management-service` and is covered by its own suite —
 * this file only pins that the dashboard's app-specific dependencies
 * (billing-tier entitlements, audit log, EE app-role assignment,
 * observability, request-context capture) are wired into the package's
 * injected seams correctly.
 */
const {
  packageCtor,
  checkLimitFn,
  canAccessFn,
  buildDeniedInfoFn,
  auditCreateFn,
  bulkAssignFn,
  serverLoggerErrorFn,
  appMemberRoleServiceCtor,
} = vi.hoisted(() => ({
  packageCtor: vi.fn(),
  checkLimitFn: vi.fn(),
  canAccessFn: vi.fn(),
  buildDeniedInfoFn: vi.fn(),
  auditCreateFn: vi.fn(),
  bulkAssignFn: vi.fn(),
  serverLoggerErrorFn: vi.fn(),
  appMemberRoleServiceCtor: vi.fn(),
}));

vi.mock("@repo/org-management-service", () => ({
  MembershipService: vi.fn().mockImplementation(function (this: unknown, config: unknown) {
    packageCtor(config);
    return {};
  }),
}));

vi.mock("@/lib/system/entitlement-service", () => ({
  EntitlementService: vi.fn().mockImplementation(function () {
    return { checkLimit: checkLimitFn, canAccess: canAccessFn };
  }),
  buildDeniedInfo: buildDeniedInfoFn,
}));

vi.mock("@/lib/system/audit-log", () => ({
  AuditLogService: vi.fn().mockImplementation(function () {
    return { create: auditCreateFn };
  }),
  captureRequestContext: vi.fn().mockResolvedValue({ ipAddress: null, userAgent: null, requestId: null }),
}));

vi.mock("@/lib/observability/server-logger", () => ({
  serverLogger: { error: serverLoggerErrorFn },
}));

// This wrapper test can't import `@ee/features/app-access/app-member-role-service`
// itself — the feature-leaf boundary exempts only `membership-service.ts`, not
// its test — so the constructor call is observed through a hoisted spy inside
// the mock factory instead of a `vi.mocked(AppMemberRoleService)` import.
vi.mock("@ee/features/app-access/app-member-role-service", () => ({
  AppMemberRoleService: vi.fn().mockImplementation(function (config: unknown) {
    appMemberRoleServiceCtor(config);
    return { bulkAssign: bulkAssignFn };
  }),
}));

import { MembershipService, type MembershipServiceConfig } from "./membership-service";

describe("MembershipService wrapper", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  function buildWrapper() {
    return new MembershipService({
      supabaseAdmin: { from: vi.fn() } as unknown as MembershipServiceConfig["supabaseAdmin"],
      supabaseServer: { from: vi.fn() } as unknown as MembershipServiceConfig["supabaseServer"],
      emailService: { sendEmail: vi.fn() } as unknown as MembershipServiceConfig["emailService"],
      rateLimitService: { limit: vi.fn() } as unknown as MembershipServiceConfig["rateLimitService"],
      stripeService: {} as unknown as MembershipServiceConfig["stripeService"],
    });
  }

  it("constructs the inner package service with an entitlement gate backed by EntitlementService + buildDeniedInfo", async () => {
    buildWrapper();

    const config = packageCtor.mock.calls[0]![0] as {
      entitlements: {
        checkLimit: (t: string, k: string, c: number) => unknown;
        canAccess: (t: string, k: string) => unknown;
        buildDeniedInfo: (k: string, r?: unknown) => unknown;
      };
    };

    checkLimitFn.mockResolvedValue({ allowed: true, limit: 5, currentCount: 1 });
    await config.entitlements.checkLimit("tenant-1", "max_users", 1);
    expect(checkLimitFn).toHaveBeenCalledWith("tenant-1", "max_users", 1);

    canAccessFn.mockResolvedValue(true);
    await config.entitlements.canAccess("tenant-1", "app_level_roles");
    expect(canAccessFn).toHaveBeenCalledWith("tenant-1", "app_level_roles");

    buildDeniedInfoFn.mockReturnValue({ featureKey: "max_users" });
    config.entitlements.buildDeniedInfo("max_users", { allowed: false, limit: 5, currentCount: 5 });
    expect(buildDeniedInfoFn).toHaveBeenCalledWith("max_users", { allowed: false, limit: 5, currentCount: 5 });
  });

  it("wires the audit log to a service-role AuditLogService over the admin client", async () => {
    const supabaseAdmin = { from: vi.fn() } as unknown as MembershipServiceConfig["supabaseAdmin"];
    new MembershipService({
      supabaseAdmin,
      supabaseServer: { from: vi.fn() } as unknown as MembershipServiceConfig["supabaseServer"],
      emailService: { sendEmail: vi.fn() } as unknown as MembershipServiceConfig["emailService"],
      rateLimitService: { limit: vi.fn() } as unknown as MembershipServiceConfig["rateLimitService"],
      stripeService: {} as unknown as MembershipServiceConfig["stripeService"],
    });

    const config = packageCtor.mock.calls[0]![0] as { auditLog: { create: (e: unknown) => unknown } };
    await config.auditLog.create({ tenantId: "t", actorId: "a", actionType: "x", targetType: "y", targetId: "z" });
    expect(auditCreateFn).toHaveBeenCalledWith({ tenantId: "t", actorId: "a", actionType: "x", targetType: "y", targetId: "z" });
  });

  it("routes app-role assignment through a fresh EE AppMemberRoleService per call, actor-scoped", async () => {
    buildWrapper();

    const config = packageCtor.mock.calls[0]![0] as {
      appRoleAssigner: { bulkAssign: (t: string, a: string, i: unknown) => unknown };
    };

    bulkAssignFn.mockResolvedValue({ success: true, data: { errors: [] } });
    await config.appRoleAssigner.bulkAssign("tenant-1", "actor-1", {
      membershipId: "m-1",
      assignments: [{ appId: "app-1", role: "read" }],
    });

    expect(appMemberRoleServiceCtor).toHaveBeenCalledWith({ db: expect.anything(), actorId: "actor-1" });
    expect(bulkAssignFn).toHaveBeenCalledWith("tenant-1", { membershipId: "m-1", assignments: [{ appId: "app-1", role: "read" }] });
  });

  it("routes logger.error through serverLogger", async () => {
    buildWrapper();

    const config = packageCtor.mock.calls[0]![0] as { logger: { error: (e: Error, m?: unknown) => unknown } };
    const err = new Error("boom");
    await config.logger.error(err, { key: "value" });

    expect(serverLoggerErrorFn).toHaveBeenCalledWith(err, { key: "value" });
  });

  it("resolves appUrl to the production or local dashboard origin based on NODE_ENV", () => {
    buildWrapper();

    const config = packageCtor.mock.calls[0]![0] as { appUrl: string };
    expect(config.appUrl).toBe(process.env.NODE_ENV === "production" ? "https://app.agentmark.co" : "http://localhost:3002");
  });
});
