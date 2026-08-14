/**
 * Pins the fact layer and the reference validators' display doctrine:
 * absence of proof is `absent` (never a flag), missing fact families are
 * `not_checkable` (never a silent pass or a false fail), only red-class
 * flags may escalate past amber, and evaluation is deterministic — the
 * properties user-authored validators will inherit by example.
 */
import { describe, expect, it } from "vitest";
import { extractFacts } from "../facts";
import { noTestTampering, redThenGreen, testsAfterLastEdit } from "../validators";
import type { TimelineSpan } from "../types";

function run(
  command: string,
  status: "ok" | "error" = "ok",
  turnIndex = 0,
  output?: string,
): TimelineSpan {
  return {
    sessionIndex: 0,
    turnIndex,
    toolName: "Bash",
    status,
    isEdit: false,
    command: JSON.stringify({ command }),
    ...(output !== undefined ? { output } : {}),
    ...(status === "error" ? { errorSignature: "assertion failed" } : {}),
  };
}

function edit(file: string, turnIndex = 0, status: "ok" | "error" | "rejected" = "ok"): TimelineSpan {
  return { sessionIndex: 0, turnIndex, toolName: "Edit", status, isEdit: true, file };
}

describe("extractFacts", () => {
  it("classifies runs and edits with exact coverage and timeline order", () => {
    const facts = extractFacts([
      run("yarn ci:unit", "error", 3),
      edit("src/signup/service.ts", 4),
      edit("src/signup/service.test.ts", 5),
      run("yarn ci:unit", "ok", 6),
    ]);
    expect(facts.coverage).toEqual(new Set(["commands", "edits"]));
    expect(facts.runs).toEqual([
      {
        seq: 0,
        sessionIndex: 0,
        turnIndex: 3,
        status: "error",
        kind: "test",
        normalized: "ci:unit",
        pairKey: "ci:unit",
        suiteScope: "full",
        bypass: false,
        testResult: "fail",
        errorSignature: "assertion failed",
      },
      {
        seq: 3,
        sessionIndex: 0,
        turnIndex: 6,
        status: "ok",
        kind: "test",
        normalized: "ci:unit",
        pairKey: "ci:unit",
        suiteScope: "full",
        bypass: false,
        testResult: "pass",
      },
    ]);
    expect(facts.edits).toEqual([
      {
        seq: 1,
        sessionIndex: 0,
        turnIndex: 4,
        status: "ok",
        file: "src/signup/service.ts",
        isTestFile: false,
      },
      {
        seq: 2,
        sessionIndex: 0,
        turnIndex: 5,
        status: "ok",
        file: "src/signup/service.test.ts",
        isTestFile: true,
      },
    ]);
  });

  it("reports no command coverage when tool spans carry no command content", () => {
    const facts = extractFacts([
      { sessionIndex: 0, turnIndex: 1, toolName: "Bash", status: "ok", isEdit: false },
      edit("src/a.ts", 2),
    ]);
    expect(facts.coverage).toEqual(new Set(["edits"]));
    expect(facts.runs).toEqual([]);
  });
});

