// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Magu Studios, Inc.

import { describe, expect, it } from "vitest";
import type { DetectionSession, DetectionToolCall, ResolvedConfig } from "../types.js";
import { resolveConfig, runDetectors, rankFindings, computeBaselines } from "../runner.js";
import {
  DETECTORS,
  editRetryLoop,
  toolErrorCluster,
  costOutlier,
  apiErrorStall,
  contextChurn,
  findEditRetryRun,
  diagnoseCauses,
} from "../detectors/index.js";

// ---------- fixtures ----------

let nextId = 0;

function call(over: Partial<DetectionToolCall> = {}): DetectionToolCall {
  return { name: "Bash", status: "ok", isEdit: 0, file: null, errorSignature: null, ...over };
}
const editOk = (file: string) => call({ name: "Edit", isEdit: 1, file });
const editFail = (file: string) => call({ name: "Edit", isEdit: 1, file, status: "error", errorSignature: "old_string not found" });

/** A session with sane defaults; every field overridable. Tool calls land one
 * per assistant turn so turnIndex evidence is meaningful. */
function sess(over: Partial<DetectionSession> & { calls?: DetectionToolCall[] } = {}): DetectionSession {
  const { calls = [], ...rest } = over;
  return {
    id: `s-${nextId++}`,
    actorId: null,
    project: "/home/dev/acme",
    startedAt: "2026-07-01T10:00:00.000Z",
    endedAt: "2026-07-01T11:00:00.000Z",
    models: ["claude-opus-4-8"],
    costUsd: 1,
    tokens: { input: 1000, output: 1000, cacheRead: 100_000, cacheCreation: 2000 },
    isSubagent: 0,
    turns: calls.map((c, i) => ({ index: i, role: "assistant", ts: null, toolCalls: [c] })),
    events: [],
    ...rest,
  };
}

/** A corpus whose p95 cost ≈ $1 (twenty $1 sessions) to anchor baselines. */
function baselineCorpus(): DetectionSession[] {
  return Array.from({ length: 20 }, () => sess({ costUsd: 1 }));
}

function cfg(sessions: DetectionSession[]): ResolvedConfig {
  return resolveConfig(sessions, {});
}

// ---------- edit-retry-loop ----------

describe("edit-retry-loop", () => {
  it("fires on ≥3 consecutive failed edits to one file, with $ from the loop's token share", () => {
    // 10 calls total, 3 in the loop → cost = (totalTokens/10 calls)×3 × $/token
    const calls = [
      ...Array.from({ length: 7 }, () => call()),
      editFail("/repo/src/a.ts"),
      editFail("/repo/src/a.ts"),
      editFail("/repo/src/a.ts"),
    ];
    const s = sess({ calls, costUsd: 10 });
    const findings = editRetryLoop.run([s], cfg([s]));
    expect(findings).toHaveLength(1);
    const f = findings[0]!;
    expect(f.summary).toBe("Agent retried the same edit to a.ts 3× in a row without success");
    expect(f.sessionIds).toEqual([s.id]);
    expect(f.evidence).toEqual([{ sessionId: s.id, turnIndex: 7, note: "/repo/src/a.ts" }]);
    // totalTokens=104000, 10 calls → 10400 tokens/call × 3 = 31200; $/tok = 10/104000
    expect(f.costUsd).toBeCloseTo((10 / 104_000) * 10_400 * 3, 2);
  });

  it("does NOT fire when a success interrupts the run, on <3 fails, or across different files", () => {
    const interrupted = sess({ calls: [editFail("/a.ts"), editFail("/a.ts"), editOk("/a.ts"), editFail("/a.ts"), editFail("/a.ts")] });
    const twoFails = sess({ calls: [editFail("/a.ts"), editFail("/a.ts")] });
    const spread = sess({ calls: [editFail("/a.ts"), editFail("/b.ts"), editFail("/c.ts")] });
    expect(editRetryLoop.run([interrupted, twoFails, spread], cfg([interrupted, twoFails, spread]))).toEqual([]);
  });

  it("findEditRetryRun reports the worst run and its first turn", () => {
    const s = sess({ calls: [editFail("/a.ts"), editOk("/a.ts"), editFail("/b.ts"), editFail("/b.ts"), editFail("/b.ts"), editFail("/b.ts")] });
    expect(findEditRetryRun(s)).toEqual({ file: "/b.ts", fails: 4, turn: 2 });
    expect(findEditRetryRun(sess({ calls: [call(), editOk("/a.ts")] }))).toBeNull();
  });
});

