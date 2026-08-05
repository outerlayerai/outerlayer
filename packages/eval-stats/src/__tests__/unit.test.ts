// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Magu Studios, Inc.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import {
  comb,
  invNormCdf,
  mcnemarExactP,
  wilsonInterval,
  zForAlpha,
  zForPower,
} from "../math.js";
import { mde, tasksNeeded } from "../mde.js";
import { buildPairing, majorityResolved } from "../pairing.js";
import { passAtKUnbiased, passHatKUnbiased } from "../passk.js";
import { DEFAULT_RESAMPLES, reportStats } from "../report.js";
import { buildTrials, trial } from "./fixtures.js";

describe("invNormCdf", () => {
  test("matches standard normal quantiles", () => {
    // z_{0.975} and z_{0.80} are the constants the whole power analysis rests on.
    expect(invNormCdf(0.975)).toBeCloseTo(1.959963985, 7);
    expect(invNormCdf(0.8)).toBeCloseTo(0.841621234, 7);
    expect(invNormCdf(0.5)).toBeCloseTo(0, 10);
    expect(invNormCdf(0.99)).toBeCloseTo(2.326347874, 7);
  });

  test("is antisymmetric about 0.5", () => {
    expect(invNormCdf(0.1)).toBeCloseTo(-invNormCdf(0.9), 9);
    expect(invNormCdf(0.025)).toBeCloseTo(-invNormCdf(0.975), 9);
  });

  test("z helpers wrap the quantiles", () => {
    expect(zForAlpha(0.05)).toBeCloseTo(1.959963985, 7);
    expect(zForPower(0.8)).toBeCloseTo(0.841621234, 7);
  });
});

describe("wilsonInterval", () => {
  test("pins the exact interval for 8/10", () => {
    const w = wilsonInterval(8, 10);
    expect(w.value).toBe(0.8);
    expect(w.ci95[0]).toBeCloseTo(0.4901624713, 9);
    expect(w.ci95[1]).toBeCloseTo(0.9433178486, 9);
  });

  test("is symmetric at p̂ = 0.5 and clamps at the boundaries", () => {
    const half = wilsonInterval(5, 10);
    expect(half.value).toBe(0.5);
    expect((half.ci95[0] + half.ci95[1]) / 2).toBeCloseTo(0.5, 12);

    const none = wilsonInterval(0, 10);
    expect(none.value).toBe(0);
    expect(none.ci95[0]).toBeCloseTo(0, 12); // lower bound is 0 (mod FP dust)
    expect(none.ci95[0]).toBeGreaterThanOrEqual(0); // clamped, never negative
    expect(none.ci95[1]).toBeGreaterThan(0);

    const all = wilsonInterval(10, 10);
    expect(all.value).toBe(1);
    expect(all.ci95[1]).toBe(1); // clamped, never > 1

    // No information with n = 0.
    expect(wilsonInterval(0, 0)).toEqual({ value: 0, ci95: [0, 1] });
  });
});

describe("mcnemarExactP", () => {
  test("gives exact two-sided binomial tail probabilities", () => {
    expect(mcnemarExactP(10, 0)).toBe(2 / 1024); // 0.001953125
    expect(mcnemarExactP(8, 1)).toBe(20 / 512); // 0.0390625
    expect(mcnemarExactP(3, 0)).toBe(0.25);
    expect(mcnemarExactP(2, 0)).toBe(0.5);
    expect(mcnemarExactP(0, 0)).toBe(1); // no discordance -> no evidence
    expect(mcnemarExactP(1, 0)).toBe(1); // 2 * 0.5, capped at 1
    expect(mcnemarExactP(5, 5)).toBe(1); // symmetric, capped at 1
  });

  test("is symmetric in its arguments", () => {
    expect(mcnemarExactP(0, 10)).toBe(mcnemarExactP(10, 0));
    expect(mcnemarExactP(2, 7)).toBe(mcnemarExactP(7, 2));
  });

  test("stays overflow-safe and monotone at large n", () => {
    expect(mcnemarExactP(100, 100)).toBe(1); // no overflow forming C(200,100)
    // A 70/30 split of 100 discordant pairs is significant; 55/45 is not.
    expect(mcnemarExactP(70, 30)).toBeLessThan(0.05);
    expect(mcnemarExactP(55, 45)).toBeGreaterThan(0.05);
    // More extreme discordance => smaller p.
    expect(mcnemarExactP(70, 30)).toBeLessThan(mcnemarExactP(65, 35));
    expect(mcnemarExactP(65, 35)).toBeLessThan(mcnemarExactP(60, 40));
  });
});

