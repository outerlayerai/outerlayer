/**
 * reconcileArtifacts: pending artifacts resolve to PRs through their claimed
 * number, their session's confirmed links, or branch+window matching — and
 * age out to `unmatched` when nothing ever matches.
 */
import { http, HttpResponse } from "msw";
import { describe, it, expect, beforeEach } from "vitest";

import { server } from "@/test-helpers/msw-server";
import {
  seedArtifactMswRows,
  getArtifactMswRows,
  seedPullRequestSessionMswState,
  type ArtifactMswRow,
} from "@/test-helpers/msw-handlers";
import { getAdminDataClient } from "@/lib/system/admin-client";

import { reconcileArtifacts } from "../artifact-reconcile";

const SUPABASE_URL = "http://localhost:54321";
const TENANT = "tenant-1";
const APP = "app-1";
const NOW = new Date("2026-08-14T12:00:00.000Z");

function seedGitConnection(repository: string) {
  server.use(
    http.get(`${SUPABASE_URL}/rest/v1/git_connection`, () =>
      HttpResponse.json([{ app_id: APP, tenant_id: TENANT, repository }]),
    ),
  );
}

const pendingArtifact = (over: Partial<ArtifactMswRow>): ArtifactMswRow => ({
  id: "a1",
  tenant_id: TENANT,
  app_id: APP,
  filename: "shot.png",
  kind: "screenshot",
  caption: "",
  criterion_id: "",
  provenance: "session",
  trace_id: "",
  repository: "",
  pr_number: null,
  git_repo: "",
  git_branch: "",
  verification: "pending",
  emitted_at: "2026-08-14T10:00:00.000Z",
  last_reconciled_at: "2026-08-14T10:00:00.000Z",
  ...over,
});

beforeEach(() => {
  seedGitConnection("acme/api");
});

describe("reconcileArtifacts", () => {
  // proves AC-084-07
  it("confirms a pending session-anchored artifact through its session's confirmed PR link", async () => {
    seedPullRequestSessionMswState({
      pullRequests: [
        {
          pr_number: 61,
          app_id: APP,
          head_branch: "feat/x",
          opened_at: "2026-08-13T00:00:00.000Z",
          closed_at: null,
          merged_at: null,
        },
      ],
      links: [
        {
          id: "l1",
          tenant_id: TENANT,
          app_id: APP,
          pr_number: 61,
          trace_id: "trace-1",
          session_id: "s1",
          method: "pr_link",
          verification: "confirmed",
          git_branch: "feat/x",
          first_linked_at: "2026-08-13T00:00:00.000Z",
          last_reconciled_at: "2026-08-13T00:00:00.000Z",
        },
      ],
    });
    seedArtifactMswRows([pendingArtifact({ id: "a1", trace_id: "trace-1" })]);

    const result = await reconcileArtifacts(getAdminDataClient(), NOW);

    expect(result.counts).toEqual({ pending: 1, confirmed: 1, unmatched: 0 });
    expect(result.changed).toEqual([{ appId: APP, prNumber: 61 }]);
    const [row] = getArtifactMswRows();
    expect(row).toMatchObject({
      id: "a1",
      verification: "confirmed",
      pr_number: 61,
      repository: "acme/api",
      last_reconciled_at: NOW.toISOString(),
    });
  });

  // proves AC-084-04 — the anchoring half: a local checkout's branch binds to
  // the PR whose activity window contains the emit time (the CLI half of the
  // criterion — emit-time git context and --pr — is proven in
  // packages/cli/src/__tests__/emit-artifact-cmd.test.ts).
  it("confirms a claimed PR number once the provider record exists, and matches branch-tier artifacts by window", async () => {
    seedPullRequestSessionMswState({
      pullRequests: [
        {
          pr_number: 7,
          app_id: APP,
          head_branch: "feat/allowlist",
          opened_at: "2026-08-10T00:00:00.000Z",
          closed_at: null,
          merged_at: null,
        },
      ],
      links: [],
    });
    seedArtifactMswRows([
      pendingArtifact({ id: "claimed", pr_number: 7, repository: "acme/api", provenance: "ci" }),
      pendingArtifact({
        id: "branch-match",
        provenance: "local",
        git_repo: "github.com/acme/api",
        git_branch: "feat/allowlist",
      }),
      pendingArtifact({
        id: "wrong-repo",
        provenance: "local",
        git_repo: "github.com/other/repo",
        git_branch: "feat/allowlist",
      }),
    ]);

    const result = await reconcileArtifacts(getAdminDataClient(), NOW);

    expect(result.counts).toEqual({ pending: 3, confirmed: 2, unmatched: 0 });
    const rows = new Map(getArtifactMswRows().map((r) => [r.id, r]));
    expect(rows.get("claimed")).toMatchObject({ verification: "confirmed", pr_number: 7 });
    expect(rows.get("branch-match")).toMatchObject({
      verification: "confirmed",
      pr_number: 7,
      repository: "acme/api",
    });
    // A checkout from a different repository never binds to this app's PRs.
    expect(rows.get("wrong-repo")).toMatchObject({ verification: "pending", pr_number: null });
  });

  // proves AC-084-08
  it("marks a pending artifact past the grace window as unmatched", async () => {
    seedPullRequestSessionMswState({ pullRequests: [], links: [] });
    seedArtifactMswRows([
      pendingArtifact({
        id: "stale",
        git_branch: "gone-branch",
        emitted_at: "2026-07-01T00:00:00.000Z",
      }),
      pendingArtifact({ id: "fresh", git_branch: "gone-branch" }),
    ]);

    const result = await reconcileArtifacts(getAdminDataClient(), NOW);

    expect(result.counts).toEqual({ pending: 2, confirmed: 0, unmatched: 1 });
    expect(result.changed).toEqual([]);
    const rows = new Map(getArtifactMswRows().map((r) => [r.id, r]));
    expect(rows.get("stale")).toMatchObject({
      verification: "unmatched",
      last_reconciled_at: NOW.toISOString(),
    });
    // Inside the grace window nothing moves — the next sweep retries.
    expect(rows.get("fresh")).toMatchObject({ verification: "pending" });
  });
});

