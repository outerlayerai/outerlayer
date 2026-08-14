/**
 * Policy-era rendering: custom validator rows (marks, verbatim-but-escaped
 * copy, emitted-source and turn suffixes), the single policy-error row, and
 * the whole-pipeline determinism guarantee — policy files through
 * evaluation to a byte-identical comment body.
 */
import { describe, it, expect } from "vitest";

import {
  evaluateEvidence,
  type CustomValidationFact,
  type EvidenceEvaluation,
} from "../evaluate";
import { renderComment, type RenderLinks } from "../render";
import type { LinkedSessionRow } from "../read";
import { evaluateCustomValidators, type EmittedResultRecord } from "@/lib/system/verdict/custom";
import {
  builtinRuleResults,
  customValidationFacts,
  policyErrorFact,
  verificationFacts,
} from "@/lib/system/verdict/evidence";
import { extractFacts } from "@/lib/system/verdict/facts";
import { parsePolicy } from "@/lib/system/verdict/policy";
import type { TimelineSpan } from "@/lib/system/verdict/types";

const LINKS: RenderLinks = {
  baseUrl: "https://app.outerlayer.example",
  orgName: "acme",
  prNumber: 812,
};

const ROW: LinkedSessionRow = {
  sessionId: "s-t1",
  traceId: "t1",
  appId: "app-1",
  appName: "api",
  envName: "production",
  method: "pr_link",
  title: "Add a migration",
  startedAt: "2026-07-10T09:00:00.000Z",
  endedAt: "2026-07-10T09:41:00.000Z",
  costUsd: 3.12,
  models: ["opus-5"],
  apiErrorCount: 0,
  errorCount: 0,
  agentType: "claude-code",
  recordedCommitShas: [],
};

const custom = (over: Partial<CustomValidationFact> = {}): CustomValidationFact => ({
  type: "custom-validation",
  id: "migration-must-run",
  status: "flag",
  class: "amber",
  level: "warn",
  sentence: "Migrations ran against a local database",
  refs: [],
  source: null,
  ...over,
});

function renderWith(over: {
  customFacts?: CustomValidationFact[];
  policyError?: Parameters<typeof evaluateEvidence>[0]["policyError"];
}): string {
  const evaluation: EvidenceEvaluation = evaluateEvidence({
    sessions: [ROW],
    pendingLinkCount: 0,
    prCommitShas: null,
    ...over,
  });
  return renderComment([ROW], new Map(), LINKS, evaluation);
}

describe("renderComment — custom validator rows", () => {
  // proves AC-085-05
  it("renders a flagged custom with the row copy verbatim and the required-not-proven suffix", () => {
    const body = renderWith({ customFacts: [custom()] });
    expect(body).toContain(
      "⚠ **Migrations ran against a local database** — required, not proven this PR",
    );
    expect(body).toContain("**⚠️ Look at 1 thing before merging**");
  });

  // proves AC-085-06
  it("renders a passing custom with its matched run's turn as the proof suffix", () => {
    const body = renderWith({
      customFacts: [
        custom({ status: "pass", refs: [{ traceId: "t1", turnIndex: 7 }] }),
      ],
    });
    expect(body).toContain("✓ **Migrations ran against a local database** — turn 7");
  });

  // proves AC-085-10
  it("renders an emitted-backed pass with the run link and the ci provenance stamp", () => {
    const body = renderWith({
      customFacts: [
        custom({
          id: "smoke-test",
          sentence: "Smoke test passed on the preview deploy",
          status: "pass",
          source: { provenance: "ci", link: "https://ci.example/runs/42" },
        }),
      ],
    });
    expect(body).toContain(
      "✓ **Smoke test passed on the preview deploy** — [CI run](https://ci.example/runs/42) `ci`",
    );
  });

  it("renders an emitted failure as a flag naming the failing run", () => {
    const body = renderWith({
      customFacts: [
        custom({
          id: "smoke-test",
          sentence: "Smoke test passed on the preview deploy",
          source: { provenance: "ci", link: "https://ci.example/runs/43" },
        }),
      ],
    });
    expect(body).toContain(
      "⚠ **Smoke test passed on the preview deploy** — failed — [CI run](https://ci.example/runs/43) `ci`",
    );
  });

  // proves AC-085-03
  it("marks an info-level flag ℹ while the verdict still reads pass", () => {
    const body = renderWith({ customFacts: [custom({ level: "info" })] });
    expect(body).toContain(
      "ℹ **Migrations ran against a local database** — required, not proven this PR",
    );
    expect(body.startsWith("**✅ Everything checks out — a quick review should be enough**")).toBe(
      true,
    );
  });

  // proves AC-085-09
  it("renders not-checkable as its own visible state — never a pass mark, never a warning", () => {
    const body = renderWith({ customFacts: [custom({ status: "not_checkable" })] });
    expect(body).toContain(
      "– **Migrations ran against a local database** — not checkable for this session",
    );
    expect(body).not.toContain("✓ **Migrations ran against a local database**");
    expect(body).not.toContain("⚠ **Migrations ran against a local database**");
  });

  it("escapes tenant-authored row copy — markdown and HTML cannot break out of the line", () => {
    const body = renderWith({
      customFacts: [
        custom({
          sentence: 'Click [here](https://evil.example) <img src=x onerror=alert(1)> | done',
        }),
      ],
    });
    expect(body).not.toContain("[here](https://evil.example)");
    expect(body).not.toContain("<img");
    expect(body).toContain("\\[here\\]");
  });

  it("refuses to link a non-http emitted source, keeping only the provenance stamp", () => {
    const body = renderWith({
      customFacts: [
        custom({
          status: "pass",
          source: { provenance: "local", link: "javascript:alert(1)" },
        }),
      ],
    });
    expect(body).not.toContain("javascript:");
    expect(body).toContain("✓ **Migrations ran against a local database** — `local`");
  });

  it("percent-encodes link characters that would end the markdown wrapper", () => {
    const body = renderWith({
      customFacts: [
        custom({
          status: "pass",
          source: { provenance: "ci", link: "https://ci.example/run(1) `x`" },
        }),
      ],
    });
    expect(body).toContain("[CI run](https://ci.example/run%281%29%20%60x%60) `ci`");
  });

  it("percent-encodes whitespace in a link — a raw newline cannot inject a fabricated row", () => {
    const body = renderWith({
      customFacts: [
        custom({
          status: "pass",
          source: {
            provenance: "ci",
            link: "https://ci.example/run\n⚠ **Fake check failed**\tend",
          },
        }),
      ],
    });
    expect(body).not.toContain("\n⚠ **Fake check failed**");
    expect(body).toContain("[CI run](https://ci.example/run%0A⚠%20**Fake%20check%20failed**%09end) `ci`");
  });
});