describe("comb / pass@k / pass^k", () => {
  test("binomial coefficients", () => {
    expect(comb(5, 2)).toBe(10);
    expect(comb(5, 0)).toBe(1);
    expect(comb(5, 5)).toBe(1);
    expect(comb(4, 2)).toBe(6);
    expect(comb(3, 5)).toBe(0);
    expect(comb(3, -1)).toBe(0);
  });

  test("unbiased pass@k = 1 − C(n−c,k)/C(n,k)", () => {
    expect(passAtKUnbiased(1, 3, 1)).toBeCloseTo(1 / 3, 12);
    expect(passAtKUnbiased(1, 3, 2)).toBeCloseTo(2 / 3, 12);
    expect(passAtKUnbiased(2, 5, 1)).toBeCloseTo(0.4, 12);
    expect(passAtKUnbiased(0, 3, 1)).toBe(0); // no successes
    expect(passAtKUnbiased(3, 3, 3)).toBe(1); // all succeed
    expect(passAtKUnbiased(2, 3, 3)).toBe(1); // fewer failures than draws
  });

  test("unbiased pass^k = C(c,k)/C(n,k)", () => {
    expect(passHatKUnbiased(2, 3, 2)).toBeCloseTo(1 / 3, 12);
    expect(passHatKUnbiased(1, 3, 2)).toBe(0); // fewer successes than draws
    expect(passHatKUnbiased(4, 4, 4)).toBe(1);
    expect(passHatKUnbiased(2, 4, 1)).toBeCloseTo(0.5, 12);
  });

  test("rejects k out of range", () => {
    expect(() => passAtKUnbiased(1, 3, 4)).toThrow(/1 <= k/);
    expect(() => passAtKUnbiased(1, 3, 0)).toThrow(/1 <= k/);
    expect(() => passHatKUnbiased(1, 3, 4)).toThrow(/1 <= k/);
  });
});

describe("mde and tasksNeeded", () => {
  test("closed-form MDE at 80% power", () => {
    // (z_{.025} + z_{.80}) * sqrt(0.25/200) = 2.801585 * 0.0353553.
    expect(mde({ nPairs: 200, discordanceRate: 0.25 })).toBeCloseTo(0.09905, 5);
  });

  test("is monotonically DECREASING in N (fixed discordance)", () => {
    const m30 = mde({ nPairs: 30, discordanceRate: 0.25 });
    const m80 = mde({ nPairs: 80, discordanceRate: 0.25 });
    const m200 = mde({ nPairs: 200, discordanceRate: 0.25 });
    expect(m30).toBeGreaterThan(m80);
    expect(m80).toBeGreaterThan(m200);
  });

  test("is INCREASING in discordance (fixed N)", () => {
    expect(mde({ nPairs: 100, discordanceRate: 0.3 })).toBeGreaterThan(
      mde({ nPairs: 100, discordanceRate: 0.2 }),
    );
  });

  test("degenerate inputs are finite-safe", () => {
    expect(mde({ nPairs: 0, discordanceRate: 0.25 })).toBe(Infinity);
    expect(mde({ nPairs: 100, discordanceRate: 0 })).toBe(0);
  });

  test("tasksNeeded reproduces the spec's power figures", () => {
    // 10pp gap needs ~150–250 paired tasks at discordance 0.2–0.3.
    expect(tasksNeeded(0.1, { discordanceRate: 0.2 })).toBe(157);
    expect(tasksNeeded(0.1, { discordanceRate: 0.25 })).toBe(197);
    expect(tasksNeeded(0.1, { discordanceRate: 0.3 })).toBe(236);
    // 15pp gap needs ~80–120.
    expect(tasksNeeded(0.15, { discordanceRate: 0.25 })).toBe(88);
    expect(tasksNeeded(0, { discordanceRate: 0.25 })).toBe(Infinity);
  });
});