// ---------- cost-outlier (the behavioral gate) ----------

describe("cost-outlier", () => {
  it("stays SILENT on an expensive session with no waste cause (long ≠ wasteful)", () => {
    // 100× the p95, but clean: no errors, healthy cache, no api errors
    const big = sess({ costUsd: 100, calls: Array.from({ length: 30 }, () => call()) });
    const corpus = [...baselineCorpus(), big];
    expect(costOutlier.run(corpus, cfg(corpus))).toEqual([]);
  });

  it("fires on expensive + API-error burst, pricing the overage above p95", () => {
    const runaway = sess({
      costUsd: 51,
      project: "/home/dev/acme",
      events: Array.from({ length: 5 }, () => ({ type: "api_error", ts: null })),
    });
    const corpus = [...baselineCorpus(), runaway];
    const config = cfg(corpus);
    const findings = costOutlier.run(corpus, config);
    expect(findings).toHaveLength(1);
    const f = findings[0]!;
    expect(f.summary).toContain("5 API errors");
    expect(f.summary).toContain(`$51.00`);
    expect(f.costUsd).toBeCloseTo(51 - config.baselines.costP95, 2);
    expect(f.suggestion).toContain("API errors");
  });

  it("fires on cache-thrash (creation > read at scale) — the $6k-bill shape", () => {
    const thrash = sess({ costUsd: 40, tokens: { input: 5000, output: 5000, cacheRead: 1_000_000, cacheCreation: 8_000_000 } });
    const corpus = [...baselineCorpus(), thrash];
    const findings = costOutlier.run(corpus, cfg(corpus));
    expect(findings).toHaveLength(1);
    expect(findings[0]!.summary).toContain("rebuilt 8.0M cache tokens but read only 1.0M");
  });

  it("does NOT fire on cheap sessions even with causes present", () => {
    const cheapButNoisy = sess({ costUsd: 1, events: Array.from({ length: 9 }, () => ({ type: "api_error", ts: null })) });
    const corpus = [...baselineCorpus(), cheapButNoisy];
    expect(costOutlier.run(corpus, cfg(corpus))).toEqual([]);
  });

  it("diagnoseCauses names every co-occurring cause in order", () => {
    const s = sess({
      costUsd: 60,
      calls: [
        ...Array.from({ length: 17 }, () => call({ status: "error", errorSignature: "boom" })),
        editFail("/x.ts"), editFail("/x.ts"), editFail("/x.ts"),
      ],
      tokens: { input: 1000, output: 1000, cacheRead: 500_000, cacheCreation: 2_000_000 },
      events: [{ type: "api_error", ts: null }, { type: "api_error", ts: null }, { type: "api_error", ts: null }],
    });
    expect(diagnoseCauses(s).map((c) => c.key)).toEqual(["edit-retry", "api-errors", "error-storm", "cache-thrash"]);
  });
});

// ---------- tool-error-cluster ----------

describe("tool-error-cluster", () => {
  const failingCall = () => call({ name: "Bash", status: "error", errorSignature: "unknown flag: --limit" });

  it("fires when one signature recurs ≥5× across ≥3 sessions, with occurrence math in the summary", () => {
    const sessions = [
      sess({ calls: [failingCall(), failingCall()] }),
      sess({ calls: [failingCall(), failingCall()] }),
      sess({ calls: [failingCall()] }),
    ];
    const findings = toolErrorCluster.run(sessions, cfg(sessions));
    expect(findings).toHaveLength(1);
    const f = findings[0]!;
    expect(f.summary).toContain('Bash keeps failing with "unknown flag: --limit"');
    expect(f.summary).toContain("5× in 3 sessions");
    expect(f.sessionIds).toEqual(sessions.map((s) => s.id));
  });

  it("does NOT fire below either threshold (4 occurrences, or 5 across only 2 sessions)", () => {
    const four = [sess({ calls: [failingCall(), failingCall()] }), sess({ calls: [failingCall()] }), sess({ calls: [failingCall()] })];
    const twoSessions = [sess({ calls: [failingCall(), failingCall(), failingCall()] }), sess({ calls: [failingCall(), failingCall()] })];
    expect(toolErrorCluster.run(four, cfg(four))).toEqual([]);
    expect(toolErrorCluster.run(twoSessions, cfg(twoSessions))).toEqual([]);
  });

  it("reports the cross-developer count when ≥2 actors are affected", () => {
    const sessions = [
      sess({ actorId: "dev-a", calls: [failingCall(), failingCall()] }),
      sess({ actorId: "dev-b", calls: [failingCall(), failingCall()] }),
      sess({ actorId: "dev-a", calls: [failingCall()] }),
    ];
    expect(toolErrorCluster.run(sessions, cfg(sessions))[0]!.summary).toContain("across 2 developers");
  });
});

