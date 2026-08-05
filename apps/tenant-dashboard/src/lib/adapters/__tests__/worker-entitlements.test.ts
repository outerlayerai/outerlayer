/**
 * The workers entitlement gate. Each gate resolves the feature flag first, then
 * its numeric limits in order, and stops at the first denial — carrying the
 * denied-info for exactly the entitlement that failed. The billing
 * `EntitlementService` and `buildDeniedInfo` are collaborator seams (their own
 * suites cover the tier/override rules); these tests pin the gate's branching
 * and the arguments it forwards, so a swapped key, a dropped usage count, or a
 * gate that fails open would fail here.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const { canAccess, checkLimit, buildDeniedInfo } = vi.hoisted(() => ({
  canAccess: vi.fn(),
  checkLimit: vi.fn(),
  buildDeniedInfo: vi.fn(),
}));

vi.mock("@/lib/system/entitlement-service", () => ({
  EntitlementService: class {
    canAccess = canAccess;
    checkLimit = checkLimit;
  },
  buildDeniedInfo,
}));

import {
  checkWorkerLaunchEntitlements,
  checkWorkerEnvironmentEntitlements,
} from "../worker-entitlements";

const TENANT = "tenant-1";
const ALLOW = { allowed: true, limit: 5, currentCount: 1 };
const DENY = { allowed: false, limit: 2, currentCount: 2, requiredTier: "team", upgradeUrl: "/contact" };

beforeEach(() => {
  canAccess.mockReset();
  checkLimit.mockReset();
  buildDeniedInfo.mockReset();
  buildDeniedInfo.mockImplementation((key: string) => ({ featureKey: key, denied: true }));
});

describe("checkWorkerLaunchEntitlements", () => {
  it("denies on the feature flag before reading any limit", async () => {
    canAccess.mockResolvedValue(false);

    const res = await checkWorkerLaunchEntitlements(TENANT, { activeRuns: 0, usedMinutes: 0 });

    expect(res).toEqual({ allowed: false, denied: { featureKey: "workers_enabled", denied: true } });
    expect(canAccess).toHaveBeenCalledWith(TENANT, "workers_enabled");
    expect(buildDeniedInfo).toHaveBeenCalledWith("workers_enabled");
    expect(checkLimit).not.toHaveBeenCalled();
  });

  it("denies on the concurrency cap and carries its check result, without reading minutes", async () => {
    canAccess.mockResolvedValue(true);
    checkLimit.mockResolvedValueOnce(DENY);

    const res = await checkWorkerLaunchEntitlements(TENANT, { activeRuns: 3, usedMinutes: 10 });

    expect(res).toEqual({ allowed: false, denied: { featureKey: "max_concurrent_worker_runs", denied: true } });
    expect(checkLimit).toHaveBeenCalledTimes(1);
    expect(checkLimit).toHaveBeenCalledWith(TENANT, "max_concurrent_worker_runs", 3);
    expect(buildDeniedInfo).toHaveBeenCalledWith("max_concurrent_worker_runs", DENY);
  });

  it("denies on the monthly-minutes cap after concurrency passes", async () => {
    canAccess.mockResolvedValue(true);
    checkLimit.mockResolvedValueOnce(ALLOW).mockResolvedValueOnce(DENY);

    const res = await checkWorkerLaunchEntitlements(TENANT, { activeRuns: 1, usedMinutes: 500 });

    expect(res).toEqual({ allowed: false, denied: { featureKey: "max_worker_minutes_per_month", denied: true } });
    expect(checkLimit).toHaveBeenNthCalledWith(2, TENANT, "max_worker_minutes_per_month", 500);
    expect(buildDeniedInfo).toHaveBeenCalledWith("max_worker_minutes_per_month", DENY);
  });

  it("allows when the flag and both limits pass", async () => {
    canAccess.mockResolvedValue(true);
    checkLimit.mockResolvedValue(ALLOW);

    const res = await checkWorkerLaunchEntitlements(TENANT, { activeRuns: 2, usedMinutes: 30 });

    expect(res).toEqual({ allowed: true });
    expect(checkLimit).toHaveBeenNthCalledWith(1, TENANT, "max_concurrent_worker_runs", 2);
    expect(checkLimit).toHaveBeenNthCalledWith(2, TENANT, "max_worker_minutes_per_month", 30);
    expect(buildDeniedInfo).not.toHaveBeenCalled();
  });
});

describe("checkWorkerEnvironmentEntitlements", () => {
  it("denies on the feature flag before reading the cap", async () => {
    canAccess.mockResolvedValue(false);

    const res = await checkWorkerEnvironmentEntitlements(TENANT, { activeWorkspaces: 0 });

    expect(res).toEqual({
      allowed: false,
      denied: { featureKey: "persistent_worker_environments", denied: true },
    });
    expect(canAccess).toHaveBeenCalledWith(TENANT, "persistent_worker_environments");
    expect(checkLimit).not.toHaveBeenCalled();
  });

  it("denies on the environment cap and carries its check result", async () => {
    canAccess.mockResolvedValue(true);
    checkLimit.mockResolvedValueOnce(DENY);

    const res = await checkWorkerEnvironmentEntitlements(TENANT, { activeWorkspaces: 4 });

    expect(res).toEqual({
      allowed: false,
      denied: { featureKey: "max_persistent_worker_environments", denied: true },
    });
    expect(checkLimit).toHaveBeenCalledWith(TENANT, "max_persistent_worker_environments", 4);
    expect(buildDeniedInfo).toHaveBeenCalledWith("max_persistent_worker_environments", DENY);
  });

  it("allows when the flag and cap pass", async () => {
    canAccess.mockResolvedValue(true);
    checkLimit.mockResolvedValue(ALLOW);

    const res = await checkWorkerEnvironmentEntitlements(TENANT, { activeWorkspaces: 1 });

    expect(res).toEqual({ allowed: true });
    expect(buildDeniedInfo).not.toHaveBeenCalled();
  });
});
