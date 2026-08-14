import type { CommandRun, Facts, RuleResult, Validator, VerdictCtx } from "./types";

/**
 * The reference validators — the fact layer's first consumers, written in
 * the same shape user-authored validators will target. Shared display
 * doctrine, enforced by these implementations and pinned by their tests:
 *
 *  - Absence of proof is `absent`, never a flag: tests that were never seen
 *    failing produce no row rather than a red one.
 *  - `not_checkable` whenever a needed fact family wasn't captured.
 *  - A summary may state only what the matcher proved (no totality claims
 *    without an established full suite scope).
 *  - Only red-class flags may drive the "can't verify" verdict; everything
 *    else caps at amber.
 */

function notCheckable(id: string, summary: string): RuleResult {
  return { id, status: "not_checkable", summary, refs: [] };
}

function covered(facts: Facts, validator: Validator): boolean {
  return validator.needs.every((family) => facts.coverage.has(family));
}

/** Groups test runs by their normalized command — the identity that lets a
 * later pass be recognized as "the same command that failed". Insertion
 * order follows the timeline, so groups iterate deterministically. */
function testRunsByCommand(facts: Facts): Map<string, CommandRun[]> {
  const groups = new Map<string, CommandRun[]>();
  for (const run of facts.runs) {
    if (run.kind !== "test") continue;
    const group = groups.get(run.normalized);
    if (group) group.push(run);
    else groups.set(run.normalized, [run]);
  }
  return groups;
}

interface FailThenPass {
  fail: CommandRun;
  pass: CommandRun;
}

/** First failing run of a command followed by a later ok run of the same
 * command. The window between the two is where the interesting edits live. */
function failThenPassPairs(facts: Facts): FailThenPass[] {
  const pairs: FailThenPass[] = [];
  for (const runs of testRunsByCommand(facts).values()) {
    const fail = runs.find((run) => run.status === "error");
    if (!fail) continue;
    const pass = runs.find((run) => run.status === "ok" && run.seq > fail.seq);
    if (pass) pairs.push({ fail, pass });
  }
  return pairs;
}

export const redThenGreen: Validator = {
  id: "red-then-green",
  needs: ["commands", "edits"],
  evaluate(facts, ctx: VerdictCtx): RuleResult {
    if (!covered(facts, this)) {
      return notCheckable(this.id, "New tests failed first, then passed — not checkable for this session");
    }
    if (!ctx.diffAddsTests) {
      return { id: this.id, status: "absent", summary: "", refs: [] };
    }
    for (const { fail, pass } of failThenPassPairs(facts)) {
      const editBetween = facts.edits.some(
        (edit) => edit.status === "ok" && edit.seq > fail.seq && edit.seq < pass.seq,
      );
      if (editBetween) {
        return {
          id: this.id,
          status: "pass",
          summary: "New tests failed first, then passed",
          refs: [
            { sessionIndex: fail.sessionIndex, turnIndex: fail.turnIndex },
            { sessionIndex: pass.sessionIndex, turnIndex: pass.turnIndex },
          ],
        };
      }
    }
    // Tests were added but never observed failing: unproven, not wrong.
    return { id: this.id, status: "absent", summary: "", refs: [] };
  },
};

export const noTestTampering: Validator = {
  id: "no-test-tampering",
  needs: ["commands", "edits"],
  evaluate(facts): RuleResult {
    if (!covered(facts, this)) {
      return notCheckable(this.id, "No tests changed to make them pass — not checkable for this session");
    }

    const bypass = facts.runs.find((run) => run.bypass);
    if (bypass) {
      return {
        id: this.id,
        status: "flag",
        redClass: true,
        summary: "A git command skipped the repo's checks",
        refs: [{ sessionIndex: bypass.sessionIndex, turnIndex: bypass.turnIndex }],
      };
    }

    for (const { fail, pass } of failThenPassPairs(facts)) {
      const window = facts.edits.filter((edit) => edit.seq > fail.seq && edit.seq < pass.seq);
      const testEdits = window.filter((edit) => edit.isTestFile && edit.status === "ok");
      const nonTestEdits = window.filter((edit) => !edit.isTestFile && edit.status === "ok");
      if (testEdits.length > 0 && nonTestEdits.length === 0) {
        return {
          id: this.id,
          status: "flag",
          summary: "A failing test was made to pass by changing the test, not the code",
          refs: [
            { sessionIndex: fail.sessionIndex, turnIndex: fail.turnIndex },
            { sessionIndex: testEdits[0]!.sessionIndex, turnIndex: testEdits[0]!.turnIndex },
          ],
        };
      }
    }

    const touchesTests = facts.edits.some((edit) => edit.isTestFile);
    if (!touchesTests) return { id: this.id, status: "absent", summary: "", refs: [] };
    return { id: this.id, status: "pass", summary: "No tests changed to make them pass", refs: [] };
  },
};

export const testsAfterLastEdit: Validator = {
  id: "tests-after-last-edit",
  needs: ["commands", "edits"],
  silent: true,
  evaluate(facts): RuleResult {
    if (!covered(facts, this)) {
      return notCheckable(this.id, "");
    }
    const lastEdit = [...facts.edits].reverse().find((edit) => edit.status === "ok");
    if (!lastEdit) return { id: this.id, status: "absent", summary: "", refs: [] };
    const lastTest = [...facts.runs].reverse().find((run) => run.kind === "test");
    if (!lastTest || lastTest.seq < lastEdit.seq) {
      return {
        id: this.id,
        status: "flag",
        summary: "Code changed after the last test run",
        refs: [{ sessionIndex: lastEdit.sessionIndex, turnIndex: lastEdit.turnIndex }],
      };
    }
    // The summary names the command rather than a totality ("all N tests")
    // unless the run's scope is provably the full suite.
    const scopeNote = lastTest.suiteScope === "full" ? "the full suite" : `\`${lastTest.normalized}\``;
    if (lastTest.status !== "ok") {
      return {
        id: this.id,
        status: "flag",
        summary: `The last test run after the final change failed (${scopeNote})`,
        refs: [{ sessionIndex: lastTest.sessionIndex, turnIndex: lastTest.turnIndex }],
      };
    }
    return {
      id: this.id,
      status: "pass",
      summary: `Tests ran after the last change and passed (${scopeNote})`,
      refs: [{ sessionIndex: lastTest.sessionIndex, turnIndex: lastTest.turnIndex }],
    };
  },
};