describe("redThenGreen", () => {
  const timeline = [
    run("vitest run", "error", 61),
    edit("src/signup/service.ts", 62),
    run("vitest run", "ok", 63),
  ];

  // AC-083-01
  it("passes with the failing and passing runs as refs when the diff adds tests", () => {
    const result = redThenGreen.evaluate(extractFacts(timeline), { diffAddsTests: true });
    expect(result).toEqual({
      id: "red-then-green",
      status: "pass",
      summary: "New tests failed first, then passed",
      refs: [
        { sessionIndex: 0, turnIndex: 61 },
        { sessionIndex: 0, turnIndex: 63 },
      ],
    });
  });

  // AC-083-02
  it("is absent — never red — when tests were never seen failing or none were added", () => {
    const bornGreen = [edit("src/a.test.ts", 1), run("vitest run", "ok", 2)];
    expect(redThenGreen.evaluate(extractFacts(bornGreen), { diffAddsTests: true }).status).toEqual(
      "absent",
    );
    expect(redThenGreen.evaluate(extractFacts(timeline), { diffAddsTests: false }).status).toEqual(
      "absent",
    );
  });

  it("requires an edit between the failure and the pass", () => {
    const retryOnly = [run("vitest run", "error", 1), run("vitest run", "ok", 2)];
    expect(redThenGreen.evaluate(extractFacts(retryOnly), { diffAddsTests: true }).status).toEqual(
      "absent",
    );
  });

  // AC-083-03
  it("is not checkable without command coverage", () => {
    const noCommands = extractFacts([edit("src/a.test.ts", 1)]);
    expect(redThenGreen.evaluate(noCommands, { diffAddsTests: true }).status).toEqual(
      "not_checkable",
    );
  });
});

describe("piped commands mask exit codes", () => {
  // AC-083-04
  it("anchors red-then-green from OUTPUT when a piped failing run exits ok", () => {
    const facts = extractFacts([
      run("yarn vitest run src/lib | tail -25", "ok", 10, " Tests  1 failed | 19 passed (20)"),
      edit("src/lib/facts.ts", 11),
      run("yarn vitest run src/lib | tail -5", "ok", 12, " Tests  20 passed (20)"),
      edit("src/lib/facts.test.ts", 13),
    ]);
    expect(facts.runs[0]!.status).toEqual("ok");
    expect(facts.runs[0]!.testResult).toEqual("fail");
    expect(facts.runs[0]!.pairKey).toEqual(facts.runs[1]!.pairKey);
    expect(redThenGreen.evaluate(facts, { diffAddsTests: true })).toEqual({
      id: "red-then-green",
      status: "pass",
      summary: "New tests failed first, then passed",
      refs: [
        { sessionIndex: 0, turnIndex: 10 },
        { sessionIndex: 0, turnIndex: 12 },
      ],
    });
  });

  it("anchors nothing on a piped run whose output is inconclusive", () => {
    const facts = extractFacts([
      run("vitest run src/lib | tail -5", "ok", 1),
      edit("src/a.test.ts", 2),
      run("vitest run src/lib | tail -5", "ok", 3),
    ]);
    expect(facts.runs[0]!.testResult).toEqual(undefined);
    expect(redThenGreen.evaluate(facts, { diffAddsTests: true }).status).toEqual("absent");
    const last = testsAfterLastEdit.evaluate(
      extractFacts([edit("src/a.ts", 1), run("vitest run src/x | tail -3", "ok", 2)]),
      { diffAddsTests: false },
    );
    expect(last.status).toEqual("flag");
    expect(last.summary).toEqual(
      "The result of the last test run could not be determined (`vitest run src/x | tail -3`)",
    );
  });
});

describe("compound commands", () => {
  // AC-083-05
  it("classifies a test run buried mid-compound and never classifies heredoc content", () => {
    const compound =
      "cd repo && python3 - <<'EOF'\nprint('vitest run inside a heredoc')\nEOF\nyarn turbo run build && yarn vitest run src/lib | grep -E 'Tests '";
    const facts = extractFacts([run(compound, "ok", 7, " Tests  27 passed (27)")]);
    const tests = facts.runs.filter((r) => r.kind === "test");
    expect(tests.map((r) => r.pairKey)).toEqual(["vitest run src/lib"]);
    expect(tests[0]!.testResult).toEqual("pass");
    expect(facts.runs.filter((r) => r.kind === "build").length).toEqual(1);
  });
});

