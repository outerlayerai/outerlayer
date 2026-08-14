/**
 * The Evidence block of the PR comment: artifacts as links, criterion proof
 * rows, escaping, and byte-identical re-rendering. Pure function in, string
 * out — most of `acceptance/082-artifacts.md`'s rendering criteria are
 * proven here.
 */
import { describe, it, expect } from "vitest";

import { renderComment, type RenderLinks, type RenderEvidence } from "../render";
import type { EvidenceEvaluation } from "../evaluate";
import type { LinkedSessionRow } from "../read";
import type { PrArtifactRow } from "../artifacts-read";

const LINKS: RenderLinks = {
  baseUrl: "https://app.outerlayer.example",
  orgName: "acme",
  prNumber: 61,
};

const PASS_EVAL: EvidenceEvaluation = {
  verdict: "pass",
  facts: [],
  flaggedCount: 0,
  pendingLinkCount: 0,
};

const sessionRow = (traceId: string): LinkedSessionRow => ({
  traceId,
  sessionId: `s-${traceId}`,
  appId: "app-1",
  appName: "api",
  envName: "production",
  agentType: "claude-code",
  recordedCommitShas: [],
  method: "pr_link",
  title: "Fix flaky auth test",
  startedAt: "2026-07-10T09:00:00.000Z",
  endedAt: "2026-07-10T09:41:00.000Z",
  costUsd: 3.12,
  models: ["opus-5"],
  apiErrorCount: 0,
  errorCount: 0,
});

const artifact = (
  over: Partial<PrArtifactRow> & Pick<PrArtifactRow, "id" | "filename" | "kind">,
): PrArtifactRow => ({
  caption: "",
  criterionId: "",
  provenance: "session",
  emittedAt: "2026-07-10T09:30:00.000Z",
  appName: "api",
  envName: "production",
  ...over,
});

