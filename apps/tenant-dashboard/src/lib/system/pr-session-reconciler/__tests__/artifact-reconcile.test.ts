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
  getPullRequestReadQueries,
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

describe("reconcileArtifacts — claimed-repository agreement", () => {
  const claimedPrSeed = () =>
    seedPullRequestSessionMswState({
      pullRequests: [
        {
          pr_number: 7,
          app_id: APP,
          head_branch: "feat/x",
          opened_at: "2026-08-10T00:00:00.000Z",
          closed_at: null,
          merged_at: null,
        },
      ],
      links: [],
    });

  it("never confirms a claimed PR whose claimed repository names a different repo — the cross-repo forgery", async () => {
    claimedPrSeed();
    // The app's connection is acme/api; the emit claims acme/web (a repo the
    // caller's CI env can name freely) with a PR number that exists in THIS
    // app. Confirming would stamp the artifact as acme/web#7 evidence.
    seedArtifactMswRows([
      pendingArtifact({ id: "forged", pr_number: 7, repository: "acme/web", provenance: "ci" }),
      pendingArtifact({
        id: "garbage-claim",
        pr_number: 7,
        repository: "not a repo at all",
        provenance: "ci",
      }),
    ]);

    const result = await reconcileArtifacts(getAdminDataClient(), NOW);

    expect(result.counts).toEqual({ pending: 2, confirmed: 0, unmatched: 0 });
    expect(result.changed).toEqual([]);
    const rows = new Map(getArtifactMswRows().map((r) => [r.id, r]));
    expect(rows.get("forged")).toMatchObject({ verification: "pending", pr_number: 7 });
    expect(rows.get("garbage-claim")).toMatchObject({ verification: "pending" });
  });

  it("confirms an agreeing claim in any accepted spelling and stamps the connection's canonical repo, never the claim verbatim", async () => {
    claimedPrSeed();
    seedArtifactMswRows([
      pendingArtifact({
        id: "spelled",
        pr_number: 7,
        repository: "https://github.com/Acme/API.git",
        provenance: "ci",
      }),
      pendingArtifact({ id: "unclaimed-repo", pr_number: 7, repository: "", provenance: "ci" }),
    ]);

    const result = await reconcileArtifacts(getAdminDataClient(), NOW);

    expect(result.counts).toEqual({ pending: 2, confirmed: 2, unmatched: 0 });
    const rows = new Map(getArtifactMswRows().map((r) => [r.id, r]));
    expect(rows.get("spelled")).toMatchObject({
      verification: "confirmed",
      pr_number: 7,
      repository: "acme/api",
    });
    expect(rows.get("unclaimed-repo")).toMatchObject({
      verification: "confirmed",
      pr_number: 7,
      repository: "acme/api",
    });
  });

  it("confirms an app with no GitHub connection through the claimed tier and stamps the canonicalized claim", async () => {
    seedGitConnection("");
    seedPullRequestSessionMswState({
      pullRequests: [
        {
          pr_number: 7,
          app_id: APP,
          head_branch: "feat/x",
          opened_at: "2026-08-10T00:00:00.000Z",
          closed_at: null,
          merged_at: null,
        },
      ],
      links: [],
    });
    // No canonical connection repo exists to disagree with — the provider
    // record itself is still the evidence, and the stamp falls back to the
    // canonical form of the claim, never the raw spelling.
    seedArtifactMswRows([
      pendingArtifact({
        id: "no-conn",
        pr_number: 7,
        repository: "https://github.com/Acme/API",
        provenance: "ci",
      }),
    ]);

    const result = await reconcileArtifacts(getAdminDataClient(), NOW);

    expect(result.counts).toEqual({ pending: 1, confirmed: 1, unmatched: 0 });
    expect(getArtifactMswRows()[0]).toMatchObject({
      id: "no-conn",
      verification: "confirmed",
      pr_number: 7,
      repository: "acme/api",
    });
  });

  it("nominates a comment refresh when a directly PR-anchored artifact ages out to unmatched", async () => {
    claimedPrSeed();
    // A pending artifact with a direct PR anchor renders on the comment, so
    // aging out must nominate the refresh that removes its dead link.
    seedArtifactMswRows([
      pendingArtifact({
        id: "stale-claim",
        pr_number: 99,
        repository: "acme/api",
        provenance: "ci",
        emitted_at: "2026-07-01T00:00:00.000Z",
      }),
    ]);

    const result = await reconcileArtifacts(getAdminDataClient(), NOW);

    expect(result.counts).toEqual({ pending: 1, confirmed: 0, unmatched: 1 });
    expect(result.changed).toEqual([{ appId: APP, prNumber: 99 }]);
    expect(getArtifactMswRows()[0]).toMatchObject({
      id: "stale-claim",
      verification: "unmatched",
    });
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

  it("ends a merged PR's window at merged_at — an emit after the merge never binds", async () => {
    seedPullRequestSessionMswState({
      pullRequests: [
        {
          pr_number: 11,
          app_id: APP,
          head_branch: "feat/merged",
          opened_at: "2026-08-10T00:00:00.000Z",
          closed_at: null,
          merged_at: "2026-08-12T00:00:00.000Z",
        },
      ],
      links: [],
    });
    seedArtifactMswRows([
      pendingArtifact({
        id: "post-merge",
        git_repo: "github.com/acme/api",
        git_branch: "feat/merged",
        emitted_at: "2026-08-13T00:00:00.000Z",
      }),
      pendingArtifact({
        id: "pre-merge",
        git_repo: "github.com/acme/api",
        git_branch: "feat/merged",
        emitted_at: "2026-08-11T00:00:00.000Z",
      }),
    ]);

    const result = await reconcileArtifacts(getAdminDataClient(), NOW);

    expect(result.counts).toEqual({ pending: 2, confirmed: 1, unmatched: 0 });
    const rows = new Map(getArtifactMswRows().map((r) => [r.id, r]));
    expect(rows.get("post-merge")).toMatchObject({ verification: "pending", pr_number: null });
    expect(rows.get("pre-merge")).toMatchObject({ verification: "confirmed", pr_number: 11 });
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

describe("reconcileArtifacts — pull_request read scoping", () => {
  it("issues exactly two exact-scoped reads for a mixed batch: claimed/session numbers by in-list, branch names by in-list newest-first", async () => {
    seedPullRequestSessionMswState({
      pullRequests: [
        {
          pr_number: 7,
          app_id: APP,
          head_branch: "feat/claimed",
          opened_at: "2026-08-10T00:00:00.000Z",
          closed_at: null,
          merged_at: null,
        },
        {
          pr_number: 8,
          app_id: APP,
          head_branch: "feat/linked",
          opened_at: "2026-08-10T00:00:00.000Z",
          closed_at: null,
          merged_at: null,
        },
      ],
      links: [
        {
          id: "l1",
          tenant_id: TENANT,
          app_id: APP,
          pr_number: 8,
          trace_id: "trace-q",
          session_id: "s1",
          method: "pr_link",
          verification: "confirmed",
          git_branch: "feat/linked",
          first_linked_at: "2026-08-13T00:00:00.000Z",
          last_reconciled_at: "2026-08-13T00:00:00.000Z",
        },
      ],
    });
    seedArtifactMswRows([
      // Claimed and session artifacts carry checkout branches too — those
      // branches must NOT leak into the branch-tier read.
      pendingArtifact({
        id: "claimed",
        pr_number: 7,
        repository: "acme/api",
        provenance: "ci",
        git_branch: "decoy-claimed",
      }),
      pendingArtifact({ id: "linked", trace_id: "trace-q", git_branch: "decoy-linked" }),
      pendingArtifact({ id: "branch-a", git_repo: "github.com/acme/api", git_branch: "feat/b1" }),
      pendingArtifact({ id: "branch-b", git_repo: "github.com/acme/api", git_branch: "feat/b1" }),
      pendingArtifact({ id: "no-anchor", git_branch: "" }),
    ]);

    await reconcileArtifacts(getAdminDataClient(), NOW);

    // Positional and byte-exact: the numbered read names exactly the
    // claimed+session numbers, the branch read exactly the deduped
    // branch-tier branches with the newest-first order — never a bare
    // limited scan whose subset is unspecified.
    expect(getPullRequestReadQueries()).toEqual([
      "select=pr_number,head_branch,opened_at,closed_at,merged_at&app_id=eq.app-1&pr_number=in.(7,8)&limit=2",
      "select=pr_number,head_branch,opened_at,closed_at,merged_at&app_id=eq.app-1&head_branch=in.(feat/b1)&order=opened_at.desc.nullslast&limit=2000",
    ]);
  });

  it("issues no numbered read at all for a branch-only batch", async () => {
    seedPullRequestSessionMswState({ pullRequests: [], links: [] });
    seedArtifactMswRows([
      pendingArtifact({ id: "branch-only", git_repo: "github.com/acme/api", git_branch: "feat/solo" }),
    ]);

    await reconcileArtifacts(getAdminDataClient(), NOW);

    expect(
      getPullRequestReadQueries().filter((q) => q.includes("pr_number=in.")),
    ).toEqual([]);
    expect(getPullRequestReadQueries()).toHaveLength(1);
  });
});

describe("reconcileArtifacts — grace windows", () => {
  it("gives a session-anchored artifact the extended grace covering the session link window", async () => {
    seedPullRequestSessionMswState({ pullRequests: [], links: [] });
    seedArtifactMswRows([
      // 20 days old: past the base grace, inside the session-anchored one —
      // its PR could still open and confirm through the session link.
      pendingArtifact({
        id: "session-waiting",
        trace_id: "trace-late",
        emitted_at: "2026-07-25T00:00:00.000Z",
      }),
      // 29 days old: past base grace + link lookback; nothing can bind now.
      pendingArtifact({
        id: "session-expired",
        trace_id: "trace-gone",
        emitted_at: "2026-07-16T00:00:00.000Z",
      }),
      // Same 20-day age with no session anchor: only the base grace applies.
      pendingArtifact({
        id: "branch-expired",
        git_branch: "gone-branch",
        emitted_at: "2026-07-25T00:00:00.000Z",
      }),
    ]);

    const result = await reconcileArtifacts(getAdminDataClient(), NOW);

    expect(result.counts).toEqual({ pending: 3, confirmed: 0, unmatched: 2 });
    const rows = new Map(getArtifactMswRows().map((r) => [r.id, r]));
    expect(rows.get("session-waiting")).toMatchObject({ verification: "pending" });
    expect(rows.get("session-expired")).toMatchObject({ verification: "unmatched" });
    expect(rows.get("branch-expired")).toMatchObject({ verification: "unmatched" });
  });

  it("keeps an artifact pending at exactly the grace age — only strictly past it does it unmatch", async () => {
    seedPullRequestSessionMswState({ pullRequests: [], links: [] });
    seedArtifactMswRows([
      // Exactly 14 days before NOW, to the millisecond.
      pendingArtifact({
        id: "at-boundary",
        git_branch: "gone-branch",
        emitted_at: "2026-07-31T12:00:00.000Z",
      }),
      pendingArtifact({
        id: "past-boundary",
        git_branch: "gone-branch",
        emitted_at: "2026-07-31T11:59:59.999Z",
      }),
    ]);

    const result = await reconcileArtifacts(getAdminDataClient(), NOW);

    expect(result.counts).toEqual({ pending: 2, confirmed: 0, unmatched: 1 });
    const rows = new Map(getArtifactMswRows().map((r) => [r.id, r]));
    expect(rows.get("at-boundary")).toMatchObject({ verification: "pending" });
    expect(rows.get("past-boundary")).toMatchObject({ verification: "unmatched" });
  });
});

describe("reconcileArtifacts — edges", () => {
  it("finds a claimed PR even when the app's pull_request table dwarfs any scan bound", async () => {
    // 2,500 rows on other branches; the claimed number sits past any
    // arbitrary 2,000-row subset a bare limited scan would return. The
    // claimed lookup must query the number itself, or the artifact
    // false-negatives into terminal unmatch although its PR exists.
    seedPullRequestSessionMswState({
      pullRequests: Array.from({ length: 2_500 }, (_, i) => ({
        pr_number: i + 1,
        app_id: APP,
        head_branch: `feat/other-${i + 1}`,
        opened_at: "2026-08-01T00:00:00.000Z",
        closed_at: null,
        merged_at: null,
      })),
      links: [],
    });
    seedArtifactMswRows([
      pendingArtifact({
        id: "claimed-high",
        pr_number: 2_500,
        repository: "acme/api",
        provenance: "ci",
        emitted_at: "2026-07-01T00:00:00.000Z",
      }),
      // A branch-tier artifact in the same batch, so the read cannot fall
      // back to a single narrowed-by-number query shape by accident.
      pendingArtifact({
        id: "branch-too",
        git_repo: "github.com/acme/api",
        git_branch: "feat/other-2500",
      }),
    ]);

    const result = await reconcileArtifacts(getAdminDataClient(), NOW);

    expect(result.counts).toEqual({ pending: 2, confirmed: 2, unmatched: 0 });
    const rows = new Map(getArtifactMswRows().map((r) => [r.id, r]));
    expect(rows.get("claimed-high")).toMatchObject({
      verification: "confirmed",
      pr_number: 2_500,
    });
    expect(rows.get("branch-too")).toMatchObject({ verification: "confirmed", pr_number: 2_500 });
  });

  it("returns exact zero counts and no changes when nothing is pending", async () => {
    seedPullRequestSessionMswState({ pullRequests: [], links: [] });

    const result = await reconcileArtifacts(getAdminDataClient(), NOW);

    expect(result).toEqual({
      counts: { pending: 0, confirmed: 0, unmatched: 0 },
      changed: [],
    });
  });

  it("leaves artifacts pending when the pull_request read fails — the next sweep retries", async () => {
    seedPullRequestSessionMswState({ pullRequests: [], links: [] });
    server.use(
      http.get(`${SUPABASE_URL}/rest/v1/pull_request`, () =>
        HttpResponse.json({ message: "boom" }, { status: 500 }),
      ),
    );
    seedArtifactMswRows([
      pendingArtifact({ id: "claimed", pr_number: 7, repository: "acme/api", provenance: "ci" }),
    ]);

    const result = await reconcileArtifacts(getAdminDataClient(), NOW);

    expect(result.counts).toEqual({ pending: 1, confirmed: 0, unmatched: 0 });
    expect(getArtifactMswRows()[0]).toMatchObject({ id: "claimed", verification: "pending" });
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
    // Claimed-only batch: exactly the numbered read, never a branch read.
    expect(
      getPullRequestReadQueries().filter((q) => q.includes("head_branch=in.")),
    ).toEqual([]);
    expect(getPullRequestReadQueries()).toHaveLength(1);
  });
});
