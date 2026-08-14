/**
 * Real-transcript fixture: seven consecutive tool spans cut from the session
 * that BUILT this module (parse → ingest-convert → span projection, then
 * committed verbatim). The window is the exit-code-masking bug preserved in
 * amber: a genuinely failing `vitest … | tail -25` run recorded `ok` because
 * the pipe reports tail's exit, the coverage fix landed, and the piped rerun
 * passed — so this fixture proves output-based detection on data no
 * synthetic case can be accused of flattering.
 */
import { describe, expect, it } from "vitest";
import { extractFacts } from "../facts";
import { redThenGreen } from "../validators";
import type { TimelineSpan } from "../types";
import fixture from "./fixtures/real-red-then-green.json";

const spans = fixture as TimelineSpan[];

describe("real session fixture — exit-code masking", () => {
  // AC-083-04
  it("detects the real failing run from output despite its ok exit, and pairs it across pipe tails", () => {
    const facts = extractFacts(spans);
    const failing = facts.runs.find((run) => run.testResult === "fail");
    expect(failing?.status).toEqual("ok");
    expect(failing?.turnIndex).toEqual(536);
    const passing = facts.runs.find(
      (run) => run.testResult === "pass" && run.pairKey === failing?.pairKey,
    );
    expect(passing?.turnIndex).toEqual(540);
  });

  // AC-083-01
  it("red-then-green fires on the real pair with the fix edit between", () => {
    const facts = extractFacts(spans);
    expect(redThenGreen.evaluate(facts, { diffAddsTests: true })).toEqual({
      id: "red-then-green",
      status: "pass",
      summary: "New tests failed first, then passed",
      refs: [
        { sessionIndex: 0, turnIndex: 536 },
        { sessionIndex: 0, turnIndex: 540 },
      ],
    });
  });

  // AC-083-09
  it("is deterministic on real data", () => {
    const first = redThenGreen.evaluate(extractFacts(spans), { diffAddsTests: true });
    const second = redThenGreen.evaluate(extractFacts(spans), { diffAddsTests: true });
    expect(second).toEqual(first);
  });
});
