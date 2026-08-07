/**
 * POST /api/internal/pr-comment-refresh — batch refresh, called by the
 * Cloudflare Worker queue consumer and the cron gap-repair sweep.
 * `refreshPrSessionComment` is a true seam here (mocked) — this route's own
 * job is auth, batch validation, and per-item status shaping, not the
 * orchestration itself (covered by `refresh.test.ts`).
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

  // GitHub's secondary rate limits are per-repository, and the queue consumer
  // coalesces per (tenant, repo, PR) only — so a busy monorepo delivers many
  // distinct PRs in ONE batch. Writing them concurrently is the exact shape
  // that gets throttled, and a fresh Octokit per refresh means the client's
  // own throttling plugin coordinates nothing across them.
  it("serializes refreshes that share a repository instead of bursting them", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    mockRefresh.mockImplementation(async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 0));
      inFlight -= 1;
      return { status: "updated", commentId: 1 };
    });

    const sameRepo = Array.from({ length: 8 }, (_, i) => ({
      tenantId: "tenant-1",
      repository: "github.com/acme/api",
      prNumber: 900 + i,
    }));

    const response = await POST(createAuthedRequest({ items: sameRepo }));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.results).toHaveLength(8);
    expect(maxInFlight).toBe(1);
  });

  // Different repositories share no rate-limit bucket, so serializing across
  // them would just make a batch needlessly slow.
  it("still refreshes distinct repositories in parallel", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    mockRefresh.mockImplementation(async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 0));
      inFlight -= 1;
      return { status: "updated", commentId: 1 };
    });

    const distinctRepos = Array.from({ length: 4 }, (_, i) => ({
      tenantId: "tenant-1",
      repository: `github.com/acme/svc-${i}`,
      prNumber: 1,
    }));

    await POST(createAuthedRequest({ items: distinctRepos }));

    expect(maxInFlight).toBeGreaterThan(1);
  });

  // Results are zipped back onto the caller's items by index, so a grouped
  // execution order must not reorder the response.
  it("returns results in request order even though execution is grouped by repo", async () => {
    mockRefresh.mockImplementation(async (params: typeof ITEM_A) => ({
      status: "updated" as const,
      commentId: params.prNumber,
    }));

    const items = [
      { tenantId: "t", repository: "github.com/acme/a", prNumber: 1 },
      { tenantId: "t", repository: "github.com/acme/b", prNumber: 2 },
      { tenantId: "t", repository: "github.com/acme/a", prNumber: 3 },
    ];

    const response = await POST(createAuthedRequest({ items }));
    const body = await response.json();

    expect(body.results.map((r: { commentId: number }) => r.commentId)).toEqual([1, 2, 3]);
  });
});