describe("reconcileArtifacts — matching boundaries", () => {
  it("respects the activity window: too-early and after-close emits stay pending, lookback-padded emits bind", async () => {
    seedPullRequestSessionMswState({
      pullRequests: [
        {
          pr_number: 9,
          app_id: APP,
          head_branch: "feat/window",
          opened_at: "2026-08-10T00:00:00.000Z",
          closed_at: "2026-08-12T00:00:00.000Z",
          merged_at: null,
        },
      ],
      links: [],
    });
    seedArtifactMswRows([
      // 15 days before opened_at — outside the 14-day lookback padding, and
      // therefore also past the pending grace window: it ages out.
      pendingArtifact({
        id: "too-early",
        git_repo: "github.com/acme/api",
        git_branch: "feat/window",
        emitted_at: "2026-07-26T00:00:00.000Z",
      }),
      // After the PR was decided (closed) — its window has ended.
      pendingArtifact({
        id: "after-close",
        git_repo: "github.com/acme/api",
        git_branch: "feat/window",
        emitted_at: "2026-08-13T00:00:00.000Z",
      }),
      // 13 days before opened_at — inside the lookback padding.
      pendingArtifact({
        id: "padded",
        git_repo: "github.com/acme/api",
        git_branch: "feat/window",
        emitted_at: "2026-07-28T00:00:00.000Z",
      }),
    ]);

    const result = await reconcileArtifacts(getAdminDataClient(), NOW);

    expect(result.counts).toEqual({ pending: 3, confirmed: 1, unmatched: 1 });
    const rows = new Map(getArtifactMswRows().map((r) => [r.id, r]));
    expect(rows.get("too-early")).toMatchObject({ verification: "unmatched", pr_number: null });
    expect(rows.get("after-close")).toMatchObject({ verification: "pending", pr_number: null });
    expect(rows.get("padded")).toMatchObject({ verification: "confirmed", pr_number: 9 });
  });

  it("prefers the newest PR when a recycled branch matches more than one window, and dedupes the changed set", async () => {
    seedPullRequestSessionMswState({
      pullRequests: [
        {
          pr_number: 3,
          app_id: APP,
          head_branch: "feat/recycled",
          opened_at: "2026-08-01T00:00:00.000Z",
          closed_at: null,
          merged_at: null,
        },
        {
          pr_number: 8,
          app_id: APP,
          head_branch: "feat/recycled",
          opened_at: "2026-08-10T00:00:00.000Z",
          closed_at: null,
          merged_at: null,
        },
      ],
      links: [],
    });
    seedArtifactMswRows([
      pendingArtifact({
        id: "first",
        git_repo: "github.com/acme/api",
        git_branch: "feat/recycled",
        emitted_at: "2026-08-12T00:00:00.000Z",
      }),
      pendingArtifact({
        id: "second",
        git_repo: "github.com/acme/api",
        git_branch: "feat/recycled",
        emitted_at: "2026-08-13T00:00:00.000Z",
      }),
    ]);

    const result = await reconcileArtifacts(getAdminDataClient(), NOW);

    const rows = new Map(getArtifactMswRows().map((r) => [r.id, r]));
    expect(rows.get("first")).toMatchObject({ verification: "confirmed", pr_number: 8 });
    expect(rows.get("second")).toMatchObject({ verification: "confirmed", pr_number: 8 });
    // Two confirmations onto one PR nominate ONE refresh.
    expect(result.changed).toEqual([{ appId: APP, prNumber: 8 }]);
  });

  it("binds a session artifact through its single confirmed link even when the PR row's window is unusable", async () => {
    seedPullRequestSessionMswState({
      pullRequests: [
        {
          pr_number: 12,
          app_id: APP,
          head_branch: "feat/x",
          opened_at: null,
          closed_at: null,
          merged_at: null,
        },
      ],
      links: [
        {
          id: "l1",
          tenant_id: TENANT,
          app_id: APP,
          pr_number: 12,
          trace_id: "trace-solo",
          session_id: "s1",
          method: "pr_link",
          verification: "confirmed",
          git_branch: "feat/x",
          first_linked_at: "2026-08-13T00:00:00.000Z",
          last_reconciled_at: "2026-08-13T00:00:00.000Z",
        },
      ],
    });
    seedArtifactMswRows([pendingArtifact({ id: "solo", trace_id: "trace-solo" })]);

    const result = await reconcileArtifacts(getAdminDataClient(), NOW);

    expect(result.counts).toEqual({ pending: 1, confirmed: 1, unmatched: 0 });
    expect(getArtifactMswRows()[0]).toMatchObject({
      id: "solo",
      verification: "confirmed",
      pr_number: 12,
    });
  });

  it("leaves a session artifact pending when its trace links to multiple PRs and no window can arbitrate", async () => {
    seedPullRequestSessionMswState({
      pullRequests: [
        { pr_number: 20, app_id: APP, head_branch: "a", opened_at: null, closed_at: null, merged_at: null },
        { pr_number: 21, app_id: APP, head_branch: "b", opened_at: null, closed_at: null, merged_at: null },
      ],
      links: [20, 21].map((pr) => ({
        id: `l-${pr}`,
        tenant_id: TENANT,
        app_id: APP,
        pr_number: pr,
        trace_id: "trace-multi",
        session_id: "s1",
        method: "pr_link" as const,
        verification: "confirmed" as const,
        git_branch: "",
        first_linked_at: "2026-08-13T00:00:00.000Z",
        last_reconciled_at: "2026-08-13T00:00:00.000Z",
      })),
    });
    seedArtifactMswRows([pendingArtifact({ id: "ambiguous", trace_id: "trace-multi" })]);

    const result = await reconcileArtifacts(getAdminDataClient(), NOW);

    expect(result.counts).toEqual({ pending: 1, confirmed: 0, unmatched: 0 });
    expect(getArtifactMswRows()[0]).toMatchObject({
      id: "ambiguous",
      verification: "pending",
      pr_number: null,
    });
  });
});

describe("reconcileArtifacts — edges", () => {
  it("returns exact zero counts and no changes when nothing is pending", async () => {
    seedPullRequestSessionMswState({ pullRequests: [], links: [] });

    const result = await reconcileArtifacts(getAdminDataClient(), NOW);

    expect(result).toEqual({
      counts: { pending: 0, confirmed: 0, unmatched: 0 },
      changed: [],
    });
  });

  it("keeps a claimed PR number pending while the provider record is still missing", async () => {
    seedPullRequestSessionMswState({ pullRequests: [], links: [] });
    seedArtifactMswRows([
      pendingArtifact({ id: "claimed-early", pr_number: 99, repository: "acme/api", provenance: "ci" }),
    ]);

    const result = await reconcileArtifacts(getAdminDataClient(), NOW);

    expect(result.counts).toEqual({ pending: 1, confirmed: 0, unmatched: 0 });
    expect(result.changed).toEqual([]);
    expect(getArtifactMswRows()[0]).toMatchObject({
      id: "claimed-early",
      verification: "pending",
      pr_number: 99,
    });
  });
});
