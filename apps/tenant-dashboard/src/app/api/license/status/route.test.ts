import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the resolver seam (an internal function with a stable signature — a true
// seam, not an HTTP boundary), so we can drive the route's two behaviors: pass
// the resolved status through, and fail closed to hidden on any throw.
const resolveLicenseStatus = vi.fn();
vi.mock("@ee/features/license/service", () => ({
  resolveLicenseStatus: () => resolveLicenseStatus(),
}));

// The route requires a session: the body carries the licensed ORG NAME and the
// expiry, so unauthenticated it let anyone scanning self-hosted instances
// attribute each one to a company and date its renewal. The signed-out case is
// expressed by NOT seeding a session — the MSW auth handlers default to none.
import { mockUser } from "@/test-helpers/fixtures/auth.fixtures";
import { seedSupabaseAuth } from "@/test-helpers/msw-handlers";

import { GET } from "./route";

describe("GET /api/license/status", () => {
  beforeEach(() => {
    resolveLicenseStatus.mockReset();
  });

  it("passes the resolved grace status through verbatim", async () => {
    seedSupabaseAuth({ user: mockUser });
    const status = {
      visible: true,
      state: "grace",
      org: "Acme Corp",
      plan: "enterprise",
      expiredAt: "2026-07-09T00:00:00.000Z",
      graceEndsAt: "2026-07-23T00:00:00.000Z",
      daysUntilGraceEnds: 11,
    };
    resolveLicenseStatus.mockResolvedValue(status);

    const res = await GET();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(status);
  });

  it("hides the licensed org and expiry from an unauthenticated caller", async () => {
    // No seedSupabaseAuth — there is no session.
    resolveLicenseStatus.mockResolvedValue({
      visible: true,
      state: "grace",
      org: "Acme Corp",
      plan: "enterprise",
    });

    const res = await GET();
    // Not a 401: a distinct status code would still confirm the instance is
    // licensed. The surface does not exist for this caller.
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ visible: false });
    // And the resolver is never even consulted.
    expect(resolveLicenseStatus).not.toHaveBeenCalled();
  });

  it("fails CLOSED to { visible: false } when resolution throws", async () => {
    seedSupabaseAuth({ user: mockUser });
    resolveLicenseStatus.mockRejectedValue(new Error("env read blew up"));

    const res = await GET();
    // Never a 500 and never a leaked/partial state — the license surface just
    // stays hidden rather than flashing a false unlicensed/grace banner.
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ visible: false });
  });
});
