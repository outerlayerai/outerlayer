/**
 * POST /api/internal/pr-comment-refresh — batch refresh, called by the
 * Cloudflare Worker queue consumer (PR 11) and the cron gap-repair sweep
 * (PR 12). `refreshPrSessionComment` is a true seam here (mocked) — this
 * route's own job is auth, batch validation, and per-item status shaping,
 * not the orchestration itself (covered by `refresh.test.ts`).
 */

import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

vi.mock("next/server", () => ({
  NextResponse: {
    json: (body: unknown, init?: { status?: number }) => ({
      status: init?.status ?? 200,
      json: async () => body,
    }),
  },
}));

const { mockRefresh } = vi.hoisted(() => ({ mockRefresh: vi.fn() }));
vi.mock("@/lib/system/pr-session-comment", () => ({ refreshPrSessionComment: mockRefresh }));

import { POST } from "../route";

const SECRET = "test-refresh-secret";

function createRequest(body: unknown, headers: Record<string, string> = {}) {
  const requestHeaders = new Headers(headers);
  if (!requestHeaders.has("content-type")) {
    requestHeaders.set("content-type", "application/json");
  }
  return new Request("http://localhost/api/internal/pr-comment-refresh", {
    method: "POST",
    headers: requestHeaders,
    body: typeof body === "string" ? body : JSON.stringify(body),
  }) as unknown as Parameters<typeof POST>[0];
}

function createAuthedRequest(body: unknown, secret = SECRET) {
  return createRequest(body, { authorization: `Bearer ${secret}` });
}

const ITEM_A = { tenantId: "tenant-1", repository: "github.com/acme/api", prNumber: 812 };
const ITEM_B = { tenantId: "tenant-1", repository: "github.com/acme/api", prNumber: 900 };

beforeEach(() => {
  vi.clearAllMocks();
  process.env.PR_COMMENT_REFRESH_SECRET = SECRET;
});
afterEach(() => {
  delete process.env.PR_COMMENT_REFRESH_SECRET;
});

describe("POST /api/internal/pr-comment-refresh", () => {
  it("401s when the Authorization header is missing, without parsing the body or calling refreshPrSessionComment", async () => {
    const request = createRequest({ items: [ITEM_A] });
    const jsonSpy = vi.spyOn(request, "json");

    const response = await POST(request);
    const body = await response.json();

    expect(response.status).toBe(401);
    expect(body.error).toBe("Unauthorized");
    expect(jsonSpy).not.toHaveBeenCalled();
    expect(mockRefresh).not.toHaveBeenCalled();
  });

  it("401s when the bearer token is wrong", async () => {
    const response = await POST(createAuthedRequest({ items: [ITEM_A] }, "wrong-secret"));
    expect(response.status).toBe(401);
    expect(mockRefresh).not.toHaveBeenCalled();
  });

  it("401s (fail closed) when PR_COMMENT_REFRESH_SECRET is unset", async () => {
    delete process.env.PR_COMMENT_REFRESH_SECRET;
    const response = await POST(createAuthedRequest({ items: [ITEM_A] }));
    expect(response.status).toBe(401);
    expect(mockRefresh).not.toHaveBeenCalled();
  });

  it("400s a malformed body (missing items array) without throwing", async () => {
    const response = await POST(createAuthedRequest({ notItems: true }));
    const body = await response.json();
    expect(response.status).toBe(400);
    expect(body.error).toBe("Invalid refresh batch");
    expect(mockRefresh).not.toHaveBeenCalled();
  });

  it("400s an item missing required fields", async () => {
    const response = await POST(
      createAuthedRequest({ items: [{ tenantId: "tenant-1", repository: "github.com/acme/api" }] }),
    );
    expect(response.status).toBe(400);
    expect(mockRefresh).not.toHaveBeenCalled();
  });

  it("400s a non-JSON body instead of 500ing", async () => {
    const response = await POST(createAuthedRequest("not json"));
    expect(response.status).toBe(400);
  });

  it("calls refreshPrSessionComment once per item and returns per-item results", async () => {
    mockRefresh.mockImplementation(async (params: typeof ITEM_A) => {
      if (params.prNumber === ITEM_A.prNumber) return { status: "created", commentId: 55 };
      return { status: "unchanged", commentId: 12 };
    });

    const response = await POST(createAuthedRequest({ items: [ITEM_A, ITEM_B] }));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(mockRefresh).toHaveBeenCalledTimes(2);
    expect(mockRefresh).toHaveBeenCalledWith(ITEM_A);
    expect(mockRefresh).toHaveBeenCalledWith(ITEM_B);
    expect(body.results).toEqual([
      { ...ITEM_A, status: "created", commentId: 55 },
      { ...ITEM_B, status: "unchanged", commentId: 12 },
    ]);
  });

  it("does not fail the whole batch when one item throws — the rest still report their own status", async () => {
    mockRefresh.mockImplementation(async (params: typeof ITEM_A) => {
      if (params.prNumber === ITEM_A.prNumber) {
        throw new Error("unexpected boom");
      }
      return { status: "updated", commentId: 77 };
    });

    const response = await POST(createAuthedRequest({ items: [ITEM_A, ITEM_B] }));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.results).toEqual([
      { ...ITEM_A, status: "failed", reason: "unexpected boom" },
      { ...ITEM_B, status: "updated", commentId: 77 },
    ]);
  });
});
