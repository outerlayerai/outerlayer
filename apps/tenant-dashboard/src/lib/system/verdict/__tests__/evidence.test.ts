/**
 * Pins the bridge from validator results to displayed evidence facts: only
 * pass/flag become facts, refs map session position → trace id, red class
 * survives verbatim, and an unreadable PR file list suppresses
 * red-then-green rather than approximating its diff gate.
 */
import { describe, expect, it } from "vitest";
import { builtinRuleResults, verificationFacts } from "../evidence";
import { extractFacts } from "../facts";
import type { TimelineSpan } from "../types";

const TRACES = ["trace-a", "trace-b"] as const;

/** Spans → displayed facts, through the same two stages the orchestrator
 * composes: extraction, built-in evaluation, then the display bridge. An
 * unreadable PR file list (null) arrives as ctx `diffAddsTests: false`. */
function factsFor(
  spans: readonly TimelineSpan[],
  traceIds: readonly string[],
  diffAddsTests: boolean | null,
) {
  const results = builtinRuleResults(extractFacts(spans), {
    diffAddsTests: diffAddsTests === true,
  });
  return verificationFacts(results, traceIds);
}

function run(
  command: string,
  status: "ok" | "error" = "ok",
  turnIndex = 0,
  sessionIndex = 0,
): TimelineSpan {
  return {
    sessionIndex,
    turnIndex,
    toolName: "Bash",
    status,
    isEdit: false,
    command: JSON.stringify({ command }),
    ...(status === "error" ? { errorSignature: "assertion failed" } : {}),
  };
}

function edit(file: string, turnIndex = 0, sessionIndex = 0): TimelineSpan {
  return { sessionIndex, turnIndex, toolName: "Edit", status: "ok", isEdit: true, file };
}

describe("verificationFacts", () => {
  // AC-083-11
  it("maps pass and flag results to facts with trace-resolved refs", () => {
    const spans = [
      run("vitest run", "error", 61, 0),
      edit("src/signup/service.ts", 62, 0),
      run("vitest run", "ok", 63, 1),
    ];
    expect(factsFor(spans, TRACES, true)).toEqual([
      {
        id: "red-then-green",
        status: "pass",
        class: "amber",
        sentence: "New tests failed first, then passed",
        refs: [
          { traceId: "trace-a", turnIndex: 61 },
          { traceId: "trace-b", turnIndex: 63 },
        ],
      },
    ]);
  });

  // AC-083-12
  it("carries a check-bypass through as a red-class flag", () => {
    const spans = [edit("src/a.test.ts", 1), run("git push --no-verify", "ok", 88)];
    expect(factsFor(spans, TRACES, true)).toEqual([
      {
        id: "no-test-tampering",
        status: "flag",
        class: "red",
        sentence: "A git command skipped the repo's checks",
        refs: [{ traceId: "trace-a", turnIndex: 88 }],
      },
    ]);
  });

  it("omits absent and not_checkable results instead of rendering claims", () => {
    // Command content missing entirely: both validators are not_checkable.
    const noCommands: TimelineSpan[] = [
      { sessionIndex: 0, turnIndex: 1, toolName: "Bash", status: "ok", isEdit: false },
    ];
    expect(factsFor(noCommands, TRACES, true)).toEqual([]);
    // Tests born green and no test files touched: both validators absent.
    const bornGreen = [edit("src/a.ts", 1), run("vitest run", "ok", 2)];
    expect(factsFor(bornGreen, TRACES, true)).toEqual([]);
  });

  it("suppresses red-then-green when the PR file list was unreadable, without muting tampering", () => {
    const spans = [
      run("vitest run", "error", 10),
      edit("src/a.test.ts", 11),
      run("vitest run", "ok", 12),
    ];
    const facts = factsFor(spans, TRACES, null);
    // red-then-green would pass with diffAddsTests=true; with null it must
    // not appear at all. The tampering flag (fail → test-only edit → pass)
    // needs no diff and still surfaces.
    expect(facts).toEqual([
      {
        id: "no-test-tampering",
        status: "flag",
        class: "amber",
        sentence: "A failing test was made to pass by changing the test, not the code",
        refs: [
          { traceId: "trace-a", turnIndex: 10 },
          { traceId: "trace-a", turnIndex: 11 },
        ],
      },
    ]);
  });

  it("drops refs whose session index has no trace id rather than fabricating one", () => {
    const spans = [
      run("vitest run", "error", 5, 1),
      edit("src/a.ts", 6, 1),
      run("vitest run", "ok", 7, 1),
    ];
    const facts = factsFor(spans, ["only-trace"], true);
    expect(facts).toEqual([
      {
        id: "red-then-green",
        status: "pass",
        class: "amber",
        sentence: "New tests failed first, then passed",
        refs: [],
      },
    ]);
  });
});
