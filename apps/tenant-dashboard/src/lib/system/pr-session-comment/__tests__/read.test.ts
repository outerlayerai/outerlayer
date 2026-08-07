/**
 * Read layer behind the PR session comment: pins tenancy scoping (the
 * `git_connection`-enabled fan-out, the `pr_comments_enabled` gate) and the
 * verification filter that makes "unverified links never render" true by
 * construction. ClickHouse is the injected `chQuery` seam — no live
 * ClickHouse server involved. `git_connection` reads run through a local
 * MSW override (below) because the shared `managed-deployment-tables.ts`
 * handler doesn't emulate the `tenant_id` / `pr_comments_enabled` filters
 * this module actually sends — without that, a test could pass on broken
 * production code that forgot the filter.
 */
import { http, HttpResponse } from "msw";
import { getEqParam } from "@repo/test-msw";
import { describe, it, expect, vi } from "vitest";

import { server } from "@/test-helpers/msw-server";
import {
  seedManagedDeploymentTablesState,
  seedPullRequestSessionMswState,
  seedSupabaseMswState,
  type PullRequestSessionMswRow,
} from "@/test-helpers/msw-handlers";

import { readLinkedSessions, LinksUnreadableError, LINKS_UNREADABLE_REASON } from "../read";

const SUPABASE_URL = "http://localhost:54321";

const TENANT = "tenant-1";
const REPO = "acme/api";
const PR = 42;

interface GitConnectionSeedRow {
  tenant_id: string;
  app_id: string;
  repository: string;
  pr_comments_enabled: boolean;
}

/** Local override: filters `tenant_id` / `repository` / `pr_comments_enabled`
 * for real, unlike the shared handler (which only filters `app_id` /
 * `repository`). */
function seedGitConnections(rows: GitConnectionSeedRow[]) {
  server.use(
    http.get(`${SUPABASE_URL}/rest/v1/git_connection`, ({ request }) => {
      const url = new URL(request.url);
      const tenantId = getEqParam(url, "tenant_id");
      const repository = getEqParam(url, "repository");
      const prCommentsEnabled = getEqParam(url, "pr_comments_enabled");
      const matched = rows.filter(
        (r) =>
          (!tenantId || r.tenant_id === tenantId) &&
          (!repository || r.repository === repository) &&
          (!prCommentsEnabled || String(r.pr_comments_enabled) === prCommentsEnabled),
      );
      return HttpResponse.json(matched.map((r) => ({ app_id: r.app_id })));
    }),
  );
}

const link = (
  over: Partial<PullRequestSessionMswRow> &
    Pick<PullRequestSessionMswRow, "id" | "app_id" | "trace_id" | "method" | "verification">,
): PullRequestSessionMswRow => ({
  tenant_id: TENANT,
  pr_number: PR,
  session_id: `s-${over.trace_id}`,
  git_branch: "",
  first_linked_at: "2026-07-01T00:00:00.000Z",
  last_reconciled_at: "2026-07-01T00:00:00.000Z",
  ...over,
});

function chRow(over: Record<string, unknown>) {
  return {
    TraceId: "t1",
    Title: "Fix flaky auth test",
    StartedAt: "2026-07-10 09:00:00.000",
    EndedAt: "2026-07-10 09:41:00.000",
    CostUsd: 3.12,
    Models: ["opus-5"],
    ApiErrorCount: 0,
    ErrorCount: 0,
    AppId: "app-1",
    ...over,
  };
}