describe("noTestTampering", () => {
  // AC-083-07
  it("red-flags a bypassed git command with the exact ref", () => {
    const facts = extractFacts([edit("src/a.test.ts", 1), run("HUSKY=0 git push", "ok", 88)]);
    expect(noTestTampering.evaluate(facts, { diffAddsTests: true })).toEqual({
      id: "no-test-tampering",
      status: "flag",
      redClass: true,
      summary: "A git command skipped the repo's checks",
      refs: [{ sessionIndex: 0, turnIndex: 88 }],
    });
  });

  // AC-083-06
  it("flags a failure resolved by editing only tests, amber not red", () => {
    const facts = extractFacts([
      run("vitest run", "error", 48),
      edit("src/a.test.ts", 50),
      run("vitest run", "ok", 52),
    ]);
    const result = noTestTampering.evaluate(facts, { diffAddsTests: true });
    expect(result).toEqual({
      id: "no-test-tampering",
      status: "flag",
      summary: "A failing test was made to pass by changing the test, not the code",
      refs: [
        { sessionIndex: 0, turnIndex: 48 },
        { sessionIndex: 0, turnIndex: 50 },
      ],
    });
    expect(result.redClass).toEqual(undefined);
  });

  it("passes when the fix window also changed source code", () => {
    const facts = extractFacts([
      run("vitest run", "error", 1),
      edit("src/a.test.ts", 2),
      edit("src/a.ts", 3),
      run("vitest run", "ok", 4),
    ]);
    expect(noTestTampering.evaluate(facts, { diffAddsTests: true })).toEqual({
      id: "no-test-tampering",
      status: "pass",
      summary: "No tests changed to make them pass",
      refs: [],
    });
  });

  it("is absent when the session never touched a test file", () => {
    const facts = extractFacts([edit("src/a.ts", 1), run("vitest run", "ok", 2)]);
    expect(noTestTampering.evaluate(facts, { diffAddsTests: true }).status).toEqual("absent");
  });
});

describe("testsAfterLastEdit", () => {
  it("flags code changed after the last test run", () => {
    const facts = extractFacts([run("yarn ci:unit", "ok", 1), edit("src/a.ts", 2)]);
    expect(testsAfterLastEdit.evaluate(facts, { diffAddsTests: false })).toEqual({
      id: "tests-after-last-edit",
      status: "flag",
      summary: "Code changed after the last test run",
      refs: [{ sessionIndex: 0, turnIndex: 2 }],
    });
  });

  // AC-083-10
  it("names the command unless the run provably covered the full suite", () => {
    const partial = extractFacts([
      edit("src/a.ts", 1),
      run("vitest run src/a.test.ts", "ok", 2),
    ]);
    expect(testsAfterLastEdit.evaluate(partial, { diffAddsTests: false }).summary).toEqual(
      "Tests ran after the last change and passed (`vitest run src/a.test.ts`)",
    );
    const full = extractFacts([edit("src/a.ts", 1), run("yarn ci:unit", "ok", 2)]);
    expect(testsAfterLastEdit.evaluate(full, { diffAddsTests: false }).summary).toEqual(
      "Tests ran after the last change and passed (the full suite)",
    );
  });

  it("is deterministic: identical inputs yield deeply equal results", () => {
    const spans = [
      run("vitest run", "error", 1),
      edit("src/a.ts", 2),
      run("vitest run", "ok", 3),
    ];
    const first = testsAfterLastEdit.evaluate(extractFacts(spans), { diffAddsTests: true });
    const second = testsAfterLastEdit.evaluate(extractFacts(spans), { diffAddsTests: true });
    expect(second).toEqual(first);
  });
});

