/**
 * GET /api/cron/pr-enrichment-backfill — the one-shot enrichment trigger.
 *
 * The route is thin: authenticate the cron bearer, parse + clamp the query
 * params, delegate to backfillPrEnrichment (mocked seam — its sweep logic
 * is tested in enrichment-backfill.test.ts), and map the result to a
 * status. We pin the auth gate, the param clamping, and the
 * failed-only → 500 mapping.
 */

import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";
import { NextRequest } from "next/server";

beforeAll(() => {
  if (typeof Response.json !== "function") {
    (Response as unknown as Record<string, unknown>).json = (data: unknown, init?: ResponseInit) =>
      new Response(JSON.stringify(data), {
        ...init,
        headers: { ...((init as Record<string, unknown>)?.["headers"] ?? {}), "content-type": "application/json" },
      });
  }
});

const mockBackfill = vi.hoisted(() => vi.fn());

vi.mock("@/config-global.server", () => ({
  CRON_SECRET: "test-cron-secret",
}));

vi.mock("@/lib/system/pr-tracking/enrichment-backfill", () => ({
  backfillPrEnrichment: mockBackfill,
}));

import { GET } from "../route";

function cronRequest(query = "", token = "test-cron-secret"): NextRequest {
  return new NextRequest(`http://localhost/api/cron/pr-enrichment-backfill${query}`, {
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockBackfill.mockResolvedValue({ connections: 1, examined: 2, diffFilled: 1, ciFilled: 1, errors: [] });
});

describe("GET /api/cron/pr-enrichment-backfill", () => {
  it("rejects a wrong bearer with 401 before any work", async () => {
    const res = await GET(cronRequest("", "wrong"));
    expect(res.status).toBe(401);
    expect(mockBackfill).not.toHaveBeenCalled();
  });

  it("passes tenant + clamped days/limit through to the sweep", async () => {
    const res = await GET(cronRequest("?tenant=tenant-1&days=9999&limit=0"));
    expect(res.status).toBe(200);
    expect(mockBackfill).toHaveBeenCalledWith({
      tenantId: "tenant-1",
      sinceDays: 365,
      perConnectionLimit: 1,
    });
  });

  it("omits unset params so the service defaults apply", async () => {
    await GET(cronRequest());
    expect(mockBackfill).toHaveBeenCalledWith({
      tenantId: undefined,
      sinceDays: undefined,
      perConnectionLimit: undefined,
    });
  });

  it("maps a nothing-done-and-only-errors sweep to 500 so the invocation reads red", async () => {
    mockBackfill.mockResolvedValue({ connections: 1, examined: 0, diffFilled: 0, ciFilled: 0, errors: ["boom"] });
    const res = await GET(cronRequest());
    expect(res.status).toBe(500);
  });
});
