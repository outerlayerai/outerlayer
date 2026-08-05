/**
 * GET /api/platform-admin/score-coverage
 *
 * The route is thin: platform-admin auth gate, then delegate to
 * `getScoreCoverage` (mocked seam — its logic is tested in
 * coverage.test.ts and service.test.ts). Pins the auth gate, the appId
 * passthrough, the clickhouse-unconfigured skip, and the error → 500 map.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("server-only", () => ({}));

vi.mock("next/server", () => ({
  NextResponse: {
    json: (body: unknown, init?: { status?: number }) => ({
      status: init?.status ?? 200,
      json: async () => body,
    }),
  },
}));

vi.mock("@/config-global.server", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  DORA_ENVIRONMENT: "staging",
}));

const mockGetScoreCoverage = vi.hoisted(() => vi.fn());
vi.mock("@/lib/system/score-coverage/service", () => ({
  getScoreCoverage: mockGetScoreCoverage,
}));

import { GET } from "../route";
import { seedPlatformAdminAccess, seedSupabaseAuth } from "@/test-helpers/msw-handlers";
import { mockUser } from "@/test-helpers/fixtures/auth.fixtures";

function makePlatformAdmin(email = "admin@outerlayer.ai") {
  return { ...mockUser, id: "user-123", email };
}

function createRequest(params: Record<string, string> = {}) {
  const url = new URL("http://localhost/api/platform-admin/score-coverage");
  Object.entries(params).forEach(([key, value]) => url.searchParams.set(key, value));
  return new Request(url.toString());
}

const COVERAGE_RESULT = {
  confirmedLinks: 10,
  covered: 8,
  missing: 2,
  missingSamples: [{ appId: "app-1", prNumber: 5, traceId: "trace-5" }],
  truncated: false,
};

describe("GET /api/platform-admin/score-coverage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns 401 when the user is not authenticated", async () => {
    const response = await GET(createRequest());
    expect(response.status).toBe(401);
    expect(mockGetScoreCoverage).not.toHaveBeenCalled();
  });

  it("returns 401 for a non-@outerlayer.ai email", async () => {
    seedSupabaseAuth({ user: makePlatformAdmin("user@example.com") as any });
    const response = await GET(createRequest());
    expect(response.status).toBe(401);
  });

  it("skips with a clear reason when ClickHouse isn't configured", async () => {
    seedPlatformAdminAccess(makePlatformAdmin() as any);
    mockGetScoreCoverage.mockResolvedValue({ skipped: true });

    const response = await GET(createRequest());
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({ skipped: true, reason: "clickhouse not configured" });
  });

  it("returns the coverage result with the deployment environment for an authenticated admin", async () => {
    seedPlatformAdminAccess(makePlatformAdmin() as any);
    mockGetScoreCoverage.mockResolvedValue({ skipped: false, ...COVERAGE_RESULT });

    const response = await GET(createRequest());
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({ environment: "staging", ...COVERAGE_RESULT });
  });

  it("passes the appId query param through to getScoreCoverage", async () => {
    seedPlatformAdminAccess(makePlatformAdmin() as any);
    mockGetScoreCoverage.mockResolvedValue({ skipped: false, ...COVERAGE_RESULT });

    await GET(createRequest({ appId: "app-42" }));

    expect(mockGetScoreCoverage).toHaveBeenCalledWith({ appId: "app-42" });
  });

  it("passes the prNumber query param through to getScoreCoverage as a number", async () => {
    seedPlatformAdminAccess(makePlatformAdmin() as any);
    mockGetScoreCoverage.mockResolvedValue({ skipped: false, ...COVERAGE_RESULT });

    await GET(createRequest({ prNumber: "3662" }));

    expect(mockGetScoreCoverage).toHaveBeenCalledWith({ appId: undefined, prNumber: 3662 });
  });

  it("rejects a non-numeric prNumber with 400, without calling getScoreCoverage", async () => {
    seedPlatformAdminAccess(makePlatformAdmin() as any);

    const response = await GET(createRequest({ prNumber: "not-a-number" }));

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "prNumber must be a positive number" });
    expect(mockGetScoreCoverage).not.toHaveBeenCalled();
  });

  it("rejects a zero/negative prNumber with 400", async () => {
    seedPlatformAdminAccess(makePlatformAdmin() as any);

    const response = await GET(createRequest({ prNumber: "0" }));

    expect(response.status).toBe(400);
    expect(mockGetScoreCoverage).not.toHaveBeenCalled();
  });

  it("maps a thrown error to a 500", async () => {
    seedPlatformAdminAccess(makePlatformAdmin() as any);
    mockGetScoreCoverage.mockRejectedValue(new Error("pull_request read failed"));

    const response = await GET(createRequest());
    const body = await response.json();

    expect(response.status).toBe(500);
    expect(body).toEqual({ error: "Failed to compute score coverage" });
  });
});
