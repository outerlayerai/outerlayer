/**
 * renderComment: pure markdown rendering for the PR evidence comment. No I/O
 * involved — every case here is plain objects in, a string out. This is
 * where most of `acceptance/057-pr-session-comment.md`'s and
 * `acceptance/082-evidence-comment.md`'s criteria get proven, because a pure
 * function can prove them cheaply.
 */
import { describe, it, expect } from "vitest";

import { evaluateEvidence, type EvidenceEvaluation } from "../evaluate";
import { PR_SESSION_COMMENT_MARKER, renderComment, type RenderLinks } from "../render";
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
  agentType: "claude-code",
  recordedCommitShas: [],
  ...over,
});

/** The real evaluation for these rows — most cases have no commit list, so
 * no fact renders and the verdict is pass. */
function evalFor(
  rows: LinkedSessionRow[],
  over: { prCommitShas?: string[] | null; pendingLinkCount?: number } = {},
): EvidenceEvaluation {
  return evaluateEvidence({
    sessions: rows,
    pendingLinkCount: over.pendingLinkCount ?? 0,
    prCommitShas: over.prCommitShas ?? null,
  });
}

/** Shorthand for the common no-facts render. */
function render(rows: LinkedSessionRow[], topics = new Map<string, string[]>(), links = LINKS) {
  return renderComment(rows, topics, links, evalFor(rows));
}