describe("readLinkedSessions", () => {
  it("returns null when no app has pr_comments_enabled for this repo (feature off)", async () => {
    seedGitConnections([
      { tenant_id: TENANT, app_id: "app-1", repository: REPO, pr_comments_enabled: false },
    ]);
    const chQuery = vi.fn();

    const result = await readLinkedSessions({ tenantId: TENANT, repository: REPO, prNumber: PR }, { chQuery });

    expect(result).toBeNull();
    expect(chQuery).not.toHaveBeenCalled();
  });

  it("excludes apps with pr_comments_enabled = false even when they hold a confirmed link", async () => {
    seedGitConnections([
      { tenant_id: TENANT, app_id: "app-enabled", repository: REPO, pr_comments_enabled: true },
      { tenant_id: TENANT, app_id: "app-disabled", repository: REPO, pr_comments_enabled: false },
    ]);
    seedPullRequestSessionMswState({
      links: [
        link({
          id: "l1",
          app_id: "app-enabled",
          trace_id: "t-enabled",
          method: "pr_link",
          verification: "confirmed",
        }),
        link({
          id: "l2",
          app_id: "app-disabled",
          trace_id: "t-disabled",
          method: "pr_link",
          verification: "confirmed",
        }),
      ],
    });
    const chQuery = vi.fn().mockResolvedValue([
      chRow({ TraceId: "t-enabled", AppId: "app-enabled" }),
      chRow({ TraceId: "t-disabled", AppId: "app-disabled" }),
    ]);
    seedSupabaseMswState({ apps: [{ id: "app-enabled", tenant_id: TENANT, name: "api-enabled" }] });

    const result = await readLinkedSessions({ tenantId: TENANT, repository: REPO, prNumber: PR }, { chQuery });

    expect(result).not.toBeNull();
    expect(result!.map((r) => r.traceId)).toEqual(["t-enabled"]);
    // The ClickHouse scan is only ever asked about the enabled app's trace —
    // the disabled app's session never entered the query at all.
    const [, params] = chQuery.mock.calls[0]!;
    expect(params.traceIds).toEqual(["t-enabled"]);
  });

  it("excludes a pending (unverified) link, keeping only verification = 'confirmed' rows", async () => {
    seedGitConnections([
      { tenant_id: TENANT, app_id: "app-1", repository: REPO, pr_comments_enabled: true },
    ]);
    seedPullRequestSessionMswState({
      links: [
        link({ id: "l1", app_id: "app-1", trace_id: "t-confirmed", method: "pr_link", verification: "confirmed" }),
        link({ id: "l2", app_id: "app-1", trace_id: "t-pending", method: "pr_link", verification: "pending" }),
        link({ id: "l3", app_id: "app-1", trace_id: "t-unmatched", method: "branch", verification: "unmatched" }),
      ],
    });
    const chQuery = vi.fn().mockResolvedValue([chRow({ TraceId: "t-confirmed", AppId: "app-1" })]);
    seedSupabaseMswState({ apps: [{ id: "app-1", tenant_id: TENANT, name: "api" }] });

    const result = await readLinkedSessions({ tenantId: TENANT, repository: REPO, prNumber: PR }, { chQuery });

    expect(result).not.toBeNull();
    expect(result!.map((r) => r.traceId)).toEqual(["t-confirmed"]);
    // Only the confirmed trace ever reached ClickHouse.
    const [, params] = chQuery.mock.calls[0]!;
    expect(params.traceIds).toEqual(["t-confirmed"]);
  });

  it("returns [] (not null) when the feature is on but nothing is confirmed-linked yet", async () => {
    seedGitConnections([
      { tenant_id: TENANT, app_id: "app-1", repository: REPO, pr_comments_enabled: true },
    ]);
    const chQuery = vi.fn();

    const result = await readLinkedSessions({ tenantId: TENANT, repository: REPO, prNumber: PR }, { chQuery });

    expect(result).toEqual([]);
    expect(chQuery).not.toHaveBeenCalled();
  });

  // OLDEST-first: the comment reads as the story of how the branch got
  // built, unlike the newest-first dashboard list.
  it("carries method through per row, resolves appName/envName, and sorts oldest-first by StartedAt", async () => {
    seedGitConnections([
      { tenant_id: TENANT, app_id: "app-1", repository: REPO, pr_comments_enabled: true },
    ]);
    seedPullRequestSessionMswState({
      links: [
        link({ id: "l1", app_id: "app-1", trace_id: "t-older", method: "pr_link", verification: "confirmed" }),
        link({ id: "l2", app_id: "app-1", trace_id: "t-newer", method: "branch", verification: "confirmed" }),
      ],
    });
    const chQuery = vi.fn().mockResolvedValue([
      chRow({
        TraceId: "t-older",
        AppId: "app-1",
        StartedAt: "2026-07-01 09:00:00.000",
        EndedAt: "2026-07-01 09:10:00.000",
        Title: "Older session",
      }),
      chRow({
        TraceId: "t-newer",
        AppId: "app-1",
        StartedAt: "2026-07-05 09:00:00.000",
        EndedAt: "2026-07-05 09:10:00.000",
        Title: "Newer session",
        CostUsd: 0,
        Models: ["haiku-4.5", "opus-5"],
        ApiErrorCount: 2,
      }),
    ]);
    seedSupabaseMswState({ apps: [{ id: "app-1", tenant_id: TENANT, name: "api" }] });
    seedManagedDeploymentTablesState({
      environments: [{ id: "env-1", app_id: "app-1", name: "production", is_default: true }],
    });

    const result = await readLinkedSessions({ tenantId: TENANT, repository: REPO, prNumber: PR }, { chQuery });

    expect(result).not.toBeNull();
    expect(result!.map((r) => r.traceId)).toEqual(["t-older", "t-newer"]);
    expect(result![1]).toMatchObject({
      traceId: "t-newer",
      appId: "app-1",
      appName: "api",
      envName: "production",
      method: "branch",
      title: "Newer session",
      costUsd: 0,
      models: ["haiku-4.5", "opus-5"],
      apiErrorCount: 2,
    });
    expect(result![0]).toMatchObject({
      traceId: "t-older",
      method: "pr_link",
      title: "Older session",
    });
  });

  it("maps each session to its OWN app's name and default env when two apps share the repo", async () => {
    // The name/env lookups are batched (`.in('id', …)`), so a mis-keyed map
    // would hand every row the first app's name. Two apps with distinct
    // names and distinct default envs is what makes that visible — a
    // single-app fixture passes either way.
    seedGitConnections([
      { tenant_id: TENANT, app_id: "app-a", repository: REPO, pr_comments_enabled: true },
      { tenant_id: TENANT, app_id: "app-b", repository: REPO, pr_comments_enabled: true },
    ]);
    seedPullRequestSessionMswState({
      links: [
        link({ id: "l1", app_id: "app-a", trace_id: "t-a", method: "pr_link", verification: "confirmed" }),
        link({ id: "l2", app_id: "app-b", trace_id: "t-b", method: "pr_link", verification: "confirmed" }),
      ],
    });
    const chQuery = vi.fn().mockResolvedValue([
      chRow({ TraceId: "t-a", AppId: "app-a", StartedAt: "2026-07-02 09:00:00.000" }),
      chRow({ TraceId: "t-b", AppId: "app-b", StartedAt: "2026-07-01 09:00:00.000" }),
    ]);
    seedSupabaseMswState({
      apps: [
        { id: "app-a", tenant_id: TENANT, name: "api" },
        { id: "app-b", tenant_id: TENANT, name: "worker" },
      ],
    });
    seedManagedDeploymentTablesState({
      environments: [
        { id: "env-a", app_id: "app-a", name: "production", is_default: true },
        { id: "env-b", app_id: "app-b", name: "staging", is_default: true },
        // Non-default env on app-a: must not win over `production`.
        { id: "env-a2", app_id: "app-a", name: "preview", is_default: false },
      ],
    });

    const result = await readLinkedSessions({ tenantId: TENANT, repository: REPO, prNumber: PR }, { chQuery });

    expect(result).not.toBeNull();
    // Oldest-first, so t-b (Jul 1) precedes t-a (Jul 2).
    expect(result!.map((r) => [r.traceId, r.appName, r.envName])).toEqual([
      ["t-b", "worker", "staging"],
      ["t-a", "api", "production"],
    ]);
  });

  it("scopes the pull_request_session read by tenant_id as well as app_id", async () => {
    seedGitConnections([
      { tenant_id: TENANT, app_id: "app-1", repository: REPO, pr_comments_enabled: true },
    ]);
    seedPullRequestSessionMswState({
      links: [
        link({ id: "l1", app_id: "app-1", trace_id: "t-ours", method: "pr_link", verification: "confirmed" }),
        // Same app id, foreign tenant — unreachable in production given
        // `uc_git_connection UNIQUE (app_id, tenant_id)`, but the row proves
        // the filter is actually sent rather than merely implied.
        link({
          id: "l2",
          app_id: "app-1",
          tenant_id: "tenant-other",
          trace_id: "t-theirs",
          method: "pr_link",
          verification: "confirmed",
        }),
      ],
    });
    const chQuery = vi.fn().mockResolvedValue([chRow({ TraceId: "t-ours", AppId: "app-1" })]);
    seedSupabaseMswState({ apps: [{ id: "app-1", tenant_id: TENANT, name: "api" }] });

    const result = await readLinkedSessions({ tenantId: TENANT, repository: REPO, prNumber: PR }, { chQuery });

    expect(result!.map((r) => r.traceId)).toEqual(["t-ours"]);
    const [, params] = chQuery.mock.calls[0]!;
    expect(params.traceIds).toEqual(["t-ours"]);
  });

  it("queries agent_session_summary FINAL scoped to the tenant, for a chunk of trace ids", async () => {
    seedGitConnections([
      { tenant_id: TENANT, app_id: "app-1", repository: REPO, pr_comments_enabled: true },
    ]);
    seedPullRequestSessionMswState({
      links: [link({ id: "l1", app_id: "app-1", trace_id: "t1", method: "pr_link", verification: "confirmed" })],
    });
    const chQuery = vi.fn().mockResolvedValue([chRow({ TraceId: "t1", AppId: "app-1" })]);
    seedSupabaseMswState({ apps: [{ id: "app-1", tenant_id: TENANT, name: "api" }] });

    await readLinkedSessions({ tenantId: TENANT, repository: REPO, prNumber: PR }, { chQuery });

    const [sql, params] = chQuery.mock.calls[0]!;
    expect(sql).toContain("agent_session_summary FINAL");
    expect(sql).toContain("TenantId = {tenantId:String}");
    expect(sql).toContain("TraceId IN {traceIds:Array(String)}");
    expect(params).toEqual({ tenantId: TENANT, traceIds: ["t1"] });
  });

  it("throws when confirmed links exist but no ClickHouse client resolves — never renders the empty state over real links", async () => {
    seedGitConnections([
      { tenant_id: TENANT, app_id: "app-1", repository: REPO, pr_comments_enabled: true },
    ]);
    seedPullRequestSessionMswState({
      links: [link({ id: "l1", app_id: "app-1", trace_id: "t1", method: "pr_link", verification: "confirmed" })],
    });

    // No `chQuery` override — falls through to `tenantChQuery`, which
    // returns null in this unit-test environment (no ClickHouse host set).
    await expect(readLinkedSessions({ tenantId: TENANT, repository: REPO, prNumber: PR })).rejects.toThrow(
      "ClickHouse unavailable; 1 confirmed links unreadable",
    );
  });

  it("returns [] (not a throw) when there are zero confirmed links, even with no ClickHouse client", async () => {
    seedGitConnections([
      { tenant_id: TENANT, app_id: "app-1", repository: REPO, pr_comments_enabled: true },
    ]);

    // No `chQuery` override and no confirmed links — the genuine empty
    // state, resolved before ClickHouse ever enters the picture.
    const result = await readLinkedSessions({ tenantId: TENANT, repository: REPO, prNumber: PR });

    expect(result).toEqual([]);
  });

  it("throws when the caller explicitly passes a null chQuery despite confirmed links existing", async () => {
    seedGitConnections([
      { tenant_id: TENANT, app_id: "app-1", repository: REPO, pr_comments_enabled: true },
    ]);
    seedPullRequestSessionMswState({
      links: [link({ id: "l1", app_id: "app-1", trace_id: "t1", method: "pr_link", verification: "confirmed" })],
    });

    // An explicit `null` (what `refreshPrSessionComment` passes when its own
    // `tenantChQuery` call resolved to null) must not fall back to this
    // module resolving its own client — the caller already tried.
    await expect(
      readLinkedSessions({ tenantId: TENANT, repository: REPO, prNumber: PR }, { chQuery: null }),
    ).rejects.toThrow("ClickHouse unavailable; 1 confirmed links unreadable");
  });

  it("gives that throw a distinguishable type and a stable, alertable reason prefix", async () => {
    seedGitConnections([
      { tenant_id: TENANT, app_id: "app-1", repository: REPO, pr_comments_enabled: true },
    ]);
    seedPullRequestSessionMswState({
      links: [link({ id: "l1", app_id: "app-1", trace_id: "t1", method: "pr_link", verification: "confirmed" })],
    });

    // A sustained run of THIS failure is an incident — it is the only state
    // in which the empty state could overwrite a populated comment — unlike
    // every other `failed` reason, which is transient noise. It must be
    // separable from them without string-matching a free-form message.
    await expect(
      readLinkedSessions({ tenantId: TENANT, repository: REPO, prNumber: PR }, { chQuery: null }),
    ).rejects.toBeInstanceOf(LinksUnreadableError);
    await expect(
      readLinkedSessions({ tenantId: TENANT, repository: REPO, prNumber: PR }, { chQuery: null }),
    ).rejects.toThrow(LINKS_UNREADABLE_REASON);
  });

  // AC-057-05: `confirmed` is fanned out over every enabled app for the
  // repo, so one trace can carry a row per app — `pr_link` for one and
  // `branch` for another. Collapsing on row order (arbitrary, PostgREST's)
  // would render a session that explicitly claimed the PR as `_(inferred)_`.
  it("keeps pr_link precedence when one trace has rows for two apps", async () => {
    seedGitConnections([
      { tenant_id: TENANT, app_id: "app-a", repository: REPO, pr_comments_enabled: true },
      { tenant_id: TENANT, app_id: "app-b", repository: REPO, pr_comments_enabled: true },
    ]);
    seedPullRequestSessionMswState({
      links: [
        // Branch-inferred row FIRST, so a last-write-wins map would keep the
        // pr_link one by luck; the reverse order is the failing case, and
        // both must resolve to pr_link.
        link({ id: "l1", app_id: "app-b", trace_id: "t1", method: "branch", verification: "confirmed" }),
        link({ id: "l2", app_id: "app-a", trace_id: "t1", method: "pr_link", verification: "confirmed" }),
        link({ id: "l3", app_id: "app-a", trace_id: "t2", method: "pr_link", verification: "confirmed" }),
        link({ id: "l4", app_id: "app-b", trace_id: "t2", method: "branch", verification: "confirmed" }),
      ],
    });
    const chQuery = vi.fn().mockResolvedValue([
      chRow({ TraceId: "t1", AppId: "app-a", StartedAt: "2026-07-01 09:00:00.000" }),
      chRow({ TraceId: "t2", AppId: "app-a", StartedAt: "2026-07-02 09:00:00.000" }),
    ]);
    seedSupabaseMswState({
      apps: [
        { id: "app-a", tenant_id: TENANT, name: "api" },
        { id: "app-b", tenant_id: TENANT, name: "worker" },
      ],
    });

    const result = await readLinkedSessions({ tenantId: TENANT, repository: REPO, prNumber: PR }, { chQuery });

    expect(result!.map((r) => r.method)).toEqual(["pr_link", "pr_link"]);
  });
});
