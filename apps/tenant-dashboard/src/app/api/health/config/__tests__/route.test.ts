/**
 * GET /api/health/config — config readiness for this deployment.
 *
 * The route is thin: authenticate the cron bearer, delegate to the pure
 * readiness check (its logic is pinned in env-readiness.test.ts), and map
 * completeness to a status code. We pin the auth gate — which must not leak
 * the answer to an unauthenticated caller — and that mapping.
 */

import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";

beforeAll(() => {
  if (typeof Response.json !== "function") {
    (Response as unknown as Record<string, unknown>).json = (data: unknown, init?: ResponseInit) =>
      new Response(JSON.stringify(data), {
        ...init,
        headers: {
          ...((init as Record<string, unknown>)?.["headers"] ?? {}),
          "content-type": "application/json",
        },
      });
  }
});

vi.mock("@/config-global.server", () => ({
  CRON_SECRET: "test-cron-secret",
}));

const mockCheck = vi.hoisted(() => vi.fn());
vi.mock("@/lib/system/env-readiness", () => ({
  checkEnvReadiness: mockCheck,
  readinessEnvFromProcess: () => ({}),
}));

import { GET } from "../route";

function request(authorization?: string): Request {
  return new Request("https://dash.test/api/health/config", {
    headers: authorization ? { authorization } : {},
  });
}

const READY = { environment: "staging", missingRequired: [], degraded: [] };

describe("GET /api/health/config", () => {
  beforeEach(() => {
    mockCheck.mockReset();
    mockCheck.mockReturnValue(READY);
  });

  it("rejects a request with no authorization header", async () => {
    const res = await GET(request());

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "Unauthorized" });
  });

  it("rejects a wrong bearer token", async () => {
    const res = await GET(request("Bearer not-the-secret"));

    expect(res.status).toBe(401);
  });

  // The whole point of the auth gate: an unauthenticated caller must not learn
  // which capabilities this deployment is missing.
  it("does not compute or disclose readiness to an unauthorized caller", async () => {
    const res = await GET(request("Bearer not-the-secret"));

    expect(await res.json()).toEqual({ error: "Unauthorized" });
    expect(mockCheck).not.toHaveBeenCalled();
  });

  it("returns 200 and the full readiness report when config is complete", async () => {
    const res = await GET(request("Bearer test-cron-secret"));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      status: "ready",
      environment: "staging",
      missingRequired: [],
      degraded: [],
    });
  });

  it("returns 503 and names the gaps when required config is missing", async () => {
    mockCheck.mockReturnValue({
      environment: "staging",
      missingRequired: ["CRON_SECRET", "API_KEY_PEPPER"],
      degraded: [{ capability: "email delivery", reason: "EMAIL_ENABLED is not truthy" }],
    });

    const res = await GET(request("Bearer test-cron-secret"));

    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({
      status: "incomplete",
      environment: "staging",
      missingRequired: ["CRON_SECRET", "API_KEY_PEPPER"],
      degraded: [{ capability: "email delivery", reason: "EMAIL_ENABLED is not truthy" }],
    });
  });

  // Degradation is config, not fault: a deployment that deliberately has email
  // off is still ready, and must not page anyone.
  it("stays 200 when capabilities are degraded but nothing required is missing", async () => {
    mockCheck.mockReturnValue({
      environment: "staging",
      missingRequired: [],
      degraded: [{ capability: "GitHub App", reason: "GITHUB_APP_PRIVATE_KEY is unset" }],
    });

    const res = await GET(request("Bearer test-cron-secret"));

    expect(res.status).toBe(200);
    expect((await res.json()).status).toBe("ready");
  });
});
