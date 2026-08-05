/**
 * handlePullRequestEvent — PR webhook → `pull_request` lifecycle tracking.
 *
 * Pins the routing: EVERY PR on a connected repo is tracked with payload-true
 * lifecycle timestamps — merge rate, cycle time, draft-aware pickup baseline.
 * No preview environments, no diffing, no comments: this handler only tracks
 * lifecycle, it doesn't manage deployments or PR comments. Supabase
 * runs through MSW (no client mocks).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { http, HttpResponse } from "msw";
import { server } from "@/test-helpers/msw-server";

const API = "http://localhost:54321/rest/v1";

const m = vi.hoisted(() => ({
  logError: vi.fn(),
  logInfo: vi.fn(),
}));

vi.mock("@/lib/observability/server-logger", () => ({
  serverLogger: { error: m.logError, info: m.logInfo },
}));

import { handlePullRequestEvent } from "../handle-pull-request-event";

function prPayload(
  action: string,
  opts: {
    headBranch?: string;
    merged?: boolean;
    draft?: boolean;
    createdAt?: string;
    updatedAt?: string;
    closedAt?: string;
    mergedAt?: string;
    headSha?: string | null;
    number?: number;
    body?: string;
    additions?: number;
    deletions?: number;
    changedFiles?: number;
  } = {}
) {
  return {
    action,
    pull_request: {
      number: opts.number ?? 5,
      html_url: "https://github.com/acme/repo/pull/5",
      merged: opts.merged ?? false,
      ...(opts.body !== undefined ? { body: opts.body } : {}),
      ...(opts.draft !== undefined ? { draft: opts.draft } : {}),
      ...(opts.createdAt ? { created_at: opts.createdAt } : {}),
      ...(opts.updatedAt ? { updated_at: opts.updatedAt } : {}),
      ...(opts.closedAt ? { closed_at: opts.closedAt } : {}),
      ...(opts.mergedAt ? { merged_at: opts.mergedAt } : {}),
      ...(opts.additions !== undefined ? { additions: opts.additions } : {}),
      ...(opts.deletions !== undefined ? { deletions: opts.deletions } : {}),
      ...(opts.changedFiles !== undefined ? { changed_files: opts.changedFiles } : {}),
      head: {
        ref: opts.headBranch ?? "feature",
        ...(opts.headSha === null ? {} : { sha: opts.headSha ?? "head-sha" }),
      },
      base: { ref: "main", sha: "base-sha" },
    },
    repository: { full_name: "acme/repo" },
    installation: { id: 99 },
  };
}

/** One app connected to the repo. */
function seedAppResolution() {
  server.use(
    http.get(`${API}/git_connection`, () =>
      HttpResponse.json([{ app_id: "app-1", tenant_id: "t-1" }])
    )
  );
}