describe("renderComment — the policy error row", () => {
  // proves AC-085-13
  it("renders one loud row naming the file and problem while the rest of the comment still renders", () => {
    const body = renderWith({
      policyError: {
        type: "policy-error",
        status: "flag",
        class: "amber",
        file: ".outerlayer/policy.yaml",
        problem: 'unknown extends "outerlayer:strict@v9"',
        additionalProblemCount: 2,
      },
    });
    expect(body).toContain(
      '⚠ **The policy file has an error** — `.outerlayer/policy.yaml`: unknown extends "outerlayer:strict@v9" (and 2 more)',
    );
    // The rest of the comment: verdict line, session table, footer.
    expect(body).toContain("**⚠️ Look at 1 thing before merging**");
    expect(body).toContain("| [Add a migration]");
    expect(body).toContain("session dashboard");
  });
});

describe("policy pipeline determinism", () => {
  // proves AC-085-16
  it("renders a byte-identical body from unchanged policy files, spans, and emitted records", () => {
    const policyFiles = {
      policyFile: {
        path: ".outerlayer/policy.yaml",
        content: "extends: outerlayer:recommended@v1\nvalidators:\n  commits-from-sessions: info\n",
      },
      validatorFiles: [
        {
          path: ".outerlayer/validators/migration-must-run.yaml",
          content: [
            "id: migration-must-run",
            "kind: validation",
            'row: "Migrations ran against a local database"',
            "when:",
            '  paths: ["supabase/migrations/**"]',
            "require:",
            "  any:",
            '    - session.ran: { command: "supabase migration up", status: ok }',
            "    - emitted: migration.executed",
          ].join("\n"),
        },
        {
          path: ".outerlayer/validators/migration-ci.yaml",
          content: [
            "id: migration-ci",
            "kind: validation",
            'row: "Migration executed in CI"',
            "run: { where: ci, emit: migration.executed }",
          ].join("\n"),
        },
      ],
    };
    const spans: TimelineSpan[] = [
      {
        sessionIndex: 0,
        turnIndex: 4,
        toolName: "Bash",
        status: "ok",
        isEdit: false,
        command: JSON.stringify({ command: "supabase migration up --local" }),
      },
    ];
    const emitted = new Map<string, EmittedResultRecord>([
      [
        "migration.executed",
        {
          name: "migration.executed",
          result: "pass",
          link: "https://ci.example/runs/9",
          provenance: "ci",
        },
      ],
    ]);

    const evaluateOnce = (): string => {
      const policy = parsePolicy(policyFiles.policyFile, policyFiles.validatorFiles);
      const facts = extractFacts(spans);
      const builtins = builtinRuleResults(facts, { diffAddsTests: false });
      const customResults = evaluateCustomValidators({
        defs: policy.customs,
        facts,
        changedPaths: ["supabase/migrations/20260801_add.sql"],
        emitted,
        builtinResults: builtins,
      });
      const evaluation = evaluateEvidence({
        sessions: [ROW],
        pendingLinkCount: 0,
        prCommitShas: ["aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"],
        verificationFacts: verificationFacts(builtins, ["t1"]),
        factLevels: policy.levels,
        customFacts: customValidationFacts(customResults, ["t1"]),
        policyError: policyErrorFact(policy.problems),
      });
      return renderComment([ROW], new Map(), LINKS, evaluation);
    };

    const first = evaluateOnce();
    expect(evaluateOnce()).toBe(first);
    // Both customs rendered, the info-leveled provenance flag visible but
    // uncounted, and no policy error.
    expect(first).toContain("✓ **Migrations ran against a local database** — turn 4");
    expect(first).toContain(
      "✓ **Migration executed in CI** — [CI run](https://ci.example/runs/9) `ci`",
    );
    expect(first).toContain("ℹ **0 of 1 commits came from recorded sessions**");
    expect(first).not.toContain("policy file has an error");
  });
});
