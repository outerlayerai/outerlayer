/**
 * Golden / determinism tests for the seeded fake runner.
 *
 * The fake runner synthesizes the whole wizard → matrix → card flow with no
 * backend, deterministically from a seed. These pin its exact outputs — the
 * planned matrix, per-cell resolution, and the fully aggregated CardStats — so
 * a bug in the demo's math is observable (and the new .ts logic is graded by
 * the patch-mutation gate, not just executed). Values are golden: they are the
 * real (correct) outputs of the deterministic functions; any change to the
 * arithmetic/branching produces different numbers and fails these.
 */

import { describe, expect, it } from "vitest";
import {
  buildCardFromCells,
  planTrialCells,
  resolveCell,
  type EvalRunRequest,
  type TrialCell,
  type WizardConfig,
} from "../fake-runner";

const A: WizardConfig = { id: "opus", launcher: "claude-code", model: "claude-opus-4-8" };
const B: WizardConfig = { id: "glm", launcher: "claude-code", model: "glm-5.2" };

function makeReq(over: Partial<EvalRunRequest> = {}): EvalRunRequest {
  return {
    repoLabel: "acme/payments",
    taskIds: ["task-001", "task-002", "task-003", "task-004"],
    configs: [A, B],
    trialsPerTask: 2,
    budgetUsd: 90,
    scenario: "clear",
    ...over,
  };
}

const cell = (taskId: string, configId: string, trialIndex: number): TrialCell => ({
  taskId,
  configId,
  trialIndex,
  status: "queued",
  resolved: false,
});

describe("planTrialCells", () => {
  it("emits one queued/unresolved cell per task × config × trial, in nested order", () => {
    const cells = planTrialCells(makeReq({ taskIds: ["t1", "t2"], trialsPerTask: 2 }));
    expect(cells).toEqual([
      cell("t1", "opus", 0),
      cell("t1", "opus", 1),
      cell("t1", "glm", 0),
      cell("t1", "glm", 1),
      cell("t2", "opus", 0),
      cell("t2", "opus", 1),
      cell("t2", "glm", 0),
      cell("t2", "glm", 1),
    ]);
  });

  it("scales the cell count with tasks × configs × trials", () => {
    expect(planTrialCells(makeReq({ taskIds: ["a", "b", "c"], trialsPerTask: 4 }))).toHaveLength(3 * 2 * 4);
  });
});

describe("resolveCell", () => {
  const req = makeReq({ scenario: "clear" });
  const at = (taskId: string, configId: string, trialIndex: number) => resolveCell(req, cell(taskId, configId, trialIndex));

  it("is deterministic — the same cell always resolves identically", () => {
    expect(at("task-001", "opus", 0)).toEqual(at("task-001", "opus", 0));
    expect(at("task-002", "glm", 1)).toEqual(at("task-002", "glm", 1));
  });

  it("preserves the cell's identity and only sets status + resolved", () => {
    const r = at("task-001", "opus", 0);
    expect(r.taskId).toBe("task-001");
    expect(r.configId).toBe("opus");
    expect(r.trialIndex).toBe(0);
    expect(["graded", "agent_error", "timeout"]).toContain(r.status);
    expect(typeof r.resolved).toBe("boolean");
  });

  it("resolves specific cells to their exact golden outcomes", () => {
    expect(at("task-001", "opus", 0)).toMatchInlineSnapshot(`
      {
        "configId": "opus",
        "resolved": true,
        "status": "graded",
        "taskId": "task-001",
        "trialIndex": 0,
      }
    `);
    expect(at("task-001", "glm", 0)).toMatchInlineSnapshot(`
      {
        "configId": "glm",
        "resolved": false,
        "status": "graded",
        "taskId": "task-001",
        "trialIndex": 0,
      }
    `);
    expect(at("task-002", "opus", 1)).toMatchInlineSnapshot(`
      {
        "configId": "opus",
        "resolved": false,
        "status": "graded",
        "taskId": "task-002",
        "trialIndex": 1,
      }
    `);
    expect(at("task-003", "glm", 0)).toMatchInlineSnapshot(`
      {
        "configId": "glm",
        "resolved": false,
        "status": "graded",
        "taskId": "task-003",
        "trialIndex": 0,
      }
    `);
  });

  it("higher-resolve config (A in a clear run) beats the weaker config across the full matrix", () => {
    const cells = planTrialCells(req).map((c) => resolveCell(req, c));
    const resolvedFor = (id: string) => cells.filter((c) => c.configId === id && c.status === "graded" && c.resolved).length;
    // clear scenario tunes A's rate (0.68) well above B's (0.42).
    expect(resolvedFor("opus")).toBeGreaterThan(resolvedFor("glm"));
  });
});

