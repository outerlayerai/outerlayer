// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Magu Studios, Inc.

import { describe, expect, test } from "vitest";
import { classifyStack } from "../matrix.js";
import { buildRepoReport, type RepoReportInputs } from "../report.js";
import { renderReportHtml, renderReportText } from "../render.js";

function inputs(over: Partial<RepoReportInputs> = {}): RepoReportInputs {
  return {
    repo: "github.com/acme/widget",
    headCommit: "4f2a91cdeef",
    stack: { support: "supported", reason: "python/pytest" },
    mining: {
      prsScanned: 400,
      candidates: 40,
      validated: 28,
      rejectedByReason: { no_tests: 6, gold_fails: 3, too_large: 2, leak: 1 },
      yieldPct: 0.07,
    },
    env: { total: 28, deterministic: 24, repaired: 3, escalated: 1, cacheHitRate: 0.86 },
    validation: { valid: 28, needsReview: 2, invalid: 4, quarantinedTests: ["tests/test_x.py::test_flaky"] },
    power: [
      { trials: 1, mdePct: 16 },
      { trials: 3, mdePct: 11 },
      { trials: 5, mdePct: 9 },
    ],
    cost: { lowUsd: 40, highUsd: 90, note: "28 tasks × 2 configs × 3 trials, measured canary averages" },
    ...over,
  };
}

describe("classifyStack", () => {
  test("supported / partial / not-yet by language, runner, and trait", () => {
    expect(classifyStack({ language: "Python", runner: "pytest", traits: [] })).toEqual({
      support: "supported",
      reason: "python/pytest",
    });
    expect(classifyStack({ language: "TypeScript", runner: "vitest", traits: ["monorepo"] })).toEqual({
      support: "partial",
      reason: "monorepo — supported per-workspace; scope the report to one package",
    });
    expect(classifyStack({ language: "Go", runner: "go test", traits: [] }).support).toBe("not_yet");
    expect(classifyStack({ language: "Python", runner: "pytest", traits: ["bazel"] })).toEqual({
      support: "not_yet",
      reason: "hermetic build systems (bazel) aren't supported yet",
    });
    expect(classifyStack({ language: "python", runner: "nose", traits: [] }).support).toBe("not_yet");
  });
});

describe("buildRepoReport banner logic", () => {
  test("Ready when validated ≥ floor, env buildable, supported stack", () => {
    const report = buildRepoReport(inputs());
    expect(report.banner).toBe("ready");
    expect(report.bannerReason).toContain("28 validated tasks");
    expect(report.nextStep).toContain("Run a Report Card");
  });

  test("Ready with caveats when below the task floor (specifics stated)", () => {
    const report = buildRepoReport(inputs({ validation: { valid: 12, needsReview: 1, invalid: 2, quarantinedTests: [] }, readyFloor: 20 }));
    expect(report.banner).toBe("ready_with_caveats");
    expect(report.bannerReason).toContain("only 12 validated tasks");
    expect(report.nextStep).toContain("underpowered");
  });

  test("partial stack (monorepo) forces caveats even above the floor", () => {
    const report = buildRepoReport(inputs({ stack: { support: "partial", reason: "monorepo — scope to one package" } }));
    expect(report.banner).toBe("ready_with_caveats");
    expect(report.bannerReason).toContain("monorepo");
  });

  test("not-yet stack short-circuits to a waitlist next step", () => {
    const report = buildRepoReport(inputs({ stack: { support: "not_yet", reason: "Go is a fast-follow candidate, not supported yet" } }));
    expect(report.banner).toBe("not_yet");
    expect(report.nextStep).toContain("waitlist");
  });

  test("zero validated tasks ⇒ not-yet with a diagnosis, not a stack trace", () => {
    const report = buildRepoReport(
      inputs({
        validation: { valid: 0, needsReview: 0, invalid: 8, quarantinedTests: [] },
        mining: { prsScanned: 200, candidates: 10, validated: 0, rejectedByReason: { no_tests: 8, too_large: 2 }, yieldPct: 0 },
      }),
    );
    expect(report.banner).toBe("not_yet");
    expect(report.nextStep).toContain("add tests");
  });

  test("escalated-only env (all builds failed) blocks Ready", () => {
    const report = buildRepoReport(
      inputs({ env: { total: 28, deterministic: 0, repaired: 0, escalated: 28, cacheHitRate: 0 } }),
    );
    expect(report.banner).not.toBe("ready");
  });
});

describe("renderers", () => {
  test("terminal render surfaces banner, funnel, MDE line, and next step", () => {
    const text = renderReportText(buildRepoReport(inputs()));
    expect(text).toContain("Ready");
    expect(text).toContain("400 PRs scanned → 40 candidates → 28 validated");
    expect(text).toContain("MDE ≈ 11pp");
    expect(text).toContain("→ Run a Report Card");
  });

  test("powerNote (the stated MDE assumption) renders in both formats — and only when set", () => {
    const note = "Pre-run estimate at 80% power, assuming single-trial discordance 0.25.";
    const withNote = buildRepoReport(inputs({ powerNote: note }));
    expect(withNote.powerNote).toBe(note);
    expect(renderReportText(withNote)).toContain(note);
    expect(renderReportHtml(withNote)).toContain("discordance 0.25");

    const without = buildRepoReport(inputs());
    expect(without.powerNote).toBeUndefined();
    expect(renderReportText(without)).not.toContain("discordance");
  });

  test("HTML is self-contained (no external asset references) and escapes repo/reason", () => {
    const html = renderReportHtml(
      buildRepoReport(inputs({ repo: "github.com/acme/<script>evil</script>" })),
    );
    expect(html).toContain("<!doctype html>");
    // No external assets — the forwardable-artifact guarantee.
    expect(html).not.toMatch(/src=["']https?:/);
    expect(html).not.toMatch(/href=["']https?:/);
    expect(html).not.toContain("<script>evil");
    expect(html).toContain("&lt;script&gt;evil");
    expect(html).toContain("28 validated");
  });
});
