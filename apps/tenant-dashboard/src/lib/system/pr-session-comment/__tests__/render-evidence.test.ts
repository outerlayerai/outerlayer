/**
 * The Evidence block of the PR comment: artifacts as links, criterion proof
 * rows, escaping, and byte-identical re-rendering. Pure function in, string
 * out — most of `acceptance/082-artifacts.md`'s rendering criteria are
 * proven here.
 */
import { describe, it, expect } from "vitest";

import { renderComment, type RenderLinks, type RenderEvidence } from "../render";
import type { LinkedSessionRow } from "../read";
import type { PrArtifactRow } from "../artifacts-read";

const LINKS: RenderLinks = {
  baseUrl: "https://app.outerlayer.example",
  orgName: "acme",
  prNumber: 61,
};

const sessionRow = (traceId: string): LinkedSessionRow => ({
  traceId,
  sessionId: `s-${traceId}`,
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
  // proves AC-082-11
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

    const body = renderComment([sessionRow("t1")], new Map(), LINKS, evidence);

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

  // proves AC-082-12
  it("renders no Artifacts subgroup and no count when the PR has no artifacts", () => {
    const withoutEvidence = renderComment([sessionRow("t1")], new Map(), LINKS);
    const withEmptyEvidence = renderComment([sessionRow("t1")], new Map(), LINKS, {
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

  // proves AC-082-13
  it("renders links only — image kinds never render inline media markup", () => {
    const body = renderComment([], new Map(), LINKS, {
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

  // proves AC-082-14
  it("renders a kind-matching bound artifact as the criterion's proof link", () => {
    const body = renderComment([sessionRow("t1")], new Map(), LINKS, {
      criteria: [{ id: "AC-082-11", proofKind: "screenshot" }],
      artifacts: [
        artifact({
          id: "a1",
          filename: "evidence.png",
          kind: "screenshot",
          criterionId: "AC-082-11",
          caption: "Comment with artifacts rendered",
        }),
      ],
    });

    expect(body).toContain("| Criterion | Proof |");
    expect(body).toContain(
      "| `AC-082-11` | [screenshot · evidence.png](https://app.outerlayer.example/orgs/acme/apps/api/env/production/agents/artifacts/a1?src=pr-comment) |",
    );
  });

  // proves AC-082-15
  it("never upgrades the wrong kind: mismatches and absences render as unmet requirements", () => {
    const body = renderComment([sessionRow("t1")], new Map(), LINKS, {
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

  // proves AC-082-16
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

    const body = renderComment([sessionRow("t1")], new Map(), LINKS, {
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

  // proves AC-082-17
  it("re-renders byte-identically and orders bound-to-criteria first, then by emit time", () => {
    const evidence: RenderEvidence = {
      criteria: [{ id: "AC-082-11", proofKind: "screenshot" }],
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
          criterionId: "AC-082-11",
          emittedAt: "2026-07-10T11:00:00.000Z",
        }),
      ],
    };

    const first = renderComment([sessionRow("t1")], new Map(), LINKS, evidence);
    const second = renderComment([sessionRow("t1")], new Map(), LINKS, {
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

  it("renders evidence beneath the empty-session state so CI-only artifacts still surface", () => {
    const body = renderComment([], new Map(), LINKS, {
      criteria: [],
      artifacts: [
        artifact({ id: "a1", filename: "ci-shot.png", kind: "screenshot", provenance: "ci" }),
      ],
    });

    expect(body).toContain("No agent sessions linked yet.");
    expect(body).toContain("**Evidence** · 1 artifact");
    expect(body).toContain("[screenshot · ci-shot.png](");
  });
});
