/**
 * The comment refresh's durable backlog (`pr_session_comment.needs_refresh`):
 * pins the three operations the cron route composes — read the flagged rows
 * oldest-first and capped, flag targets a tick could not get to, and clear
 * the flag once a later tick actually refreshes them — and the best-effort
 * contract each read/write failure must honour (never throw; the flags stay
 * set for the next tick to retry).
 */
import { describe, it, expect, vi } from "vitest";

const mockLoggerError = vi.fn();
vi.mock("@/lib/observability/server-logger", () => ({
  serverLogger: {
    error: (...args: unknown[]) => mockLoggerError(...args),
  },
}));

import { server } from "@/test-helpers/msw-server";
import { http, HttpResponse } from "msw";
import {
  seedPrSessionCommentMswState,
  seedPrSessionCommentReadError,
  getPrSessionCommentRows,
  type PrSessionCommentMswRow,
} from "@/test-helpers/msw-handlers";
import { getAdminDataClient } from "@/lib/system/admin-client";

import {
  readCommentRefreshBacklog,
  markCommentRefreshNeeded,
  clearCommentRefreshBacklog,
} from "../backlog";

const SUPABASE_URL = "http://localhost:54321";

function row(over: Partial<PrSessionCommentMswRow> & Pick<PrSessionCommentMswRow, "id">) {
  return {
    tenant_id: "tenant-1",
    repository: "acme/api",
    pr_number: 1,
    github_comment_id: null,
    last_body_hash: "",
    last_posted_at: null,
    needs_refresh: false,
    updated_at: "2026-07-01T00:00:00.000Z",
    ...over,
  };
}

describe("readCommentRefreshBacklog", () => {
  it("reads only flagged rows, oldest updated_at first, mapped to BacklogTarget", async () => {
    seedPrSessionCommentMswState([
      row({
        id: "prc-flagged-newer",
        pr_number: 2,
        needs_refresh: true,
        updated_at: "2026-07-05T00:00:00.000Z",
      }),
      row({ id: "prc-not-flagged", pr_number: 3, needs_refresh: false }),
      row({
        id: "prc-flagged-older",
        pr_number: 1,
        needs_refresh: true,
        updated_at: "2026-07-01T00:00:00.000Z",
      }),
    ]);

    const backlog = await readCommentRefreshBacklog();

    expect(backlog).toEqual([
      { backlogId: "prc-flagged-older", tenantId: "tenant-1", repository: "acme/api", prNumber: 1 },
      { backlogId: "prc-flagged-newer", tenantId: "tenant-1", repository: "acme/api", prNumber: 2 },
    ]);
  });

  it("caps the read at 100 rows even when more are flagged", async () => {
    seedPrSessionCommentMswState(
      Array.from({ length: 120 }, (_, i) =>
        row({
          id: `prc-${i}`,
          pr_number: i,
          needs_refresh: true,
          updated_at: new Date(2026, 0, 1, 0, 0, i).toISOString(),
        }),
      ),
    );

    const backlog = await readCommentRefreshBacklog();

    expect(backlog).toHaveLength(100);
    // Still the oldest 100 — the cap does not disturb the ordering.
    expect(backlog[0]!.prNumber).toBe(0);
    expect(backlog[99]!.prNumber).toBe(99);
  });

  it("degrades to [] and logs, without throwing, when the read fails", async () => {
    seedPrSessionCommentReadError({ message: "connection refused" });

    const backlog = await readCommentRefreshBacklog();

    expect(backlog).toEqual([]);
    expect(mockLoggerError).toHaveBeenCalledWith(
      expect.objectContaining({ message: "connection refused" }),
      expect.objectContaining({ context: "[pr-session-comment] refresh backlog read failed" }),
    );
  });

  it("accepts an injected admin client instead of resolving its own", async () => {
    seedPrSessionCommentMswState([row({ id: "prc-1", needs_refresh: true })]);
    const admin = getAdminDataClient();

    const backlog = await readCommentRefreshBacklog(admin);

    expect(backlog.map((b) => b.backlogId)).toEqual(["prc-1"]);
  });
});