describe("renderComment", () => {
  // AC-082-01: the comment OPENS with the verdict, and the pass copy is the
  // design's, verbatim.
  it("opens with the pass verdict line when every displayed fact passes", () => {
    const rows = [row({ traceId: "t1", recordedCommitShas: ["1a2b3c4d"] })];
    const body = renderComment(
      rows,
      new Map(),
      LINKS,
      evalFor(rows, { prCommitShas: ["1a2b3c4d5e6f7a8b9c0d1a2b3c4d5e6f7a8b9c0d"] }),
    );

    expect(body.startsWith("**✅ Everything checks out — a quick review should be enough**")).toBe(
      true,
    );
  });

  // AC-082-01: a flagged fact flips the verdict to the amber copy, counting
  // the flagged facts.
  it("opens with the amber verdict when a fact is flagged, counting one thing in the singular", () => {
    const rows = [row({ traceId: "t1", recordedCommitShas: [] })];
    const body = renderComment(
      rows,
      new Map(),
      LINKS,
      evalFor(rows, { prCommitShas: ["1a2b3c4d5e6f7a8b9c0d1a2b3c4d5e6f7a8b9c0d"] }),
    );

    expect(body.startsWith("**⚠️ Look at 1 thing before merging**")).toBe(true);
    expect(body).not.toContain("Everything checks out");
  });

  // AC-082-01: the plural copy is the design's verbatim "Look at {N} things".
  // Two flagged facts can't be produced by this slice's evaluator (commit
  // provenance is the only fact), so the plural line is proven against a
  // hand-built evaluation — the renderer's copy must already be right for
  // the first two-fact slice.
  it("renders the plural amber copy for more than one flagged fact", () => {
    const rows = [row({ traceId: "t1" })];
    const evaluation: EvidenceEvaluation = {
      verdict: "flag",
      facts: [],
      flaggedCount: 2,
      pendingLinkCount: 0,
    };

    const body = renderComment(rows, new Map(), LINKS, evaluation);

    expect(body).toContain("**⚠️ Look at 2 things before merging**");
  });

  // AC-082-01: the red copy exists and is verbatim — unreachable from this
  // slice's evaluator (no red-class fact exists), so it is proven against a
  // hand-built evaluation.
  it("renders the red verdict copy for an unverifiable evaluation", () => {
    const rows = [row({ traceId: "t1" })];
    const evaluation: EvidenceEvaluation = {
      verdict: "unverifiable",
      facts: [],
      flaggedCount: 1,
      pendingLinkCount: 0,
    };

    const body = renderComment(rows, new Map(), LINKS, evaluation);

    expect(body).toContain("**❌ We can't verify this PR — review it fully**");
  });

  // AC-082-02: the provenance fact is stated in the design's copy —
  // "{k} of {n} commits came from recorded sessions" — and a passing fact
  // carries a check, not a warning.
  it("states the provenance fact with k of n copy when all commits are recorded", () => {
    const rows = [row({ traceId: "t1", recordedCommitShas: ["1a2b3c4", "9f8e7d6"] })];
    const body = renderComment(
      rows,
      new Map(),
      LINKS,
      evalFor(rows, {
        prCommitShas: [
          "1a2b3c4d5e6f7a8b9c0d1a2b3c4d5e6f7a8b9c0d",
          "9f8e7d6c5b4a3f2e1d0c9f8e7d6c5b4a3f2e1d0c",
        ],
      }),
    );

    expect(body).toContain("✓ **2 of 2 commits came from recorded sessions**");
    expect(body).not.toContain("unrecorded:");
  });

  // AC-082-02: unrecorded commits flag the fact amber and are NAMED — the
  // reviewer learns exactly which commits have no recorded session.
  it("flags and names the unrecorded commits by short sha", () => {
    const rows = [row({ traceId: "t1", recordedCommitShas: ["1a2b3c4d"] })];
    const body = renderComment(
      rows,
      new Map(),
      LINKS,
      evalFor(rows, {
        prCommitShas: [
          "1a2b3c4d5e6f7a8b9c0d1a2b3c4d5e6f7a8b9c0d",
          "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
        ],
      }),
    );

    expect(body).toContain("⚠ **1 of 2 commits came from recorded sessions** — unrecorded: `deadbee`");
    expect(body).toContain("**⚠️ Look at 1 thing before merging**");
  });

  it("caps the named unrecorded commits and counts the remainder", () => {
    const rows = [row({ traceId: "t1", recordedCommitShas: [] })];
    const shas = Array.from({ length: 14 }, (_, i) =>
      `${i.toString(16).padStart(2, "0")}`.repeat(20),
    );
    const body = renderComment(rows, new Map(), LINKS, evalFor(rows, { prCommitShas: shas }));

    expect(body).toContain("…and 4 more");
    // Ten named, not fourteen.
    expect(body.match(/`[0-9a-f]{7}`/g)).toHaveLength(10);
  });

  // AC-082-03: the design's layout order — verdict line, then the aggregated
  // metadata line, then the facts, then the per-session detail table, with
  // each session's deep link still reachable.
  it("lays the comment out as verdict, metadata, facts, then the session table", () => {
    const rows = [
      row({ traceId: "t1", recordedCommitShas: ["1a2b3c4d"] }),
      row({
        traceId: "t2",
        title: "Retry loop on auth.ts",
        startedAt: "2026-07-10T10:00:00.000Z",
        endedAt: "2026-07-10T11:12:00.000Z",
        costUsd: 11.87,
        models: ["opus-5", "haiku-4.5"],
      }),
    ];
    const body = renderComment(
      rows,
      new Map(),
      LINKS,
      evalFor(rows, { prCommitShas: ["1a2b3c4d5e6f7a8b9c0d1a2b3c4d5e6f7a8b9c0d"] }),
    );

    const verdictAt = body.indexOf("Everything checks out");
    const metadataAt = body.indexOf("2 sessions · Claude Code ×2");
    const factAt = body.indexOf("1 of 1 commits came from recorded sessions");
    const tableAt = body.indexOf("| Session | Topics | Duration | Cost | Models |");
    expect(verdictAt).toBeGreaterThanOrEqual(0);
    expect(metadataAt).toBeGreaterThan(verdictAt);
    expect(factAt).toBeGreaterThan(metadataAt);
    expect(tableAt).toBeGreaterThan(factAt);
    // Per-session deep links are still reachable from the table.
    expect(body).toContain(
      "[Fix flaky auth test](https://app.outerlayer.example/orgs/acme/apps/api/env/production/agents/sessions/t1?src=pr-comment)",
    );
    expect(body).toContain("/agents/sessions/t2?src=pr-comment");
  });

  // AC-082-03 + AC-057-01: the metadata line aggregates — session count
  // (when >1), agent breakdown, summed duration and cost — labeled as sums
  // over linked sessions, with the dashboard doorway in the footer.
  it("aggregates count, agents, duration, and cost on the metadata line for several sessions", () => {
    const rows: LinkedSessionRow[] = [
      row({
        traceId: "t1",
        title: "Fix flaky auth test",
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

    const body = renderComment(rows, topics, LINKS, evalFor(rows));

    expect(body).toContain("2 sessions · Claude Code ×2 · 1h 53m · $14.99");
    expect(body).toContain("_Totals are sums over linked sessions._");
    expect(body).not.toMatch(/per-PR/i);
    expect(body).toContain("| Session | Topics | Duration | Cost | Models |");
    expect(body).toContain("41m");
    expect(body).toContain("$3.12");
    expect(body).toContain("1h 12m");
    expect(body).toContain("$11.87");
    expect(body).toContain("opus-5, haiku-4.5");
    expect(body).toContain("flaky tests");
    expect(body).toContain("⚠ provider errors");
    expect(body).toContain(
      "[session dashboard](https://app.outerlayer.example/orgs/acme/apps/api/env/production/agents/sessions?pr=812&src=pr-comment)",
    );
  });

  it("a single session's metadata line names its agent and links the session, with no count", () => {
    const body = render([row({ traceId: "t1" })]);

    expect(body).toContain(
      "Claude Code · 41m · $3.12 · [open session](https://app.outerlayer.example/orgs/acme/apps/api/env/production/agents/sessions/t1?src=pr-comment)",
    );
    expect(body).not.toContain("1 sessions");
    expect(body).not.toContain("_Totals are sums over linked sessions._");
  });

  it("an unknown agent id renders escaped rather than resolved, and an empty one as unknown agent", () => {
    const known = render([row({ traceId: "t1", agentType: "claude-code" })]);
    const unknown = render([row({ traceId: "t1", agentType: "my|agent" })]);
    const empty = render([row({ traceId: "t1", agentType: "" })]);

    expect(known).toContain("Claude Code");
    expect(unknown).toContain("my\\|agent");
    expect(empty).toContain("unknown agent");
  });

  // AC-082-05: candidate links exist but none has confirmed — the comment
  // shows the waiting copy instead of judging on no evidence.
  it("renders the waiting body when links are pending and nothing is confirmed", () => {
    const body = renderComment([], new Map(), LINKS, evalFor([], { pendingLinkCount: 1 }));

    expect(body).toBe(
      `**⏳ Waiting for session evidence** — 1 session link is pending confirmation. This comment updates when the session syncs.\n\n${PR_SESSION_COMMENT_MARKER}`,
    );
    expect(body).toMatch(/waiting for session evidence/i);
  });

  it("counts several pending links in the plural on the waiting body", () => {
    const body = renderComment([], new Map(), LINKS, evalFor([], { pendingLinkCount: 3 }));

    expect(body).toContain("3 session links are pending confirmation");
  });

  // AC-082-07: unchanged inputs render a byte-identical body — no clock, no
  // randomness, no ordering drift anywhere in the pipeline.
  it("renders a byte-identical body for unchanged inputs", () => {
    const rows = [
      row({ traceId: "t1", recordedCommitShas: ["1a2b3c4d"] }),
      row({ traceId: "t2", title: "Retry loop on auth.ts", agentType: "codex" }),
    ];
    const topics = new Map<string, string[]>([["t1", ["flaky tests"]]]);
    const prCommitShas = [
      "1a2b3c4d5e6f7a8b9c0d1a2b3c4d5e6f7a8b9c0d",
      "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
    ];

    const first = renderComment(rows, topics, LINKS, evalFor(rows, { prCommitShas }));
    const second = renderComment(rows, topics, LINKS, evalFor(rows, { prCommitShas }));

    expect(second).toBe(first);
  });

  // AC-082-04: the marker is how a poster recognizes its own comment when
  // the id was never persisted (refresh.ts `findPostedComment`), so it has
  // to be on EVERY body — including the waiting state, which is the very
  // first thing posted and therefore the most likely to be orphaned by a
  // crash mid-post.
  it("carries the identity marker on every rendered body, invisibly", () => {
    const populated = render([row({ traceId: "t1" })]);
    const waiting = renderComment([], new Map(), LINKS, evalFor([], { pendingLinkCount: 1 }));

    expect(populated).toContain(PR_SESSION_COMMENT_MARKER);
    expect(waiting).toContain(PR_SESSION_COMMENT_MARKER);
    // An HTML comment: GitHub renders it as nothing at all.
    expect(PR_SESSION_COMMENT_MARKER.startsWith("<!--")).toBe(true);
    expect(PR_SESSION_COMMENT_MARKER.endsWith("-->")).toBe(true);
  });

  // AC-057-05 + AC-082-04: a branch-inferred link is visibly marked, never
  // presented as certain — re-asserted against the new renderer.
  it("marks method='branch' rows as inferred", () => {
    const body = render([row({ traceId: "t1", method: "branch" })]);

    expect(body).toContain("_(inferred)_");
  });

  it("does not mark method='pr_link' rows as inferred", () => {
    const body = render([row({ traceId: "t1", method: "pr_link" })]);

    expect(body).not.toContain("_(inferred)_");
  });

  // AC-057-06: provider errors and error storms gate the trouble marker;
  // stuck-edit-loop badging is explicitly out of scope for this rollup row.
  it("badges a row with provider errors", () => {
    const body = render([row({ traceId: "t1", apiErrorCount: 1, errorCount: 0 })]);

    expect(body).toContain("⚠ provider errors");
  });

  it("badges a row whose error count exceeds the error-storm threshold", () => {
    const body = render([row({ traceId: "t1", apiErrorCount: 0, errorCount: 11 })]);

    expect(body).toContain("⚠ error storm");
  });

  it("does not badge a row with a small, non-storm error count and no provider errors", () => {
    const body = render([row({ traceId: "t1", apiErrorCount: 0, errorCount: 3 })]);

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

    const body = renderComment(rows, topics, LINKS, evalFor(rows));

    expect(body).toContain("flaky tests, auth");
    expect(body).not.toContain("Summary");
  });

  // AC-057-08 + AC-082-04: a reader without dashboard access sees topics,
  // durations, costs, and deep links — never a human name, actor field, or
  // transcript content. Simulate a hypothetically "leaky" upstream row
  // (extra actor-shaped fields no LinkedSessionRow actually carries) and
  // assert none of it surfaces, as a structural regression guard —
  // re-asserted against the new renderer, evaluation included.
  it("never renders human names, actor/author/profile fields, or transcript content", () => {
    const leakyRow = {
      ...row({ traceId: "t1", title: "Fix flaky auth test", recordedCommitShas: ["1a2b3c4d"] }),
      actorName: "Jane Doe",
      authorEmail: "jane@example.com",
      profileHandle: "@janedoe",
      transcriptSummary: "The user asked the agent to fix the flaky test by retrying auth.ts",
    } as unknown as LinkedSessionRow;

    const body = renderComment(
      [leakyRow],
      new Map(),
      LINKS,
      evalFor([leakyRow], { prCommitShas: ["deadbeefdeadbeefdeadbeefdeadbeefdeadbeef"] }),
    );

    expect(body).not.toContain("Jane Doe");
    expect(body).not.toContain("jane@example.com");
    expect(body).not.toContain("@janedoe");
    expect(body).not.toContain("The user asked the agent");
    expect(body).not.toMatch(/actor/i);
    expect(body).not.toMatch(/author/i);
    expect(body).not.toMatch(/profile/i);
  });

  // AC-057-11: missing title renders "untitled session", and missing topics
  // AND unrecorded cost both render an em dash. CostUsd is non-nullable at
  // rest, so "unrecorded" and "genuinely zero" are indistinguishable in the
  // data — and of the two readings, the comment must not be the one that
  // asserts the work was free.
  it("renders untitled session and an em dash for missing topics and unrecorded cost", () => {
    const body = render([row({ traceId: "t1", title: "", costUsd: 0 })]);

    expect(body).toContain("[untitled session]");
    // Positional, not a bare `toContain("| — |")`: two DIFFERENT cells are
    // supposed to be em dashes here (topics and cost), and a single
    // substring check passes when only one of them is.
    const cells = body
      .split("\n")
      .find((l) => l.startsWith("| ["))!
      .split(" | ");
    expect(cells[1]).toBe("—"); // topics
    expect(cells[3]).toBe("—"); // cost — never "$0.00"
    expect(body).not.toContain("$0.00");
  });

  it("escapes a title containing a pipe or newline so it cannot break the table", () => {
    const body = render([row({ traceId: "t1", title: "Fix auth | login\nflow" })]);
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

  // The multi-app PR is the one most likely to have a lead asking "how did
  // this get built?", so it gets a doorway rather than none. The link can
  // only scope to one app/env (see the TODO in render.ts), so it points at
  // the first row's app.
  it("still renders the whole-PR dashboard link when rows span multiple apps", () => {
    const body = render([
      row({ traceId: "t1", appName: "api" }),
      row({ traceId: "t2", appName: "worker" }),
    ]);

    expect(body).toContain("session dashboard");
    expect(body).toContain("/apps/api/env/production/agents/sessions?pr=812");
  });

  it("every session link and the dashboard link carry a src query param", () => {
    const body = render([row({ traceId: "t1" }), row({ traceId: "t2" })]);

    expect(body).toContain("?src=pr-comment");
    expect(body).toContain("&src=pr-comment");
  });

  // AC-082-04: GitHub rejects issue-comment bodies over 65536 characters,
  // and this feature has no row cap by design — the renderer TRUNCATES
  // rather than emitting a body GitHub will reject. Re-asserted against the
  // new layout: the verdict and metadata survive, the table keeps as many
  // rows as fit, and the remainder is named.
  it("truncates the table and names the remainder when the body would exceed GitHub's comment limit", () => {
    const rows: LinkedSessionRow[] = Array.from({ length: 2000 }, (_, i) =>
      row({ traceId: `trace-${i}`, title: `Session number ${i} doing a lot of things` }),
    );

    const body = render(rows);
    const renderedRows = body.split("\n").filter((l) => l.startsWith("| [Session number"));

    expect(body.length).toBeLessThanOrEqual(65536);
    expect(body).toContain("Everything checks out");
    expect(body).toContain("session dashboard");
    // The table survives, with as many rows as fit...
    expect(body).toContain("| Session | Topics |");
    expect(renderedRows.length).toBeGreaterThan(100);
    expect(renderedRows.length).toBeLessThan(2000);
    // ...and the reader is told exactly how many they aren't seeing.
    expect(body).toContain(`_…and ${2000 - renderedRows.length} more sessions — see the dashboard._`);
  });

  it("metadata totals still cover every session, including truncated ones", () => {
    const rows: LinkedSessionRow[] = Array.from({ length: 2000 }, (_, i) =>
      row({ traceId: `trace-${i}`, title: `Session number ${i} doing a lot of things`, costUsd: 1 }),
    );

    const body = render(rows);

    // Truncation is a display bound, never an accounting one.
    expect(body).toContain("2000 sessions");
    expect(body).toContain("$2000.00");
  });

  // Session titles are transcript-derived and topic labels are
  // tenant-authored: both are attacker-influenceable text rendered into a
  // world-readable comment on someone else's repository.
  it("a title containing markdown link syntax cannot break out of its link", () => {
    const body = render([row({ traceId: "t1", title: "fix auth](https://evil.example) and [more" })]);

    // The one link in the cell is ours, pointing at the dashboard.
    expect(body).not.toContain("(https://evil.example)");
    expect(body).toContain("\\]\\(https://evil.example\\)");
    expect(body).toContain("/agents/sessions/t1?src=pr-comment)");
  });

  it("topic labels are escaped the same way as titles", () => {
    const topics = new Map([["t1", ["fix](https://evil.example)", "a|b"]]]);
    const rows = [row({ traceId: "t1" })];
    const body = renderComment(rows, topics, LINKS, evalFor(rows));

    expect(body).not.toContain("(https://evil.example)");
    expect(body).toContain("a\\|b");
  });

  // Models reach us straight off transcript JSONL via the capture adapters,
  // sanitized at no hop. An unescaped `|` forges an extra column in a
  // world-readable comment on someone else's repository — the same class of
  // breakout the title and topic cells are escaped against.
  it("a model name containing a pipe cannot forge a table column", () => {
    const body = render([row({ traceId: "t1", models: ["x | $999.00 |", "opus-5"] })]);

    const dataRow = body.split("\n").find((l) => l.startsWith("| ["))!;
    // Exactly the five cells the table declares — the forged ones didn't land.
    expect(dataRow.split(" | ")).toHaveLength(5);
    expect(dataRow).toContain("x \\| $999.00 \\|, opus-5");
  });

  // Truncation drops the OLDEST rows, never the newest. The newest session is
  // the one whose sync triggered this refresh, so dropping it makes the
  // comment look broken to the person who just caused it to be written.
  it("keeps the newest sessions when the table has to be truncated", () => {
    // Oldest-first, as readLinkedSessions returns them. Only a couple fit.
    const rows: LinkedSessionRow[] = [
      row({ traceId: "oldest", title: "x".repeat(35000), startedAt: "2026-07-01T09:00:00.000Z" }),
      row({ traceId: "middle", title: "y".repeat(35000), startedAt: "2026-07-02T09:00:00.000Z" }),
      row({ traceId: "newest", title: "the session that just synced", startedAt: "2026-07-03T09:00:00.000Z" }),
    ];

    const body = render(rows);

    expect(body.length).toBeLessThanOrEqual(65536);
    expect(body).toContain("the session that just synced");
    expect(body).toContain("/agents/sessions/newest?src=pr-comment");
    // The oldest is what gave way.
    expect(body).not.toContain("/agents/sessions/oldest?src=pr-comment");
    expect(body).toContain("_…and 1 more session — see the dashboard._");
  });

  // Truncating must not also reorder: the kept rows still read oldest-first,
  // which is the whole reason the read layer sorts that way.
  it("kept rows stay in oldest-first order after truncation", () => {
    const rows: LinkedSessionRow[] = [
      row({ traceId: "a-oldest", title: "z".repeat(65000), startedAt: "2026-07-01T09:00:00.000Z" }),
      row({ traceId: "b-middle", title: "middle session", startedAt: "2026-07-02T09:00:00.000Z" }),
      row({ traceId: "c-newest", title: "newest session", startedAt: "2026-07-03T09:00:00.000Z" }),
    ];

    const body = render(rows);

    expect(body).not.toContain("/agents/sessions/a-oldest?src=pr-comment");
    expect(body.indexOf("/agents/sessions/b-middle")).toBeLessThan(
      body.indexOf("/agents/sessions/c-newest"),
    );
  });

  it("a title containing a raw HTML tag renders as text", () => {
    const body = render([row({ traceId: "t1", title: "<img src=x>" })]);

    expect(body).not.toContain("<img");
    expect(body).toContain("&lt;img src=x>");
  });

  // A title that is only whitespace is not a title. Without the trim it
  // renders as a link whose visible label is blank — a clickable nothing in
  // the table's first column.
  it("a whitespace-only title falls back to the untitled label", () => {
    const body = render([row({ traceId: "t1", title: "   \n  " })]);

    expect(body).toContain("[untitled session](");
    expect(body).not.toMatch(/\|\s*\[\s+\]\(/);
  });

  // Models is a plain array with no not-captured sentinel, so an empty one
  // has to render as the same em dash an unrecorded cost uses (AC-057-11's
  // "never assert what wasn't captured"), not as an empty cell.
  it("a session with no recorded models renders an em dash, not an empty cell", () => {
    const body = render([row({ traceId: "t1", models: [] })]);

    const dataRow = body.split("\n").find((l) => l.startsWith("| ["))!;
    expect(dataRow.endsWith("| — |")).toBe(true);
  });

  // Timestamps come from ClickHouse and an unparseable one must not leak
  // "NaNm" into a world-readable comment. The guard has to reject the pair if
  // EITHER end is unparseable — one good endpoint doesn't rescue the
  // subtraction.
  it("an unparseable timestamp on either end renders 0m, never NaN", () => {
    const badEnd = render([
      row({ traceId: "t1", startedAt: "2026-07-10T09:00:00.000Z", endedAt: "not-a-date" }),
    ]);
    const badStart = render([
      row({ traceId: "t1", startedAt: "not-a-date", endedAt: "2026-07-10T09:41:00.000Z" }),
    ]);

    for (const body of [badEnd, badStart]) {
      expect(body).not.toContain("NaN");
      expect(body).toContain("| 0m |");
      // The metadata rollup sums the same helper, so it must be clean too.
      expect(body).toContain("Claude Code · 0m · ");
    }
  });

  // The overflow line is a truncation notice. A body where everything fits
  // must not carry one — "…and 0 more sessions" reads as a bug.
  it("says nothing about a remainder when every row fits", () => {
    const body = render([row({ traceId: "t1" }), row({ traceId: "t2" })]);

    expect(body).not.toContain("…and");
    expect(body).not.toContain("see the dashboard._");
  });

  // The remainder line is prose in the comment, so it agrees with itself when
  // exactly one session was dropped.
  it("names a single omitted session in the singular", () => {
    // Two rows, the first big enough that only it fits: the second is the
    // lone remainder.
    const rows: LinkedSessionRow[] = [
      row({ traceId: "t1", title: "x".repeat(65000) }),
      row({ traceId: "t2" }),
    ];

    const body = render(rows);

    expect(body).toContain("_…and 1 more session — see the dashboard._");
    expect(body).not.toContain("1 more sessions");
    expect(body.length).toBeLessThanOrEqual(65536);
  });

  // The degenerate case: not even one row fits. The table header is dropped
  // with the rows it would have introduced, rather than left dangling above
  // nothing — the verdict and metadata still render.
  it("drops the table header entirely when no row fits", () => {
    const body = render([row({ traceId: "t1", title: "x".repeat(66000) })]);

    expect(body).not.toContain("| Session | Topics |");
    expect(body).toContain("_…and 1 more session — see the dashboard._");
    expect(body).toContain("Everything checks out");
    expect(body).toContain("Claude Code · 41m · $3.12");
    expect(body).toContain("session dashboard");
  });
});

describe("verification fact rows", () => {
  const base = (over: Partial<EvidenceEvaluation> = {}): EvidenceEvaluation => ({
    verdict: "pass",
    facts: [],
    flaggedCount: 0,
    pendingLinkCount: 0,
    ...over,
  });
  const rows = [row({ traceId: "t1" })];

  // AC-083-11
  it("renders a passing verification fact as a ✓ row with its turn range", () => {
    const body = renderComment(
      rows,
      new Map(),
      LINKS,
      base({
        facts: [
          {
            id: "red-then-green",
            status: "pass",
            class: "amber",
            sentence: "New tests failed first, then passed",
            refs: [
              { traceId: "t1", turnIndex: 61 },
              { traceId: "t1", turnIndex: 63 },
            ],
          },
        ],
      }),
    );

    expect(body).toContain("✓ **New tests failed first, then passed** — turns 61 → 63");
  });

  it("renders an amber flag as ⚠ and a single ref as one turn", () => {
    const body = renderComment(
      rows,
      new Map(),
      LINKS,
      base({
        verdict: "flag",
        flaggedCount: 1,
        facts: [
          {
            id: "no-test-tampering",
            status: "flag",
            class: "amber",
            sentence: "A failing test was made to pass by changing the test, not the code",
            refs: [{ traceId: "t1", turnIndex: 48 }],
          },
        ],
      }),
    );

    expect(body).toContain(
      "⚠ **A failing test was made to pass by changing the test, not the code** — turn 48",
    );
  });

  // AC-083-12: the red-class row carries ✕, distinct from amber's ⚠ — the
  // one mark reserved for facts that void the verdict.
  it("renders a red-class flag as ✕ and omits the suffix when refs carry no turns", () => {
    const body = renderComment(
      rows,
      new Map(),
      LINKS,
      base({
        verdict: "unverifiable",
        flaggedCount: 1,
        facts: [
          {
            id: "no-test-tampering",
            status: "flag",
            class: "red",
            sentence: "A git command skipped the repo's checks",
            refs: [{ traceId: "t1", turnIndex: null }],
          },
        ],
      }),
    );

    expect(body).toContain("✕ **A git command skipped the repo's checks**");
    expect(body).not.toContain("A git command skipped the repo's checks** — turn");
  });
});

describe("policy fact rows", () => {
  const rows = [row({ traceId: "t1" })];
  const withFacts = (facts: EvidenceEvaluation["facts"], flagged = 0): EvidenceEvaluation => ({
    verdict: flagged > 0 ? "flag" : "pass",
    facts,
    flaggedCount: flagged,
    pendingLinkCount: 0,
  });

  // AC-085-03
  it("renders a passing custom row with its proof turn", () => {
    const body = renderComment(
      rows,
      new Map(),
      LINKS,
      withFacts([
        {
          id: "custom",
          validatorId: "migration-must-run",
          status: "pass",
          class: "amber",
          sentence: "The migration was actually run",
          refs: [{ traceId: "t1", turnIndex: 12 }],
        },
      ]),
    );
    expect(body).toContain("✓ **The migration was actually run** — turn 12");
  });

  // AC-085-04
  it("renders a flagged custom row with the not-proven copy, never ✕", () => {
    const body = renderComment(
      rows,
      new Map(),
      LINKS,
      withFacts(
        [
          {
            id: "custom",
            validatorId: "migration-must-run",
            status: "flag",
            class: "amber",
            sentence: "The migration was actually run — not proven",
            refs: [],
          },
        ],
        1,
      ),
    );
    expect(body).toContain("⚠ **The migration was actually run — not proven**");
    expect(body).not.toContain("✕");
  });

  // AC-085-07
  it("renders the policy error naming the file and the problem", () => {
    const body = renderComment(
      rows,
      new Map(),
      LINKS,
      withFacts(
        [
          {
            id: "policy-error",
            status: "flag",
            class: "amber",
            message: "`.outerlayer/policy.yaml` — unknown preset (and 2 more)",
          },
        ],
        1,
      ),
    );
    expect(body).toContain(
      "⚠ **The policy file has an error** — `.outerlayer/policy.yaml` — unknown preset (and 2 more)",
    );
  });
});