describe("handlePullRequestEvent", () => {
  beforeEach(() => {
    m.logError.mockReset();
    m.logInfo.mockReset();
  });

  it("tracks an opened PR with payload-true lifecycle timestamps", async () => {
    seedAppResolution();
    const writes: { upsert?: Record<string, unknown> } = {};
    server.use(
      http.post(`${API}/pull_request`, async ({ request }) => {
        writes.upsert = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json({});
      })
    );

    await handlePullRequestEvent(
      prPayload("opened", { headBranch: "greeting-preview" })
    );

    expect(writes.upsert).toMatchObject({
      app_id: "app-1",
      tenant_id: "t-1",
      provider: "github",
      pr_number: 5,
      head_branch: "greeting-preview",
      head_sha: "head-sha",
      base_branch: "main",
      state: "open",
      url: "https://github.com/acme/repo/pull/5",
      closed_at: null,
      merged_at: null,
    });
    expect((writes.upsert as { opened_at?: string }).opened_at).toMatch(
      /^\d{4}-\d{2}-\d{2}T/
    );
  });

  it("persists the payload's diff size (batch-size guardrail data)", async () => {
    seedAppResolution();
    const writes: { upsert?: Record<string, unknown> } = {};
    server.use(
      http.post(`${API}/pull_request`, async ({ request }) => {
        writes.upsert = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json({});
      })
    );

    await handlePullRequestEvent(
      prPayload("opened", { additions: 120, deletions: 30, changedFiles: 7 })
    );

    expect(writes.upsert).toMatchObject({
      additions: 120,
      deletions: 30,
      changed_files: 7,
    });
  });

  it("omits diff-size keys when the payload lacks them — an earlier stored size must survive the conflict", async () => {
    seedAppResolution();
    const writes: { upsert?: Record<string, unknown> } = {};
    server.use(
      http.post(`${API}/pull_request`, async ({ request }) => {
        writes.upsert = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json({});
      })
    );

    await handlePullRequestEvent(prPayload("opened"));

    // Absent keys, not nulls: an upsert null would CLOBBER captured sizes.
    expect("additions" in writes.upsert!).toBe(false);
    expect("deletions" in writes.upsert!).toBe(false);
    expect("changed_files" in writes.upsert!).toBe(false);
  });

  it("stamps ready_for_review_at at open for a NON-draft PR; omits it for a draft", async () => {
    seedAppResolution();
    const bodies: Record<string, unknown>[] = [];
    server.use(
      http.post(`${API}/pull_request`, async ({ request }) => {
        bodies.push((await request.json()) as Record<string, unknown>);
        return HttpResponse.json({});
      })
    );

    await handlePullRequestEvent(
      prPayload("opened", { draft: false, createdAt: "2026-07-01T09:00:00Z" })
    );
    expect(bodies[0]!.ready_for_review_at).toBe("2026-07-01T09:00:00Z");

    await handlePullRequestEvent(
      prPayload("opened", { draft: true, createdAt: "2026-07-01T09:00:00Z" })
    );
    expect("ready_for_review_at" in bodies[1]!).toBe(false);

    // A payload missing the flag entirely stamps nothing either.
    await handlePullRequestEvent(
      prPayload("opened", { createdAt: "2026-07-01T09:00:00Z" })
    );
    expect("ready_for_review_at" in bodies[2]!).toBe(false);

    // Unrelated actions never carry the column (an exact stamp survives).
    await handlePullRequestEvent(prPayload("synchronize", { draft: false }));
    expect("ready_for_review_at" in bodies[3]!).toBe(false);
  });

  it("ready_for_review action stamps the transition, monotone against an existing value", async () => {
    seedAppResolution();
    let existingReady: string | null = null;
    const bodies: Record<string, unknown>[] = [];
    server.use(
      http.get(`${API}/pull_request`, () =>
        HttpResponse.json([{ ready_for_review_at: existingReady }])
      ),
      http.post(`${API}/pull_request`, async ({ request }) => {
        bodies.push((await request.json()) as Record<string, unknown>);
        return HttpResponse.json({});
      })
    );

    // No existing stamp — the transition time (payload updated_at) lands.
    await handlePullRequestEvent(
      prPayload("ready_for_review", {
        draft: false,
        createdAt: "2026-07-01T09:00:00Z",
        updatedAt: "2026-07-02T10:00:00Z",
      })
    );
    expect(bodies[0]!.ready_for_review_at).toBe("2026-07-02T10:00:00Z");

    // Draft→ready→draft→ready cycle: the FIRST ready transition wins.
    existingReady = "2026-07-02T10:00:00Z";
    await handlePullRequestEvent(
      prPayload("ready_for_review", {
        draft: false,
        createdAt: "2026-07-01T09:00:00Z",
        updatedAt: "2026-07-05T16:00:00Z",
      })
    );
    expect(bodies[1]!.ready_for_review_at).toBe("2026-07-02T10:00:00Z");
  });

  it("stamps lifecycle timestamps from the payload when a PR is merged", async () => {
    seedAppResolution();
    let upserted: { state?: string; opened_at?: string; closed_at?: string; merged_at?: string } = {};
    server.use(
      http.post(`${API}/pull_request`, async ({ request }) => {
        upserted = (await request.json()) as typeof upserted;
        return HttpResponse.json({});
      })
    );

    await handlePullRequestEvent(
      prPayload("closed", {
        merged: true,
        createdAt: "2026-07-10T09:00:00Z",
        closedAt: "2026-07-13T12:00:00Z",
        mergedAt: "2026-07-13T12:00:00Z",
      })
    );

    expect(upserted.state).toBe("merged");
    expect(upserted.opened_at).toBe("2026-07-10T09:00:00Z");
    expect(upserted.closed_at).toBe("2026-07-13T12:00:00Z");
    expect(upserted.merged_at).toBe("2026-07-13T12:00:00Z");
  });

  it("marks an unmerged closed PR as 'closed' with a NULL merged_at", async () => {
    seedAppResolution();
    let upserted: { state?: string; closed_at?: string; merged_at?: string | null } = {};
    server.use(
      http.post(`${API}/pull_request`, async ({ request }) => {
        upserted = (await request.json()) as typeof upserted;
        return HttpResponse.json({});
      })
    );

    await handlePullRequestEvent(
      prPayload("closed", { merged: false, closedAt: "2026-07-13T12:00:00Z" })
    );

    expect(upserted.state).toBe("closed");
    expect(upserted.closed_at).toBe("2026-07-13T12:00:00Z");
    expect(upserted.merged_at).toBeNull();
  });

  it("clears closed_at/merged_at when a PR is reopened", async () => {
    seedAppResolution();
    let upserted: { state?: string; opened_at?: string; closed_at?: string | null; merged_at?: string | null } = {};
    server.use(
      http.post(`${API}/pull_request`, async ({ request }) => {
        upserted = (await request.json()) as typeof upserted;
        return HttpResponse.json({});
      })
    );

    await handlePullRequestEvent(
      prPayload("reopened", { createdAt: "2026-07-10T09:00:00Z" })
    );

    expect(upserted.state).toBe("open");
    expect(upserted.opened_at).toBe("2026-07-10T09:00:00Z");
    expect(upserted.closed_at).toBeNull();
    expect(upserted.merged_at).toBeNull();
  });

  it("preserves a decided PR's fate on post-decision events (labeled/edited): payload truth, not action name", async () => {
    seedAppResolution();
    const bodies: { state?: string; closed_at?: string | null; merged_at?: string | null }[] = [];
    server.use(
      http.post(`${API}/pull_request`, async ({ request }) => {
        bodies.push((await request.json()) as (typeof bodies)[number]);
        return HttpResponse.json({});
      })
    );

    // A label added to a MERGED PR: the payload still carries the fate.
    await handlePullRequestEvent(
      prPayload("labeled", { merged: true, closedAt: "2026-07-13T12:00:00Z", mergedAt: "2026-07-13T12:00:00Z" })
    );
    expect(bodies[0]).toMatchObject({
      state: "merged",
      closed_at: "2026-07-13T12:00:00Z",
      merged_at: "2026-07-13T12:00:00Z",
    });

    // An edit to a CLOSED-unmerged PR keeps closed, never resurrects open.
    await handlePullRequestEvent(
      prPayload("edited", { merged: false, closedAt: "2026-07-14T08:00:00Z" })
    );
    expect(bodies[1]).toMatchObject({
      state: "closed",
      closed_at: "2026-07-14T08:00:00Z",
      merged_at: null,
    });
  });

  it("reopened action increments reopen_count from the existing value; other actions omit it", async () => {
    seedAppResolution();
    let existingCount = 0;
    const bodies: Record<string, unknown>[] = [];
    server.use(
      http.get(`${API}/pull_request`, () =>
        HttpResponse.json([{ reopen_count: existingCount }])
      ),
      http.post(`${API}/pull_request`, async ({ request }) => {
        bodies.push((await request.json()) as Record<string, unknown>);
        return HttpResponse.json({});
      })
    );

    // First reopen: no prior → 0 + 1.
    await handlePullRequestEvent(prPayload("reopened", { draft: false }));
    expect(bodies[0]!.reopen_count).toBe(1);

    // Second reopen: increments the existing count, never resets it.
    existingCount = 1;
    await handlePullRequestEvent(prPayload("reopened", { draft: false }));
    expect(bodies[1]!.reopen_count).toBe(2);

    // Unrelated action never carries the column (the count is preserved on conflict).
    await handlePullRequestEvent(prPayload("synchronize", { draft: false }));
    expect("reopen_count" in bodies[2]!).toBe(false);
  });

  it("flags the TARGET row reverted_at when a merged PR body reverts it (a different row than the upsert)", async () => {
    seedAppResolution();
    const upserts: Record<string, unknown>[] = [];
    const patches: { url: string; body: Record<string, unknown> }[] = [];
    server.use(
      http.post(`${API}/pull_request`, async ({ request }) => {
        upserts.push((await request.json()) as Record<string, unknown>);
        return HttpResponse.json({});
      }),
      http.patch(`${API}/pull_request`, async ({ request }) => {
        patches.push({ url: request.url, body: (await request.json()) as Record<string, unknown> });
        return HttpResponse.json({});
      })
    );

    await handlePullRequestEvent(
      prPayload("closed", {
        merged: true,
        number: 20,
        body: "Reverts acme/repo#3",
        mergedAt: "2026-07-14T00:00:00Z",
      })
    );

    // The revert PR (#20) is upserted as its own merged row...
    expect(upserts).toHaveLength(1);
    expect(upserts[0]!.pr_number).toBe(20);
    // ...and the TARGET (#3) is flagged reverted via a separate update, stamped
    // with the revert PR's merge time, filtered to the target's pr_number.
    expect(patches).toHaveLength(1);
    expect(patches[0]!.body).toEqual({ reverted_at: "2026-07-14T00:00:00Z" });
    expect(patches[0]!.url).toContain("pr_number=eq.3");
  });

  it("does NOT flag a revert for a merged PR whose body has no revert reference", async () => {
    seedAppResolution();
    let patched = false;
    server.use(
      http.post(`${API}/pull_request`, async () => HttpResponse.json({})),
      http.patch(`${API}/pull_request`, async () => {
        patched = true;
        return HttpResponse.json({});
      })
    );
    await handlePullRequestEvent(
      prPayload("closed", { merged: true, number: 21, body: "fix: normal change, closes #9" })
    );
    expect(patched).toBe(false);
  });

  it("does NOT flag a revert when the revert PR is closed WITHOUT merging (an unmerged revert undid nothing)", async () => {
    seedAppResolution();
    let patched = false;
    server.use(
      http.post(`${API}/pull_request`, async () => HttpResponse.json({})),
      http.patch(`${API}/pull_request`, async () => {
        patched = true;
        return HttpResponse.json({});
      })
    );
    await handlePullRequestEvent(
      prPayload("closed", { merged: false, number: 22, body: "Reverts acme/repo#3" })
    );
    expect(patched).toBe(false);
  });

  it("stamps opened_at from the payload when a PR is first seen via synchronize", async () => {
    seedAppResolution();
    let upserted: { opened_at?: string } = {};
    server.use(
      http.post(`${API}/pull_request`, async ({ request }) => {
        upserted = (await request.json()) as typeof upserted;
        return HttpResponse.json({});
      })
    );

    await handlePullRequestEvent(
      prPayload("synchronize", { createdAt: "2026-07-10T09:00:00Z" })
    );

    expect(upserted.opened_at).toBe("2026-07-10T09:00:00Z");
  });

  it("ignores a payload with no pull_request", async () => {
    let touched = false;
    server.use(
      http.get(`${API}/git_connection`, () => {
        touched = true;
        return HttpResponse.json([]);
      })
    );
    await handlePullRequestEvent({ action: "opened" } as never);
    expect(touched).toBe(false);
  });

  it("returns early when repository is missing even if pull_request is present", async () => {
    let gitConnectionFetched = false;
    server.use(
      http.get(`${API}/git_connection`, () => {
        gitConnectionFetched = true;
        return HttpResponse.json([]);
      })
    );
    await handlePullRequestEvent({
      action: "opened",
      pull_request: {
        number: 5,
        html_url: "https://github.com/acme/repo/pull/5",
        head: { ref: "feature", sha: "abc" },
        base: { ref: "main", sha: "def" },
      },
      repository: undefined,
    });
    expect(gitConnectionFetched).toBe(false);
  });

  it("handles missing head/base safely (no throw)", async () => {
    seedAppResolution();
    server.use(
      http.post(`${API}/pull_request`, () => HttpResponse.json({}))
    );
    await expect(
      handlePullRequestEvent({
        action: "opened",
        pull_request: { number: 5, html_url: "https://github.com/acme/repo/pull/5" },
        repository: { full_name: "acme/repo" },
        installation: { id: 99 },
      })
    ).resolves.toBeUndefined();
  });

  it("stops early when no git connections are found (no upsert)", async () => {
    let upserted = false;
    server.use(
      http.get(`${API}/git_connection`, () => HttpResponse.json([])),
      http.post(`${API}/pull_request`, () => {
        upserted = true;
        return HttpResponse.json({});
      })
    );
    await handlePullRequestEvent(prPayload("opened"));
    expect(upserted).toBe(false);
  });

  it("handles null git_connection response without throwing", async () => {
    server.use(
      http.get(`${API}/git_connection`, () => HttpResponse.json(null))
    );
    await expect(handlePullRequestEvent(prPayload("opened"))).resolves.toBeUndefined();
  });

  it("logs when the pull_request upsert fails", async () => {
    seedAppResolution();
    server.use(
      http.post(`${API}/pull_request`, () =>
        HttpResponse.json({ message: "boom", code: "23505" }, { status: 400 })
      )
    );
    await handlePullRequestEvent(prPayload("opened"));
    expect(m.logError).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        context: "[GitHub Webhook] pull_request upsert failed",
        app_id: "app-1",
        pr_number: 5,
      })
    );
  });

  it("tracks the PR even when head sha is absent", async () => {
    seedAppResolution();
    let upserted: { head_sha?: string | null } = {};
    server.use(
      http.post(`${API}/pull_request`, async ({ request }) => {
        upserted = (await request.json()) as typeof upserted;
        return HttpResponse.json({});
      })
    );
    await handlePullRequestEvent({
      action: "opened",
      pull_request: {
        number: 5,
        html_url: "https://github.com/acme/repo/pull/5",
        head: { ref: "x-preview" }, // no sha
        base: { ref: "main", sha: "base-sha" },
      },
      repository: { full_name: "acme/repo" },
      installation: { id: 99 },
    });
    expect(upserted.head_sha).toBeNull();
  });

  it("tracks a PR for EVERY app connected to the repo, regardless of branch", async () => {
    const upsertedApps: string[] = [];
    server.use(
      http.get(`${API}/git_connection`, () =>
        HttpResponse.json([
          { app_id: "app-1", tenant_id: "t-1" },
          { app_id: "app-2", tenant_id: "t-1" },
        ])
      ),
      http.post(`${API}/pull_request`, async ({ request }) => {
        const body = (await request.json()) as { app_id: string };
        upsertedApps.push(body.app_id);
        return HttpResponse.json({});
      })
    );

    await handlePullRequestEvent(prPayload("opened", { headBranch: "x-preview" }));

    expect(upsertedApps).toEqual(["app-1", "app-2"]);
  });
});