describe("renderComment — evidence", () => {
  // proves AC-084-11
  it("renders artifacts as links with kind, name, caption, provenance labels, and a counted summary line", () => {
    const evidence: RenderEvidence = {
      criteria: [],
      artifacts: [
        artifact({
          id: "a1",
          filename: "allowlist-settings.png",
          kind: "screenshot",
          caption: "Allowlist settings after save",
          emittedAt: "2026-07-10T09:10:00.000Z",
        }),
        artifact({
          id: "a2",
          filename: "signup-blocked.webm",
          kind: "video",
          caption: "e2e run",
          provenance: "ci",
          emittedAt: "2026-07-10T09:20:00.000Z",
        }),
        artifact({
          id: "a3",
          filename: "notes.txt",
          kind: "log",
          provenance: "local",
          emittedAt: "2026-07-10T09:25:00.000Z",
        }),
      ],
    };

    const body = renderComment([sessionRow("t1")], new Map(), LINKS, PASS_EVAL, evidence);

    expect(body).toContain("**Evidence** · 3 artifacts");
    expect(body).toContain(
      "| [screenshot · allowlist-settings.png](https://app.outerlayer.example/orgs/acme/apps/api/env/production/agents/artifacts/a1?src=pr-comment) | Allowlist settings after save |",
    );
    // Non-session provenance is labeled; session provenance is not.
    expect(body).toContain(
      "| [video · signup-blocked.webm](https://app.outerlayer.example/orgs/acme/apps/api/env/production/agents/artifacts/a2?src=pr-comment) `ci` | e2e run |",
    );
    expect(body).toContain("`local`");
    expect(body).not.toContain("`session`");
    // An empty caption renders as an em dash, never an empty cell.
    expect(body).toContain("| [log · notes.txt](");
    expect(body).toContain(") `local` | — |");
  });

  // proves AC-084-12
  it("renders no Artifacts subgroup and no count when the PR has no artifacts", () => {
    const withoutEvidence = renderComment([sessionRow("t1")], new Map(), LINKS, PASS_EVAL);
    const withEmptyEvidence = renderComment([sessionRow("t1")], new Map(), LINKS, PASS_EVAL, {
      artifacts: [],
      criteria: [],
    });

    for (const body of [withoutEvidence, withEmptyEvidence]) {
      expect(body).not.toContain("**Artifacts**");
      expect(body).not.toContain("artifact");
      expect(body).not.toContain("**Evidence**");
    }
    expect(withEmptyEvidence).toBe(withoutEvidence);
  });

  // proves AC-084-13
  it("renders links only — image kinds never render inline media markup", () => {
    const body = renderComment([], new Map(), LINKS, PASS_EVAL, {
      criteria: [],
      artifacts: [
        artifact({ id: "a1", filename: "shot.png", kind: "screenshot" }),
        artifact({ id: "a2", filename: "run.webm", kind: "video" }),
      ],
    });

    expect(body).not.toContain("![");
    expect(body).not.toContain("<img");
    expect(body).not.toContain("<video");
    expect(body).toContain("[screenshot · shot.png](");
  });

  // proves AC-084-14
  it("renders a kind-matching bound artifact as the criterion's proof link", () => {
    const body = renderComment([sessionRow("t1")], new Map(), LINKS, PASS_EVAL, {
      criteria: [{ id: "AC-084-11", proofKind: "screenshot" }],
      artifacts: [
        artifact({
          id: "a1",
          filename: "evidence.png",
          kind: "screenshot",
          criterionId: "AC-084-11",
          caption: "Comment with artifacts rendered",
        }),
      ],
    });

    expect(body).toContain("| Criterion | Proof |");
    expect(body).toContain(
      "| `AC-084-11` | [screenshot · evidence.png](https://app.outerlayer.example/orgs/acme/apps/api/env/production/agents/artifacts/a1?src=pr-comment) |",
    );
  });

  // proves AC-084-15
  it("never upgrades the wrong kind: mismatches and absences render as unmet requirements", () => {
    const body = renderComment([sessionRow("t1")], new Map(), LINKS, PASS_EVAL, {
      criteria: [
        { id: "REQ-video-a", proofKind: "video" },
        { id: "REQ-video-b", proofKind: "video" },
      ],
      artifacts: [
        artifact({
          id: "a1",
          filename: "still.png",
          kind: "screenshot",
          criterionId: "REQ-video-a",
        }),
      ],
    });

    expect(body).toContain("| `REQ-video-a` | video required · screenshot attached |");
    expect(body).toContain("| `REQ-video-b` | video required · none attached |");
    // Neither criterion row carries a proof link.
    const criterionRows = body
      .split("\n")
      .filter((line) => line.startsWith("| `REQ-video-"));
    expect(criterionRows).toHaveLength(2);
    for (const line of criterionRows) {
      expect(line).not.toContain("](");
    }
  });

  // proves AC-084-16
  it("escapes captions so they cannot break rows, links, or inject markup, and never renders actor-shaped fields", () => {
    const hostile = {
      ...artifact({
        id: "a1",
        filename: "shot.png",
        kind: "screenshot",
        caption: "pwn](https://evil.example) | $99 <img src=x onerror=alert(1)>",
      }),
      actorName: "Jane Doe",
      authorEmail: "jane@example.com",
      transcriptSummary: "the user asked about secrets",
    } as unknown as PrArtifactRow;

    const body = renderComment([sessionRow("t1")], new Map(), LINKS, PASS_EVAL, {
      criteria: [],
      artifacts: [hostile],
    });

    expect(body).not.toContain("(https://evil.example)");
    expect(body).not.toContain("<img");
    // The caption's forged pipe is escaped: the artifact row still splits
    // into exactly two content cells.
    const artifactRow = body.split("\n").find((line) => line.includes("shot.png"))!;
    expect(artifactRow.split(" | ")).toHaveLength(2);
    expect(body).not.toContain("Jane Doe");
    expect(body).not.toContain("jane@example.com");
    expect(body).not.toContain("the user asked about secrets");
  });

  // proves AC-084-17
  it("re-renders byte-identically and orders bound-to-criteria first, then by emit time", () => {
    const evidence: RenderEvidence = {
      criteria: [{ id: "AC-084-11", proofKind: "screenshot" }],
      artifacts: [
        artifact({
          id: "c-late-unbound",
          filename: "later.log",
          kind: "log",
          emittedAt: "2026-07-10T12:00:00.000Z",
        }),
        artifact({
          id: "b-early-unbound",
          filename: "early.txt",
          kind: "log",
          emittedAt: "2026-07-10T08:00:00.000Z",
        }),
        artifact({
          id: "a-bound",
          filename: "proof.png",
          kind: "screenshot",
          criterionId: "AC-084-11",
          emittedAt: "2026-07-10T11:00:00.000Z",
        }),
      ],
    };

    const first = renderComment([sessionRow("t1")], new Map(), LINKS, PASS_EVAL, evidence);
    const second = renderComment([sessionRow("t1")], new Map(), LINKS, PASS_EVAL, {
      criteria: [...evidence.criteria],
      artifacts: [...evidence.artifacts],
    });

    expect(second).toBe(first);

    const order = ["proof.png", "early.txt", "later.log"].map((name) =>
      first.indexOf(name),
    );
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it("renders CI-only artifacts with no session rows, and beneath the waiting line when links are pending", () => {
    const ciOnly = renderComment([], new Map(), LINKS, PASS_EVAL, {
      criteria: [],
      artifacts: [
        artifact({ id: "a1", filename: "ci-shot.png", kind: "screenshot", provenance: "ci" }),
      ],
    });
    expect(ciOnly).toContain("**Evidence** · 1 artifact");
    expect(ciOnly).toContain("[screenshot · ci-shot.png](");
    expect(ciOnly).not.toContain("Waiting for session evidence");

    const waiting = renderComment(
      [],
      new Map(),
      LINKS,
      { verdict: "waiting", facts: [], flaggedCount: 0, pendingLinkCount: 1 },
      {
        criteria: [],
        artifacts: [
          artifact({ id: "a1", filename: "ci-shot.png", kind: "screenshot", provenance: "ci" }),
        ],
      },
    );
    expect(waiting).toContain("**⏳ Waiting for session evidence**");
    expect(waiting).toContain("**Evidence** · 1 artifact");
  });

  it("caps the artifacts table with a counted overflow line, singular and plural", () => {
    const many = (n: number) =>
      Array.from({ length: n }, (_, i) =>
        artifact({
          id: `a-${String(i).padStart(2, "0")}`,
          filename: `f-${String(i).padStart(2, "0")}.log`,
          kind: "log",
          emittedAt: `2026-07-10T${String(10 + Math.floor(i / 60)).padStart(2, "0")}:${String(i % 60).padStart(2, "0")}:00.000Z`,
        }),
      );

    const singular = renderComment([sessionRow("t1")], new Map(), LINKS, PASS_EVAL, {
      criteria: [],
      artifacts: many(31),
    });
    expect(singular).toContain("**Evidence** · 31 artifacts");
    expect(singular).toContain("f-29.log");
    expect(singular).not.toContain("f-30.log");
    expect(singular).toContain("_…and 1 more artifact — see the dashboard._");

    const plural = renderComment([sessionRow("t1")], new Map(), LINKS, PASS_EVAL, {
      criteria: [],
      artifacts: many(33),
    });
    expect(plural).toContain("_…and 3 more artifacts — see the dashboard._");
  });

  it("renders the artifact label byte-exactly, escaping the filename inside the link", () => {
    const body = renderComment([sessionRow("t1")], new Map(), LINKS, PASS_EVAL, {
      criteria: [],
      artifacts: [
        artifact({ id: "a1", filename: "shot|v2].png", kind: "screenshot", caption: "c" }),
      ],
    });

    expect(body).toContain(
      "| [screenshot · shot\\|v2\\].png](https://app.outerlayer.example/orgs/acme/apps/api/env/production/agents/artifacts/a1?src=pr-comment) | c |",
    );
  });

  it("sorts criterion rows by id regardless of input order, joins multiple matching proofs, and lists mismatched kinds sorted", () => {
    const body = renderComment([sessionRow("t1")], new Map(), LINKS, PASS_EVAL, {
      criteria: [
        { id: "REQ-b", proofKind: "video" },
        { id: "REQ-a", proofKind: "log" },
      ],
      artifacts: [
        artifact({ id: "l2", filename: "two.log", kind: "log", criterionId: "REQ-a", emittedAt: "2026-07-10T09:20:00.000Z" }),
        artifact({ id: "l1", filename: "one.log", kind: "log", criterionId: "REQ-a", emittedAt: "2026-07-10T09:10:00.000Z" }),
        artifact({ id: "s1", filename: "still.png", kind: "screenshot", criterionId: "REQ-b" }),
        artifact({ id: "r1", filename: "cov.html", kind: "report", criterionId: "REQ-b" }),
      ],
    });

    const aRow = body.indexOf("| `REQ-a` |");
    const bRow = body.indexOf("| `REQ-b` |");
    expect(aRow).toBeGreaterThan(-1);
    expect(bRow).toBeGreaterThan(aRow);
    // Both matching proofs, comma-joined in artifact order.
    expect(body).toContain("[log · one.log](");
    expect(body).toMatch(/\| `REQ-a` \| \[log · one\.log\]\([^)]+\), \[log · two\.log\]\([^)]+\) \|/);
    // Mismatched kinds listed sorted, never as a proof link.
    expect(body).toContain("| `REQ-b` | video required · report, screenshot attached |");
  });

  it("renders an artifact whose app has no default environment as an unlinked label — never an empty URL segment", () => {
    const body = renderComment([sessionRow("t1")], new Map(), LINKS, PASS_EVAL, {
      criteria: [{ id: "AC-084-14", proofKind: "screenshot" }],
      artifacts: [
        artifact({
          id: "a1",
          filename: "shot.png",
          kind: "screenshot",
          caption: "c",
          criterionId: "AC-084-14",
          envName: "",
        }),
      ],
    });

    expect(body).toContain("| screenshot · shot.png | c · for `AC-084-14` |");
    expect(body).toContain("| `AC-084-14` | screenshot · shot.png |");
    expect(body).not.toContain("/env//");
    expect(body).not.toContain("agents/artifacts/a1");
  });

  it("escapes a hostile kind everywhere it is interpolated — labels and the attached-kinds listing", () => {
    const body = renderComment([sessionRow("t1")], new Map(), LINKS, PASS_EVAL, {
      criteria: [{ id: "AC-084-15", proofKind: "video" }],
      artifacts: [
        artifact({
          id: "a1",
          filename: "shot.png",
          kind: "x](https://evil.example) | forged",
          criterionId: "AC-084-15",
        }),
      ],
    });

    expect(body).not.toContain("(https://evil.example)");
    // The forged pipe is escaped: the artifact row still has exactly two
    // content cells.
    const artifactRow = body.split("\n").find((line) => line.includes("shot.png"))!;
    expect(artifactRow.split(" | ")).toHaveLength(2);
    expect(body).toContain("video required · x\\]\\(https://evil.example\\) \\| forged attached");
  });

  it("keeps worst-case legal evidence under the GitHub body limit, deterministically, with counted elision rows", () => {
    // Maximum-legal field sizes: 120-char filenames, 500-char captions (the
    // ingest schema's caps), at the read layer's 200-artifact ceiling, plus
    // the criteria parser's 100-requirement ceiling with every criterion
    // carrying a max-size bound proof.
    const filename = (i: number) => `${String(i).padStart(3, "0")}-${"f".repeat(116)}`.slice(0, 120);
    const criterionId = (i: number) => `AC-084-${String(i % 100).padStart(2, "0")}`;
    const artifacts = Array.from({ length: 200 }, (_, i) =>
      artifact({
        id: `a-${String(i).padStart(3, "0")}`,
        filename: filename(i),
        kind: "screenshot",
        caption: "c".repeat(500),
        criterionId: criterionId(i),
        emittedAt: `2026-07-10T0${i % 10}:0${i % 6}:00.000Z`,
      }),
    );
    const criteria = Array.from({ length: 100 }, (_, i) => ({
      id: criterionId(i),
      proofKind: "screenshot",
    }));

    const first = renderComment([sessionRow("t1")], new Map(), LINKS, PASS_EVAL, {
      criteria,
      artifacts,
    });
    const second = renderComment([sessionRow("t1")], new Map(), LINKS, PASS_EVAL, {
      criteria: criteria.map((c) => ({ ...c })),
      artifacts: artifacts.map((a) => ({ ...a })),
    });

    expect(first.length).toBeLessThanOrEqual(65_536);
    expect(second).toBe(first);
    // The criteria table — the proof-status summary — survives whole; the
    // artifacts list is what sheds, and its elision is counted, never silent.
    expect(first).toContain("| `AC-084-99` |");
    expect(first).toMatch(/_…and \d+ more artifacts — see the dashboard\._/);
    // The comment still carries its prelude, marker, and footer.
    expect(first).toContain("**✅ Everything checks out");
    expect(first).toContain("<!-- outerlayer:pr-session-comment -->");
    expect(first).toContain("session dashboard");
  });

  it("sheds criteria rows with a counted elision line when the criteria table alone would breach the limit", () => {
    // Beyond anything the criteria fetch produces today — the renderer's
    // ceiling must hold on its own, not by trusting an upstream cap.
    const criteria = Array.from({ length: 3_000 }, (_, i) => ({
      id: `REQ-${String(i).padStart(4, "0")}`,
      proofKind: "video",
    }));

    const first = renderComment([sessionRow("t1")], new Map(), LINKS, PASS_EVAL, {
      criteria,
      artifacts: [artifact({ id: "a1", filename: "shot.png", kind: "screenshot" })],
    });
    const second = renderComment([sessionRow("t1")], new Map(), LINKS, PASS_EVAL, {
      criteria: criteria.map((c) => ({ ...c })),
      artifacts: [artifact({ id: "a1", filename: "shot.png", kind: "screenshot" })],
    });

    expect(first.length).toBeLessThanOrEqual(65_536);
    expect(second).toBe(first);
    expect(first).toMatch(/_…and \d+ more criteria not shown\._/);
    // Sorted head-first fit: the earliest ids survive.
    expect(first).toContain("| `REQ-0000` |");
    expect(first).not.toContain("| `REQ-2999` |");
    expect(first).toContain("<!-- outerlayer:pr-session-comment -->");
  });

  it("sheds session table rows before evidence when both compete for the ceiling", () => {
    const sessions = Array.from({ length: 120 }, (_, i) => ({
      ...sessionRow(`t-${String(i).padStart(3, "0")}`),
      title: `Session ${String(i).padStart(3, "0")} ${"x".repeat(400)}`,
    }));
    const artifacts = Array.from({ length: 30 }, (_, i) =>
      artifact({
        id: `a-${String(i).padStart(2, "0")}`,
        filename: `f-${String(i).padStart(2, "0")}-${"n".repeat(100)}.png`,
        kind: "screenshot",
        caption: "c".repeat(500),
        emittedAt: `2026-07-10T0${i % 10}:00:00.000Z`,
      }),
    );

    const body = renderComment(sessions, new Map(), LINKS, PASS_EVAL, {
      criteria: [],
      artifacts,
    });

    expect(body.length).toBeLessThanOrEqual(65_536);
    // Every artifact renders; the session table is what shed rows.
    expect(body).toContain("**Evidence** · 30 artifacts");
    expect(body).toContain("f-29-");
    expect(body).not.toContain("more artifacts — see the dashboard");
    expect(body).toMatch(/_…and \d+ more sessions — see the dashboard\._/);
  });

  it("tie-breaks equal emit times by id, and a backtick in a criterion id cannot end its code span", () => {
    const body = renderComment([sessionRow("t1")], new Map(), LINKS, PASS_EVAL, {
      criteria: [{ id: "REQ`x", proofKind: "log" }],
      artifacts: [
        artifact({ id: "z-second", filename: "z.log", kind: "log", emittedAt: "2026-07-10T09:00:00.000Z" }),
        artifact({ id: "a-first", filename: "a.log", kind: "log", emittedAt: "2026-07-10T09:00:00.000Z" }),
      ],
    });

    const aIndex = body.indexOf("a.log");
    const zIndex = body.indexOf("z.log");
    expect(aIndex).toBeGreaterThan(-1);
    expect(zIndex).toBeGreaterThan(aIndex);
    expect(body).toContain("`REQx`");
    expect(body).not.toContain("REQ`x");
  });
});