describe("mutation-hardening: exact doctrine shapes", () => {
  it("returns the exact not_checkable result for each validator", () => {
    const noContent = extractFacts([
      { sessionIndex: 0, turnIndex: 1, toolName: "Bash", status: "ok", isEdit: false },
    ]);
    expect(redThenGreen.evaluate(noContent, { diffAddsTests: true })).toEqual({
      id: "red-then-green",
      status: "not_checkable",
      summary: "New tests failed first, then passed — not checkable for this session",
      refs: [],
    });
    expect(noTestTampering.evaluate(noContent, { diffAddsTests: true })).toEqual({
      id: "no-test-tampering",
      status: "not_checkable",
      summary: "No tests changed to make them pass — not checkable for this session",
      refs: [],
    });
    expect(testsAfterLastEdit.evaluate(noContent, { diffAddsTests: true })).toEqual({
      id: "tests-after-last-edit",
      status: "not_checkable",
      summary: "",
      refs: [],
    });
  });

  it("returns the exact absent shape — empty summary, empty refs", () => {
    const bornGreen = extractFacts([edit("src/a.test.ts", 1), run("vitest run", "ok", 2)]);
    expect(redThenGreen.evaluate(bornGreen, { diffAddsTests: true })).toEqual({
      id: "red-then-green",
      status: "absent",
      summary: "",
      refs: [],
    });
    const noTests = extractFacts([edit("src/a.ts", 1), run("git status", "ok", 2)]);
    expect(noTestTampering.evaluate(noTests, { diffAddsTests: true })).toEqual({
      id: "no-test-tampering",
      status: "absent",
      summary: "",
      refs: [],
    });
  });
});

describe("mutation-hardening: red-then-green anchor discipline", () => {
  it("stays absent when the pass came BEFORE the failure", () => {
    const facts = extractFacts([
      edit("src/a.test.ts", 1),
      run("vitest run", "ok", 2),
      run("vitest run", "error", 3),
      edit("src/a.ts", 4),
    ]);
    expect(redThenGreen.evaluate(facts, { diffAddsTests: true }).status).toEqual("absent");
  });

  it("never pairs a failure of one command with a pass of another", () => {
    const facts = extractFacts([
      run("vitest run src/a.test.ts", "error", 1),
      edit("src/a.ts", 2),
      run("vitest run src/b.test.ts", "ok", 3),
    ]);
    expect(redThenGreen.evaluate(facts, { diffAddsTests: true }).status).toEqual("absent");
  });

  it("ignores rejected edits and edits outside the fail→pass window", () => {
    const rejectedOnly = extractFacts([
      run("vitest run", "error", 1),
      edit("src/a.ts", 2, "rejected"),
      run("vitest run", "ok", 3),
    ]);
    expect(redThenGreen.evaluate(rejectedOnly, { diffAddsTests: true }).status).toEqual("absent");
    const outsideOnly = extractFacts([
      edit("src/a.ts", 1),
      run("vitest run", "error", 2),
      run("vitest run", "ok", 3),
      edit("src/b.ts", 4),
    ]);
    expect(redThenGreen.evaluate(outsideOnly, { diffAddsTests: true }).status).toEqual("absent");
  });

  it("keeps searching pairs until one has an edit between", () => {
    const facts = extractFacts([
      run("vitest run src/a.test.ts", "error", 1),
      run("vitest run src/a.test.ts", "ok", 2),
      run("vitest run src/b.test.ts", "error", 3),
      edit("src/b.ts", 4),
      run("vitest run src/b.test.ts", "ok", 5),
    ]);
    expect(redThenGreen.evaluate(facts, { diffAddsTests: true })).toEqual({
      id: "red-then-green",
      status: "pass",
      summary: "New tests failed first, then passed",
      refs: [
        { sessionIndex: 0, turnIndex: 3 },
        { sessionIndex: 0, turnIndex: 5 },
      ],
    });
  });
});

describe("mutation-hardening: tampering window discipline", () => {
  it("does not flag when the only test edit in the window was rejected", () => {
    const facts = extractFacts([
      run("vitest run", "error", 1),
      edit("src/a.test.ts", 2, "rejected"),
      edit("src/a.ts", 3),
      run("vitest run", "ok", 4),
      edit("src/b.test.ts", 5),
    ]);
    expect(noTestTampering.evaluate(facts, { diffAddsTests: true })).toEqual({
      id: "no-test-tampering",
      status: "pass",
      summary: "No tests changed to make them pass",
      refs: [],
    });
  });

  it("does not count test edits outside the fail→pass window as tampering", () => {
    const facts = extractFacts([
      edit("src/a.test.ts", 1),
      run("vitest run", "error", 2),
      edit("src/a.ts", 3),
      run("vitest run", "ok", 4),
      edit("src/b.test.ts", 5),
    ]);
    expect(noTestTampering.evaluate(facts, { diffAddsTests: true }).status).toEqual("pass");
  });
});