describe("markCommentRefreshNeeded", () => {
  it("upserts a needs_refresh=true marker per target, keyed on tenant/repository/pr_number", async () => {
    mockLoggerError.mockClear();
    await markCommentRefreshNeeded([
      { tenantId: "tenant-1", repository: "acme/api", prNumber: 10 },
      { tenantId: "tenant-1", repository: "acme/web", prNumber: 20 },
    ]);

    const rows = getPrSessionCommentRows();
    expect(rows.map((r) => ({ tenant_id: r.tenant_id, repository: r.repository, pr_number: r.pr_number, needs_refresh: r.needs_refresh }))).toEqual([
      { tenant_id: "tenant-1", repository: "acme/api", pr_number: 10, needs_refresh: true },
      { tenant_id: "tenant-1", repository: "acme/web", pr_number: 20, needs_refresh: true },
    ]);
    // A successful write must not also report a failure.
    expect(mockLoggerError).not.toHaveBeenCalled();
  });

  it("canonicalizes the repository before writing, so a differently-spelled duplicate updates the same row", async () => {
    seedPrSessionCommentMswState([
      row({ id: "prc-existing", repository: "acme/api", pr_number: 10, needs_refresh: false }),
    ]);

    await markCommentRefreshNeeded([
      { tenantId: "tenant-1", repository: "https://github.com/Acme/API.git", prNumber: 10 },
    ]);

    const rows = getPrSessionCommentRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: "prc-existing", repository: "acme/api", needs_refresh: true });
  });

  it("drops a target whose repository does not canonicalize to a GitHub.com owner/repo, writing nothing for it", async () => {
    await markCommentRefreshNeeded([
      { tenantId: "tenant-1", repository: "git@ghes.internal:acme/api.git", prNumber: 10 },
      { tenantId: "tenant-1", repository: "acme/api", prNumber: 11 },
    ]);

    const rows = getPrSessionCommentRows();
    expect(rows.map((r) => r.pr_number)).toEqual([11]);
  });

  it("writes nothing and does not call the backend when every target is filtered out", async () => {
    let posted = false;
    server.use(
      http.post(`${SUPABASE_URL}/rest/v1/pr_session_comment`, () => {
        posted = true;
        return HttpResponse.json([], { status: 201 });
      }),
    );

    await markCommentRefreshNeeded([{ tenantId: "tenant-1", repository: "not/a/repo", prNumber: 1 }]);

    expect(posted).toBe(false);
  });

  it("writes nothing for an empty target list", async () => {
    let posted = false;
    server.use(
      http.post(`${SUPABASE_URL}/rest/v1/pr_session_comment`, () => {
        posted = true;
        return HttpResponse.json([], { status: 201 });
      }),
    );

    await markCommentRefreshNeeded([]);

    expect(posted).toBe(false);
  });

  it("does not throw when the upsert fails; logs the deferred count instead", async () => {
    server.use(
      http.post(`${SUPABASE_URL}/rest/v1/pr_session_comment`, () =>
        HttpResponse.json({ message: "boom" }, { status: 500 }),
      ),
    );

    await expect(
      markCommentRefreshNeeded([{ tenantId: "tenant-1", repository: "acme/api", prNumber: 1 }]),
    ).resolves.toBeUndefined();
    expect(mockLoggerError).toHaveBeenCalledWith(
      expect.objectContaining({ message: "boom" }),
      expect.objectContaining({
        context: "[pr-session-comment] refresh backlog write failed",
        deferred: 1,
      }),
    );
  });
});

describe("clearCommentRefreshBacklog", () => {
  it("clears needs_refresh only on the given ids, leaving other flagged rows untouched", async () => {
    mockLoggerError.mockClear();
    seedPrSessionCommentMswState([
      row({ id: "prc-clear-me", pr_number: 1, needs_refresh: true }),
      row({ id: "prc-stay-flagged", pr_number: 2, needs_refresh: true }),
    ]);

    await clearCommentRefreshBacklog(["prc-clear-me"]);

    const rows = getPrSessionCommentRows();
    expect(rows.map((r) => ({ id: r.id, needs_refresh: r.needs_refresh }))).toEqual([
      { id: "prc-clear-me", needs_refresh: false },
      { id: "prc-stay-flagged", needs_refresh: true },
    ]);
    // A successful write must not also report a failure.
    expect(mockLoggerError).not.toHaveBeenCalled();
  });

  it("writes nothing and does not call the backend for an empty id list", async () => {
    let patched = false;
    server.use(
      http.patch(`${SUPABASE_URL}/rest/v1/pr_session_comment`, () => {
        patched = true;
        return HttpResponse.json([]);
      }),
    );

    await clearCommentRefreshBacklog([]);

    expect(patched).toBe(false);
  });

  it("does not throw when the clear fails; logs the cleared count", async () => {
    seedPrSessionCommentMswState([row({ id: "prc-1", needs_refresh: true })]);
    server.use(
      http.patch(`${SUPABASE_URL}/rest/v1/pr_session_comment`, () =>
        HttpResponse.json({ message: "boom" }, { status: 500 }),
      ),
    );

    await expect(clearCommentRefreshBacklog(["prc-1"])).resolves.toBeUndefined();
    expect(mockLoggerError).toHaveBeenCalledWith(
      expect.objectContaining({ message: "boom" }),
      expect.objectContaining({
        context: "[pr-session-comment] refresh backlog clear failed",
        cleared: 1,
      }),
    );
  });
});
