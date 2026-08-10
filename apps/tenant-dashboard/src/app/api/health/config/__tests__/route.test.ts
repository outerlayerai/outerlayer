/**
 * GET /api/health/config — config posture for this deployment.
 *
 * The route is thin: authenticate the cron bearer and delegate to the pure
 * posture check (its logic is pinned in env-readiness.test.ts). We pin the auth
 * gate — which must not leak the answer to an unauthenticated caller — and that
 * degradation is reported without being treated as a fault.
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
  checkConfigPosture: mockCheck,
  postureEnvFromProcess: () => ({}),
}));

import { GET } from "../route";

function request(authorization?: string): Request {
  return new Request("https://dash.test/api/health/config", {
    headers: authorization ? { authorization } : {},
  });
}

const FULL = { environment: "staging", degraded: [] };

describe("GET /api/health/config", () => {
  beforeEach(() => {
    mockCheck.mockReset();
    mockCheck.mockReturnValue(FULL);
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
  it("does not compute or disclose posture to an unauthorized caller", async () => {
    const res = await GET(request("Bearer not-the-secret"));

    expect(await res.json()).toEqual({ error: "Unauthorized" });
    expect(mockCheck).not.toHaveBeenCalled();
  });

  it("reports full posture when nothing is switched off", async () => {
    const res = await GET(request("Bearer test-cron-secret"));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      status: "full",
      environment: "staging",
      degraded: [],
    });
  });

  // Degradation is configuration, not fault: a deployment deliberately running
  // with email off is working as configured and must not page anyone. It still
  // answers 200 — the body carries the signal.
  it("names each reduced capability, still with a 200", async () => {
    mockCheck.mockReturnValue({
      environment: "staging",
      degraded: [
        { capability: "email delivery", reason: "EMAIL_ENABLED is not truthy" },
        { capability: "GitHub App", reason: "GITHUB_APP_PRIVATE_KEY is unset" },
      ],
    });

    const res = await GET(request("Bearer test-cron-secret"));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      status: "degraded",
      environment: "staging",
      degraded: [
        { capability: "email delivery", reason: "EMAIL_ENABLED is not truthy" },
        { capability: "GitHub App", reason: "GITHUB_APP_PRIVATE_KEY is unset" },
      ],
    });
  });
});