describe("mutation-hardening: tests-after-last-edit branches", () => {
  it("is absent when no edit ever succeeded", () => {
    const facts = extractFacts([edit("src/a.ts", 1, "rejected"), run("vitest run", "ok", 2)]);
    expect(testsAfterLastEdit.evaluate(facts, { diffAddsTests: false })).toEqual({
      id: "tests-after-last-edit",
      status: "absent",
      summary: "",
      refs: [],
    });
  });

  it("flags when commands ran but none of them were tests", () => {
    const facts = extractFacts([run("git status", "ok", 1), edit("src/a.ts", 2)]);
    expect(testsAfterLastEdit.evaluate(facts, { diffAddsTests: false })).toEqual({
      id: "tests-after-last-edit",
      status: "flag",
      summary: "Code changed after the last test run",
      refs: [{ sessionIndex: 0, turnIndex: 2 }],
    });
  });

  it("flags a last run that failed, naming the command", () => {
    const facts = extractFacts([
      edit("src/a.ts", 1),
      run("vitest run src/a.test.ts", "error", 2),
    ]);
    expect(testsAfterLastEdit.evaluate(facts, { diffAddsTests: false })).toEqual({
      id: "tests-after-last-edit",
      status: "flag",
      summary: "The last test run after the final change failed (`vitest run src/a.test.ts`)",
      refs: [{ sessionIndex: 0, turnIndex: 2 }],
    });
  });

  it("anchors on the LAST successful edit and the LAST test run", () => {
    const facts = extractFacts([
      edit("src/a.ts", 1),
      run("vitest run", "error", 2),
      edit("src/b.ts", 3),
      run("vitest run", "ok", 4),
    ]);
    expect(testsAfterLastEdit.evaluate(facts, { diffAddsTests: false })).toEqual({
      id: "tests-after-last-edit",
      status: "pass",
      summary: "Tests ran after the last change and passed (the full suite)",
      refs: [{ sessionIndex: 0, turnIndex: 4 }],
    });
  });
});

describe("mutation-hardening: fact extraction", () => {
  it("reports empty facts and NO coverage for an empty timeline", () => {
    const facts = extractFacts([]);
    expect(facts.coverage).toEqual(new Set());
    expect(facts.runs).toEqual([]);
    expect(facts.edits).toEqual([]);
  });

  it("treats an edit flag without a file, and a file without the flag, as no edit", () => {
    const flagOnly = extractFacts([
      { sessionIndex: 0, turnIndex: 1, toolName: "Edit", status: "ok", isEdit: true },
    ]);
    expect(flagOnly.edits).toEqual([]);
    const fileOnly = extractFacts([
      { sessionIndex: 0, turnIndex: 2, toolName: "Read", status: "ok", isEdit: false, file: "src/a.ts" },
    ]);
    expect(fileOnly.edits).toEqual([]);
  });

  it("emits exactly one run for an unclassifiable span and no test result for non-tests", () => {
    expect(extractFacts([run("echo hello", "ok", 3)]).runs).toStrictEqual([
      {
        seq: 0,
        sessionIndex: 0,
        turnIndex: 3,
        status: "ok",
        kind: "other",
        normalized: "echo hello",
        pairKey: "echo hello",
        suiteScope: "unknown",
        bypass: false,
      },
    ]);
    expect(extractFacts([run("git push", "error", 4)]).runs).toStrictEqual([
      {
        seq: 0,
        sessionIndex: 0,
        turnIndex: 4,
        status: "error",
        kind: "vcs",
        normalized: "git push",
        pairKey: "git push",
        suiteScope: "unknown",
        bypass: false,
        errorSignature: "assertion failed",
      },
    ]);
  });

  it("emits ONLY the classified segments of a compound — never the noise around them", () => {
    const facts = extractFacts([
      run("echo hello && yarn vitest run src/x", "ok", 5, " Tests  3 passed (3)"),
    ]);
    expect(facts.runs).toStrictEqual([
      {
        seq: 0,
        sessionIndex: 0,
        turnIndex: 5,
        status: "ok",
        kind: "test",
        normalized: "vitest run src/x",
        pairKey: "vitest run src/x",
        suiteScope: "partial",
        bypass: false,
        testResult: "pass",
      },
    ]);
  });
});

