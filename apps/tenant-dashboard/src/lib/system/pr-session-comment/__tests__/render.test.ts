/**
 * renderComment: pure markdown rendering for the PR session comment. No I/O
 * involved — every case here is plain objects in, a string out. This is
 * where most of `acceptance/057-pr-session-comment.md`'s criteria get
 * proven, because a pure function can prove them cheaply.
 */
import { describe, it, expect } from "vitest";

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

    expect(body).toBe(`No agent sessions linked yet.\n\n${PR_SESSION_COMMENT_MARKER}`);
  });

  // The marker is how a poster recognizes its own comment when the id was
  // never persisted (refresh.ts `findPostedComment`), so it has to be on
  // EVERY body — including the empty state, which is the very first thing
  // posted and therefore the most likely to be orphaned by a crash mid-post.
  it("carries the identity marker on every rendered body, invisibly", () => {
    const populated = renderComment([row({ traceId: "t1" })], new Map(), LINKS);

    expect(populated).toContain(PR_SESSION_COMMENT_MARKER);
    expect(renderComment([], new Map(), LINKS)).toContain(PR_SESSION_COMMENT_MARKER);
    // An HTML comment: GitHub renders it as nothing at all.
    expect(PR_SESSION_COMMENT_MARKER.startsWith("<!--")).toBe(true);
    expect(PR_SESSION_COMMENT_MARKER.endsWith("-->")).toBe(true);
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

  // AC-057-11: missing title renders "untitled session", and missing topics
  // AND unrecorded cost both render an em dash. CostUsd is non-nullable at
  // rest, so "unrecorded" and "genuinely zero" are indistinguishable in the
  // data — and of the two readings, the comment must not be the one that
  // asserts the work was free.
  it("renders untitled session and an em dash for missing topics and unrecorded cost", () => {
    const rows = [row({ traceId: "t1", title: "", costUsd: 0 })];

    const body = renderComment(rows, new Map(), LINKS);

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
    expect(body).not.toContain("$0.00");
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

  // The multi-app PR is the one most likely to have a lead asking "how did
  // this get built?", so it gets a doorway rather than none. The link can
  // only scope to one app/env (see the TODO in render.ts), so it points at
  // the first row's app.
  it("still renders the whole-PR dashboard link when rows span multiple apps", () => {
    const rows = [
      row({ traceId: "t1", appName: "api" }),
      row({ traceId: "t2", appName: "worker" }),
    ];

    const body = renderComment(rows, new Map(), LINKS);

    expect(body).toContain("session dashboard");
    expect(body).toContain("/apps/api/env/production/agents/sessions?pr=812");
  });

  it("every session link and the dashboard link carry a src query param", () => {
    const rows = [row({ traceId: "t1" })];

    const body = renderComment(rows, new Map(), LINKS);

    expect(body).toContain("?src=pr-comment");
    expect(body).toContain("&src=pr-comment");
  });

  // GitHub rejects issue-comment bodies over 65536 characters, and this
  // feature has no row cap by design — the renderer TRUNCATES rather than
  // emitting a body GitHub will reject. Dropping the table entirely (the
  // earlier behavior) left a reviewer with a cost total and no idea which
  // sessions produced it.
  it("truncates the table and names the remainder when the body would exceed GitHub's comment limit", () => {
    const rows: LinkedSessionRow[] = Array.from({ length: 2000 }, (_, i) =>
      row({ traceId: `trace-${i}`, title: `Session number ${i} doing a lot of things` }),
    );

    const body = renderComment(rows, new Map(), LINKS);
    const renderedRows = body.split("\n").filter((l) => l.startsWith("| [Session number"));

    expect(body.length).toBeLessThanOrEqual(65536);
    expect(body).toContain("### Agent sessions behind this PR");
    expect(body).toContain("session dashboard");
    // The table survives, with as many rows as fit...
    expect(body).toContain("| Session | Topics |");
    expect(renderedRows.length).toBeGreaterThan(100);
    expect(renderedRows.length).toBeLessThan(2000);
    // ...and the reader is told exactly how many they aren't seeing.
    expect(body).toContain(`_…and ${2000 - renderedRows.length} more sessions — see the dashboard._`);
  });

  it("header totals still cover every session, including truncated ones", () => {
    const rows: LinkedSessionRow[] = Array.from({ length: 2000 }, (_, i) =>
      row({ traceId: `trace-${i}`, title: `Session number ${i} doing a lot of things`, costUsd: 1 }),
    );

    const body = renderComment(rows, new Map(), LINKS);

    // Truncation is a display bound, never an accounting one.
    expect(body).toContain("2000 linked sessions");
    expect(body).toContain("$2000.00");
  });

  // Session titles are transcript-derived and topic labels are
  // tenant-authored: both are attacker-influenceable text rendered into a
  // world-readable comment on someone else's repository.
  it("a title containing markdown link syntax cannot break out of its link", () => {
    const rows = [
      row({ traceId: "t1", title: "fix auth](https://evil.example) and [more" }),
    ];

    const body = renderComment(rows, new Map(), LINKS);

    // The one link in the cell is ours, pointing at the dashboard.
    expect(body).not.toContain("(https://evil.example)");
    expect(body).toContain("\\]\\(https://evil.example\\)");
    expect(body).toContain("/agents/sessions/t1?src=pr-comment)");
  });

  it("topic labels are escaped the same way as titles", () => {
    const topics = new Map([["t1", ["fix](https://evil.example)", "a|b"]]]);
    const body = renderComment([row({ traceId: "t1" })], topics, LINKS);

    expect(body).not.toContain("(https://evil.example)");
    expect(body).toContain("a\\|b");
  });

  // Models reach us straight off transcript JSONL via the capture adapters,
  // sanitized at no hop. An unescaped `|` forges an extra column in a
  // world-readable comment on someone else's repository — the same class of
  // breakout the title and topic cells are escaped against.
  it("a model name containing a pipe cannot forge a table column", () => {
    const body = renderComment(
      [row({ traceId: "t1", models: ["x | $999.00 |", "opus-5"] })],
      new Map(),
      LINKS,
    );

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

    const body = renderComment(rows, new Map(), LINKS);

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

    const body = renderComment(rows, new Map(), LINKS);

    expect(body).not.toContain("/agents/sessions/a-oldest?src=pr-comment");
    expect(body.indexOf("/agents/sessions/b-middle")).toBeLessThan(
      body.indexOf("/agents/sessions/c-newest"),
    );
  });

  it("a title containing a raw HTML tag renders as text", () => {
    const body = renderComment([row({ traceId: "t1", title: "<img src=x>" })], new Map(), LINKS);

    expect(body).not.toContain("<img");
    expect(body).toContain("&lt;img src=x>");
  });

  // The header is read at a glance and its noun is the first thing that makes
  // it look machine-generated if it's wrong. One session is "1 linked
  // session", not "1 linked sessions".
  it("the header counts one session in the singular", () => {
    const body = renderComment([row({ traceId: "t1", costUsd: 1.5 })], new Map(), LINKS);

    expect(body).toContain("### Agent sessions behind this PR — 1 linked session · ");
    expect(body).not.toContain("1 linked sessions");
  });

  // A title that is only whitespace is not a title. Without the trim it
  // renders as a link whose visible label is blank — a clickable nothing in
  // the table's first column.
  it("a whitespace-only title falls back to the untitled label", () => {
    const body = renderComment([row({ traceId: "t1", title: "   \n  " })], new Map(), LINKS);

    expect(body).toContain("[untitled session](");
    expect(body).not.toMatch(/\|\s*\[\s+\]\(/);
  });

  // Models is a plain array with no not-captured sentinel, so an empty one
  // has to render as the same em dash an unrecorded cost uses (AC-057-11's
  // "never assert what wasn't captured"), not as an empty cell.
  it("a session with no recorded models renders an em dash, not an empty cell", () => {
    const body = renderComment([row({ traceId: "t1", models: [] })], new Map(), LINKS);

    const dataRow = body.split("\n").find((l) => l.startsWith("| ["))!;
    expect(dataRow.endsWith("| — |")).toBe(true);
  });

  // Timestamps come from ClickHouse and an unparseable one must not leak
  // "NaNm" into a world-readable comment. The guard has to reject the pair if
  // EITHER end is unparseable — one good endpoint doesn't rescue the
  // subtraction.
  it("an unparseable timestamp on either end renders 0m, never NaN", () => {
    const badEnd = renderComment(
      [row({ traceId: "t1", startedAt: "2026-07-10T09:00:00.000Z", endedAt: "not-a-date" })],
      new Map(),
      LINKS,
    );
    const badStart = renderComment(
      [row({ traceId: "t1", startedAt: "not-a-date", endedAt: "2026-07-10T09:41:00.000Z" })],
      new Map(),
      LINKS,
    );

    for (const body of [badEnd, badStart]) {
      expect(body).not.toContain("NaN");
      expect(body).toContain("| 0m |");
      // The header rollup sums the same helper, so it must be clean too.
      expect(body).toContain("— 1 linked session · 0m · ");
    }
  });

  // The overflow line is a truncation notice. A body where everything fits
  // must not carry one — "…and 0 more sessions" reads as a bug.
  it("says nothing about a remainder when every row fits", () => {
    const body = renderComment(
      [row({ traceId: "t1" }), row({ traceId: "t2" })],
      new Map(),
      LINKS,
    );

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

    const body = renderComment(rows, new Map(), LINKS);

    expect(body).toContain("_…and 1 more session — see the dashboard._");
    expect(body).not.toContain("1 more sessions");
    expect(body.length).toBeLessThanOrEqual(65536);
  });

  // The degenerate case: not even one row fits. The table header is dropped
  // with the rows it would have introduced, rather than left dangling above
  // nothing.
  it("drops the table header entirely when no row fits", () => {
    const body = renderComment([row({ traceId: "t1", title: "x".repeat(66000) })], new Map(), LINKS);

    expect(body).not.toContain("| Session | Topics |");
    expect(body).toContain("_…and 1 more session — see the dashboard._");
    expect(body).toContain("### Agent sessions behind this PR — 1 linked session");
    expect(body).toContain("session dashboard");
  });
});