describe("buildCardFromCells", () => {
  const fullyResolved = (req: EvalRunRequest) => planTrialCells(req).map((c) => resolveCell(req, c));

  it("aggregates a clear-scenario run into exact golden CardStats", () => {
    const req = makeReq({ scenario: "clear" });
    const card = buildCardFromCells(req, fullyResolved(req));
    expect(card.stats).toMatchInlineSnapshot(`
      {
        "configs": [
          "opus",
          "glm",
        ],
        "dollarsPerResolved": {
          "a": 0.6666666666666666,
          "b": 0.3066666666666667,
          "ratioCi95": [
            0.2,
            0.4,
          ],
        },
        "exclusions": [],
        "mde": {
          "at80Power": 0.1,
          "note": "observed discordance 0/4",
        },
        "nTasks": 4,
        "pairedDelta": {
          "ci95": [
            -0.06,
            0.06,
          ],
          "est": 0,
        },
        "resolveRate": {
          "a": {
            "ci95": [
              0.3006360524426366,
              0.9544139373553637,
            ],
            "rate": 0.75,
          },
          "b": {
            "ci95": [
              0.3006360524426366,
              0.9544139373553637,
            ],
            "rate": 0.75,
          },
        },
        "sensitivity": {
          "excludedFlippedConclusion": false,
        },
        "totalCostUsd": 2.92,
        "trialsPerTask": 2,
        "verdict": "clear",
        "verdictRules": "95% CI excludes 0 AND |est| ≥ MDE·0.8",
      }
    `);
  });

  it("carries the request's verdict and task count through, A−B delta sign convention", () => {
    for (const scenario of ["clear", "directional", "underpowered"] as const) {
      const req = makeReq({ scenario });
      const card = buildCardFromCells(req, fullyResolved(req));
      expect(card.stats.verdict).toBe(scenario);
      expect(card.stats.nTasks).toBe(req.taskIds.length);
      expect(card.stats.configs).toEqual(["opus", "glm"]);
      // A is the stronger config in every tuned scenario → non-negative delta.
      expect(card.stats.pairedDelta.est).toBeGreaterThanOrEqual(0);
    }
  });

  it("flags an exclusion when any cell is non-graded, none when all graded", () => {
    const req = makeReq();
    const allGraded: TrialCell[] = planTrialCells(req).map((c) => ({ ...c, status: "graded", resolved: true }));
    expect(buildCardFromCells(req, allGraded).stats.exclusions).toEqual([]);

    const withFailure = allGraded.map((c, i) => (i === 0 ? { ...c, status: "agent_error" as const, resolved: false } : c));
    expect(buildCardFromCells(req, withFailure).stats.exclusions).toEqual([{ taskId: "task-001", reason: "infra_error" }]);
  });

  it("counts non-graded outcomes into the per-config taxonomy", () => {
    const req = makeReq({ taskIds: ["t1"], trialsPerTask: 2, scenario: "clear" });
    const cells: TrialCell[] = [
      { taskId: "t1", configId: "opus", trialIndex: 0, status: "graded", resolved: true },
      { taskId: "t1", configId: "opus", trialIndex: 1, status: "timeout", resolved: false },
      { taskId: "t1", configId: "glm", trialIndex: 0, status: "agent_error", resolved: false },
      { taskId: "t1", configId: "glm", trialIndex: 1, status: "agent_error", resolved: false },
    ];
    const card = buildCardFromCells(req, cells);
    expect(card.stats.mde.note).toContain("observed discordance");
  });
});