describe("mutation-hardening: last-run flag shape and last-edit anchoring", () => {
  it("returns the exact unknown-result flag, refs included", () => {
    const facts = extractFacts([
      edit("src/a.ts", 1),
      run("vitest run src/x | tail -3", "ok", 2),
    ]);
    expect(testsAfterLastEdit.evaluate(facts, { diffAddsTests: false })).toEqual({
      id: "tests-after-last-edit",
      status: "flag",
      summary: "The result of the last test run could not be determined (`vitest run src/x | tail -3`)",
      refs: [{ sessionIndex: 0, turnIndex: 2 }],
    });
  });

  it("anchors the trailing-edit flag on the LAST edit, not the first", () => {
    const facts = extractFacts([
      run("vitest run", "ok", 1),
      edit("src/a.ts", 2),
      edit("src/b.ts", 4),
    ]);
    expect(testsAfterLastEdit.evaluate(facts, { diffAddsTests: false })).toEqual({
      id: "tests-after-last-edit",
      status: "flag",
      summary: "Code changed after the last test run",
      refs: [{ sessionIndex: 0, turnIndex: 4 }],
    });
  });
});

describe("mutation-hardening: tampering window is the window, not the timeline", () => {
  it("never flags a fail→pass pair with an empty window because of edits elsewhere", () => {
    const facts = extractFacts([
      run("vitest run", "error", 1),
      run("vitest run", "ok", 2),
      edit("src/a.test.ts", 3),
    ]);
    expect(noTestTampering.evaluate(facts, { diffAddsTests: true })).toEqual({
      id: "no-test-tampering",
      status: "pass",
      summary: "No tests changed to make them pass",
      refs: [],
    });
  });

  it("does not let a rejected test edit inside the window count as tampering", () => {
    const facts = extractFacts([
      run("vitest run", "error", 1),
      edit("src/a.test.ts", 2, "rejected"),
      run("vitest run", "ok", 3),
      edit("src/b.test.ts", 4),
    ]);
    expect(noTestTampering.evaluate(facts, { diffAddsTests: true }).status).toEqual("pass");
  });
});

describe("mutation-hardening: red-then-green ref identity", () => {
  it("anchors on the FIRST reliable failure, and the refs prove it", () => {
    const facts = extractFacts([
      edit("src/a.test.ts", 1),
      run("vitest run", "ok", 2),
      run("vitest run", "error", 3),
      edit("src/a.ts", 4),
      run("vitest run", "ok", 5),
    ]);
    expect(redThenGreen.evaluate(facts, { diffAddsTests: true })).toEqual({
      id: "red-then-green",
      status: "pass",
      summary: "New tests failed first, then passed",
      refs: [
        { sessionIndex: 0, turnIndex: 3 },
        { sessionIndex: 0, turnIndex: 5 },
      ],
    });
  });

  it("returns the exact absent shape when the diff adds no tests", () => {
    const facts = extractFacts([
      run("vitest run", "error", 1),
      edit("src/a.ts", 2),
      run("vitest run", "ok", 3),
    ]);
    expect(redThenGreen.evaluate(facts, { diffAddsTests: false })).toEqual({
      id: "red-then-green",
      status: "absent",
      summary: "",
      refs: [],
    });
  });
});