// ---------- api-error-stall ----------

describe("api-error-stall", () => {
  it("fires at ≥3 api_error events with the count in the summary; not at 2", () => {
    const stalled = sess({ events: [{ type: "api_error", ts: "2026-07-01T10:01:00.000Z" }, { type: "api_error", ts: null }, { type: "api_error", ts: null }] });
    const okay = sess({ events: [{ type: "api_error", ts: null }, { type: "api_error", ts: null }] });
    const findings = apiErrorStall.run([stalled, okay], cfg([stalled, okay]));
    expect(findings).toHaveLength(1);
    expect(findings[0]!.summary).toBe("3 API errors in one session — stalled retrying, not progressing");
    expect(findings[0]!.sessionIds).toEqual([stalled.id]);
    expect(findings[0]!.costUsd).toBeNull();
  });
});

// ---------- context-churn ----------

describe("context-churn", () => {
  it("fires at ≥2 compactions; a single compaction (normal long work) stays silent", () => {
    const churning = sess({ events: [{ type: "compaction", ts: null }, { type: "compaction", ts: null }, { type: "compaction", ts: null }] });
    const normal = sess({ events: [{ type: "compaction", ts: null }] });
    const findings = contextChurn.run([churning, normal], cfg([churning, normal]));
    expect(findings).toHaveLength(1);
    expect(findings[0]!.summary).toBe("3 context compactions — the session repeatedly outgrew its window");
    expect(findings[0]!.sessionIds).toEqual([churning.id]);
  });
});

// ---------- runner ----------

describe("runner", () => {
  it("registry ships exactly the 5 validated detectors", () => {
    expect(DETECTORS.map((d) => d.id)).toEqual([
      "edit-retry-loop",
      "tool-error-cluster",
      "cost-outlier",
      "api-error-stall",
      "context-churn",
    ]);
  });

  it("rankFindings orders by $ desc (nulls last), then severity, then breadth", () => {
    const f = (over: Record<string, unknown>) => ({
      detectorId: "x", severity: "info" as const, sessionIds: ["a"], summary: "", evidence: [], costUsd: null, timeMin: null, ...over,
    });
    const ranked = rankFindings([
      f({ detectorId: "cheap", costUsd: 1 }),
      f({ detectorId: "null-high", severity: "high" }),
      f({ detectorId: "null-info-wide", sessionIds: ["a", "b"] }),
      f({ detectorId: "null-info" }),
      f({ detectorId: "rich", costUsd: 50 }),
    ]);
    expect(ranked.map((x) => x.detectorId)).toEqual(["rich", "cheap", "null-high", "null-info-wide", "null-info"]);
  });

  it("computeBaselines: p95 cost via linear interpolation over priced sessions", () => {
    const sessions = Array.from({ length: 100 }, (_, i) => sess({ costUsd: i + 1 })); // $1..$100
    expect(computeBaselines(sessions).costP95).toBeCloseTo(95.05, 2);
  });

  it("isolates a throwing detector: others still report, onError sees the failure", () => {
    const bomb = { ...editRetryLoop, id: "bomb", run: () => { throw new Error("kaboom"); } };
    const s = sess({ events: [{ type: "api_error", ts: null }, { type: "api_error", ts: null }, { type: "api_error", ts: null }] });
    const errors: string[] = [];
    const findings = runDetectors([bomb, apiErrorStall], [s], {}, (id, err) => errors.push(`${id}:${(err as Error).message}`));
    expect(findings.map((x) => x.detectorId)).toEqual(["api-error-stall"]);
    expect(errors).toEqual(["bomb:kaboom"]);
  });
});