describe("pairing", () => {
  test("strict majority over trials", () => {
    expect(majorityResolved(2, 3)).toBe(1);
    expect(majorityResolved(1, 3)).toBe(0);
    expect(majorityResolved(2, 2)).toBe(1);
    expect(majorityResolved(1, 2)).toBe(0); // tie is NOT a resolve
    expect(majorityResolved(0, 1)).toBe(0);
  });

  test("excludes asymmetric-missing tasks and reports them", () => {
    const trials = [
      trial({ taskId: "t0", config: "config-a", resolved: true }),
      trial({ taskId: "t0", config: "config-b", resolved: false }),
      // t1 has NO config-b trials -> asymmetric, excluded.
      trial({ taskId: "t1", config: "config-a", resolved: true }),
    ];
    const p = buildPairing(trials, "config-a", "config-b", false);
    expect(p.tasks.map((t) => t.taskId)).toEqual(["t0"]);
    expect(p.exclusions).toEqual([
      { taskId: "t1", reason: "asymmetric trials: no trials for config-b" },
    ]);
  });

  test("excludes tasks whose only trials were infra-failed / quarantined", () => {
    const trials = [
      trial({ taskId: "t0", config: "config-a", resolved: true }),
      trial({ taskId: "t0", config: "config-b", resolved: true }),
      trial({ taskId: "t1", config: "config-a", resolved: true }),
      trial({ taskId: "t1", config: "config-b", status: "infra_failed" }),
    ];
    const p = buildPairing(trials, "config-a", "config-b", false);
    expect(p.tasks.map((t) => t.taskId)).toEqual(["t0"]);
    expect(p.exclusions).toEqual([
      {
        taskId: "t1",
        reason: "no graded trials for config-b (infra-failed/quarantined)",
      },
    ]);
  });

  test("the sensitivity re-run imputes excluded tasks instead of dropping them", () => {
    const trials = [
      trial({ taskId: "t0", config: "config-a", resolved: true }),
      trial({ taskId: "t0", config: "config-b", resolved: false }),
      trial({ taskId: "t1", config: "config-a", resolved: true }), // missing b
    ];
    const inclusive = buildPairing(trials, "config-a", "config-b", true);
    expect(inclusive.tasks.map((t) => t.taskId)).toEqual(["t0", "t1"]);
    expect(inclusive.exclusions).toEqual([]);
    const t1 = inclusive.tasks.find((t) => t.taskId === "t1");
    expect(t1?.majB).toBe(0); // imputed as unresolved
    expect(t1?.nB).toBe(0);
  });
});

describe("verdict branches (deterministic fixtures)", () => {
  test("clear: CI excludes 0 AND |Δ| ≥ 0.8·MDE", () => {
    const rs = reportStats(buildTrials({ aOnly: 30, bOnly: 0, both: 60, neither: 10 }), {
      configA: "config-a",
      configB: "config-b",
      seed: 1,
      resamples: 4000,
    });
    expect(rs.verdict).toBe("clear");
    expect(rs.pairedDelta.est).toBe(0.3);
    expect(rs.pairedDelta.ci95).toEqual([0.21, 0.39]);
    expect(rs.pairedDelta.mcnemar).toEqual({ b: 30, c: 0, p: mcnemarExactP(30, 0) });
    expect(rs.verdictRules).toContain("excludes 0 and");
    expect(rs.verdictRules).toContain("favors config-a");
  });

  test("directional: CI includes 0 but ≥70% of discordant tasks agree", () => {
    const rs = reportStats(buildTrials({ aOnly: 4, bOnly: 1, both: 7, neither: 8 }), {
      configA: "config-a",
      configB: "config-b",
      seed: 1,
      resamples: 4000,
    });
    expect(rs.verdict).toBe("directional");
    expect(rs.pairedDelta.est).toBe(0.15);
    expect(rs.verdictRules).toContain(
      "80% of 5 discordant tasks favor config-a",
    );
  });

  test("underpowered: CI includes 0 and signal not consistent, with a prescription", () => {
    const rs = reportStats(buildTrials({ aOnly: 3, bOnly: 2, both: 5, neither: 10 }), {
      configA: "config-a",
      configB: "config-b",
      seed: 1,
      resamples: 4000,
    });
    expect(rs.verdict).toBe("underpowered");
    expect(rs.pairedDelta.est).toBe(0.05);
    expect(rs.verdictRules).toContain("includes 0");
    expect(rs.verdictRules).toMatch(/needs ~\d+ paired tasks/);
  });
});

describe("cost guard", () => {
  test("$/resolved is Infinity (never NaN) when a config resolves nothing", () => {
    // config-b resolves 0 tasks.
    const rs = reportStats(buildTrials({ aOnly: 6, bOnly: 0, both: 0, neither: 4 }), {
      configA: "config-a",
      configB: "config-b",
      seed: 1,
      resamples: 500,
    });
    expect(rs.dollarsPerResolved.b.resolves).toBe(0);
    expect(rs.dollarsPerResolved.b.perResolved).toBe(Infinity);
    expect(Number.isNaN(rs.dollarsPerResolved.b.perResolved)).toBe(false);
    expect(rs.dollarsPerResolved.a.perResolved).toBeGreaterThan(0);
    expect(Number.isFinite(rs.dollarsPerResolved.a.perResolved)).toBe(true);
  });
});

describe("package invariants", () => {
  test("production default is >= 10000 resamples", () => {
    expect(DEFAULT_RESAMPLES).toBe(10000);
    expect(DEFAULT_RESAMPLES).toBeGreaterThanOrEqual(10000);
  });

  test("zero runtime dependencies (enforced acceptance criterion)", () => {
    const pkgPath = fileURLToPath(new URL("../../package.json", import.meta.url));
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as {
      dependencies?: Record<string, string>;
    };
    expect(pkg.dependencies ?? {}).toEqual({});
  });
});
