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

function run(command: string, status: "ok" | "error" = "ok", turnIndex = 0): TimelineSpan {
  return {
    sessionIndex: 0,
    turnIndex,
    toolName: "Bash",
    status,
    isEdit: false,
    command: JSON.stringify({ command }),
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
        suiteScope: "full",
        bypass: false,
        errorSignature: "assertion failed",
      },
      {
        seq: 3,
        sessionIndex: 0,
        turnIndex: 6,
        status: "ok",
        kind: "test",
        normalized: "ci:unit",
        suiteScope: "full",
        bypass: false,
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

  it("is not checkable without command coverage", () => {
    const noCommands = extractFacts([edit("src/a.test.ts", 1)]);
    expect(redThenGreen.evaluate(noCommands, { diffAddsTests: true }).status).toEqual(
      "not_checkable",
    );
  });
});

describe("noTestTampering", () => {
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
