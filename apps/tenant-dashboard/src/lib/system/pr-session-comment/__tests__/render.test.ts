/**
 * renderComment: pure markdown rendering for the PR session comment. No I/O
 * involved — every case here is plain objects in, a string out. This is
 * where most of `acceptance/057-pr-session-comment.md`'s criteria get
 * proven, because a pure function can prove them cheaply.
 */
import { describe, it, expect } from "vitest";

import { renderComment, type RenderLinks } from "../render";
import type { LinkedSessionRow } from "../read";

const LINKS: RenderLinks = {
  baseUrl: "https://app.outerlayer.example",
  orgName: "acme",
  prNumber: 812,
};

const row = (over: Partial<LinkedSessionRow> & Pick<LinkedSessionRow, "traceId">): LinkedSessionRow => ({
  sessionId: `s-${over.traceId}`,
  appId: "app-1",
  appName: "api",
  envName: "production",
  method: "pr_link",
  title: "Fix flaky auth test",
  startedAt: "2026-07-10T09:00:00.000Z",
  endedAt: "2026-07-10T09:41:00.000Z",
  costUsd: 3.12,
  models: ["opus-5"],
  apiErrorCount: 0,
  errorCount: 0,
  ...over,
});

describe("renderComment", () => {
  // AC-057-01: full session table + header rollup, sums over linked
  // sessions, per-row deep link, topics/duration/cost/models all present.
  it("renders the full table with a header rollup summed over linked sessions", () => {
    const rows: LinkedSessionRow[] = [
      row({
        traceId: "t1",
        title: "Fix flaky auth test",
        startedAt: "2026-07-10T09:00:00.000Z",
        endedAt: "2026-07-10T09:41:00.000Z",
        costUsd: 3.12,
        models: ["opus-5"],
      }),
      row({
        traceId: "t2",
        title: "Retry loop on auth.ts",
        startedAt: "2026-07-10T10:00:00.000Z",
        endedAt: "2026-07-10T11:12:00.000Z",
        costUsd: 11.87,
        models: ["opus-5", "haiku-4.5"],
        apiErrorCount: 2,
      }),
    ];
    const topics = new Map<string, string[]>([["t2", ["flaky tests"]]]);

    const body = renderComment(rows, topics, LINKS);

    expect(body).toContain(
      "### Agent sessions behind this PR — 2 linked sessions · 1h 53m · $14.99",
    );
    expect(body).toContain("sums over linked sessions");
    expect(body).not.toMatch(/per-PR/i);
    expect(body).toContain("| Session | Topics | Duration | Cost | Models |");
    expect(body).toContain(
      "[Fix flaky auth test](https://app.outerlayer.example/orgs/acme/apps/api/env/production/agents/sessions/t1?src=pr-comment)",
    );
    expect(body).toContain("41m");
    expect(body).toContain("$3.12");
    expect(body).toContain("opus-5");
    expect(body).toContain("1h 12m");
    expect(body).toContain("$11.87");
    expect(body).toContain("opus-5, haiku-4.5");
    expect(body).toContain("flaky tests");
    expect(body).toContain("⚠ provider errors");
    expect(body).toContain(
      "[session dashboard](https://app.outerlayer.example/orgs/acme/apps/api/env/production/agents/sessions?pr=812&src=pr-comment)",
    );
  });

  // AC-057-04: a connected repo's PR always gets this slot, even with no
  // verified links, so a *missing* comment reads as "app not connected".
  it("renders the empty-state sentence when there are no linked sessions", () => {
    const body = renderComment([], new Map(), LINKS);

    expect(body).toBe("No agent sessions linked yet.");
  });

  // AC-057-05: a branch-inferred link is visibly marked, never presented as
  // certain.
  it("marks method='branch' rows as inferred", () => {
    const rows = [row({ traceId: "t1", method: "branch" })];

    const body = renderComment(rows, new Map(), LINKS);

    expect(body).toContain("_(inferred)_");
  });

  it("does not mark method='pr_link' rows as inferred", () => {
    const rows = [row({ traceId: "t1", method: "pr_link" })];

    const body = renderComment(rows, new Map(), LINKS);

    expect(body).not.toContain("_(inferred)_");
  });

  // AC-057-06: provider errors and error storms gate the trouble marker;
  // stuck-edit-loop badging is explicitly out of scope for this rollup row.
  it("badges a row with provider errors", () => {
    const rows = [row({ traceId: "t1", apiErrorCount: 1, errorCount: 0 })];

    const body = renderComment(rows, new Map(), LINKS);

    expect(body).toContain("⚠ provider errors");
  });

  it("badges a row whose error count exceeds the error-storm threshold", () => {
    const rows = [row({ traceId: "t1", apiErrorCount: 0, errorCount: 11 })];

    const body = renderComment(rows, new Map(), LINKS);

    expect(body).toContain("⚠ error storm");
  });

  it("does not badge a row with a small, non-storm error count and no provider errors", () => {
    const rows = [row({ traceId: "t1", apiErrorCount: 0, errorCount: 3 })];

    const body = renderComment(rows, new Map(), LINKS);

    expect(body).not.toContain("⚠");
  });

  // AC-057-07: topic labels render as plain text from any facet, never
  // facet summary/transcript text, and a session with no topics renders
  // without labels.
  it("renders topic labels as plain text and never facet summary content", () => {
    const rows = [row({ traceId: "t1" }), row({ traceId: "t2" })];
    const topics = new Map<string, string[]>([
      ["t1", ["flaky tests", "auth"]],
      // t2 intentionally absent: no facets yet.
    ]);

    const body = renderComment(rows, topics, LINKS);

    expect(body).toContain("flaky tests, auth");
    expect(body).not.toContain("Summary");
  });

  // AC-057-08: a reader without dashboard access sees topics, durations,
  // costs, and deep links — never a human name, actor field, or transcript
  // content. Simulate a hypothetically "leaky" upstream row (extra
  // actor-shaped fields no LinkedSessionRow actually carries) and assert
  // none of it surfaces, as a structural regression guard.
  it("never renders human names, actor/author/profile fields, or transcript content", () => {
    const leakyRow = {
      ...row({ traceId: "t1", title: "Fix flaky auth test" }),
      actorName: "Jane Doe",
      authorEmail: "jane@example.com",
      profileHandle: "@janedoe",
      transcriptSummary: "The user asked the agent to fix the flaky test by retrying auth.ts",
    } as unknown as LinkedSessionRow;

    const body = renderComment([leakyRow], new Map(), LINKS);

    expect(body).not.toContain("Jane Doe");
    expect(body).not.toContain("jane@example.com");
    expect(body).not.toContain("@janedoe");
    expect(body).not.toContain("The user asked the agent");
    expect(body).not.toMatch(/actor/i);
    expect(body).not.toMatch(/author/i);
    expect(body).not.toMatch(/profile/i);
  });

  // AC-057-11: missing title renders "untitled session", missing topics
  // render an em dash, and cost always renders a dollar amount — $0.00 at
  // genuine zero, since CostUsd is non-nullable and cannot distinguish
  // "unrecorded" from "genuinely zero".
  it("renders untitled session, an em dash for missing topics, and $0.00 for zero cost", () => {
    const rows = [row({ traceId: "t1", title: "", costUsd: 0 })];

    const body = renderComment(rows, new Map(), LINKS);

    expect(body).toContain("[untitled session]");
    expect(body).toContain("| — |");
    expect(body).toContain("$0.00");
  });

  it("escapes a title containing a pipe or newline so it cannot break the table", () => {
    const rows = [row({ traceId: "t1", title: "Fix auth | login\nflow" })];

    const body = renderComment(rows, new Map(), LINKS);
    const lines = body.split("\n");
    const rowLine = lines.find((l) => l.startsWith("| [Fix"));

    expect(rowLine).toEqual(
      "| [Fix auth \\| login flow](https://app.outerlayer.example/orgs/acme/apps/api/env/production/agents/sessions/t1?src=pr-comment) | — | 41m | $3.12 | opus-5 |",
    );
    expect(body).toContain("Fix auth \\| login flow");
    // The row must still be exactly one line — an unescaped newline would
    // split it into two, corrupting the table.
    expect(lines.filter((l) => l.includes("Fix auth")).length).toBe(1);
  });

  it("omits the whole-PR dashboard link when rows span multiple apps", () => {
    const rows = [
      row({ traceId: "t1", appName: "api" }),
      row({ traceId: "t2", appName: "worker" }),
    ];

    const body = renderComment(rows, new Map(), LINKS);

    expect(body).not.toContain("session dashboard");
  });

  it("every session link and the dashboard link carry a src query param", () => {
    const rows = [row({ traceId: "t1" })];

    const body = renderComment(rows, new Map(), LINKS);

    expect(body).toContain("?src=pr-comment");
    expect(body).toContain("&src=pr-comment");
  });

  // GitHub rejects issue-comment bodies over 65536 characters, and this
  // feature has no row cap by design — the renderer must fall back rather
  // than emit a body GitHub will reject.
  it("falls back to the header plus dashboard link when the body would exceed GitHub's comment limit", () => {
    const rows: LinkedSessionRow[] = Array.from({ length: 2000 }, (_, i) =>
      row({ traceId: `trace-${i}`, title: `Session number ${i} doing a lot of things` }),
    );

    const body = renderComment(rows, new Map(), LINKS);

    expect(body.length).toBeLessThanOrEqual(65536);
    expect(body).toContain("### Agent sessions behind this PR");
    expect(body).toContain("session dashboard");
    expect(body).not.toContain("| Session | Topics |");
  });
});
