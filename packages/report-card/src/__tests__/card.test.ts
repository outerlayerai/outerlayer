// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Magu Studios, Inc.

import { describe, expect, test } from "vitest";
import { buildReportCard, type CardInputs, type CardStats, type Verdict } from "../card.js";
import { assertCardIntegrity, CardIntegrityError, namesWinner } from "../integrity.js";
import { renderCardHtml, renderCardText } from "../render.js";

function stats(over: Partial<CardStats> = {}): CardStats {
  return {
    configs: ["opus", "glm-5.2"],
    nTasks: 84,
    trialsPerTask: 3,
    resolveRate: { a: { rate: 0.62, ci95: [0.52, 0.71] }, b: { rate: 0.58, ci95: [0.48, 0.68] } },
    pairedDelta: { est: 0.04, ci95: [-0.05, 0.13] },
    dollarsPerResolved: { a: 0.42, b: 0.13, ratioCi95: [0.25, 0.36] },
    totalCostUsd: 37.4,
    mde: { at80Power: 0.11, note: "assumed discordance 0.25" },
    verdict: "directional",
    verdictRules: "CI includes 0 but sign consistent across ≥70% of paired tasks",
    exclusions: [{ taskId: "t-42", reason: "infra_error" }],
    sensitivity: { excludedFlippedConclusion: false },
    ...over,
  };
}

function inputs(over: Partial<CardInputs> = {}): CardInputs {
  return {
    repoLabel: "acme/payments",
    stats: stats(),
    taxonomy: [
      { configId: "opus", counts: { agent_error: 3, timeout: 1 } },
      { configId: "glm-5.2", counts: { agent_error: 8, patch_apply_failed: 2 } },
    ],
    divergent: [{ taskId: "t-7", resolvedByA: true, resolvedByB: false }],
    perTask: [{ taskId: "t-1", aResolved: 3, bResolved: 2, trials: 3, aCostUsd: 0.4, bCostUsd: 0.12 }],
    quarantinedTests: ["tests/test_x.py::test_flaky"],
    methodologyUrl: "https://outerlayer.ai/docs/methodology",
    ...over,
  };
}

describe("buildReportCard", () => {
  test("clear verdict headlines the winner with kept-rate and cost ratio, N, and tier", () => {
    const card = buildReportCard(
      inputs({
        stats: stats({
          verdict: "clear",
          pairedDelta: { est: 0.06, ci95: [0.02, 0.11] },
          resolveRate: { a: { rate: 0.64, ci95: [0.55, 0.72] }, b: { rate: 0.58, ci95: [0.49, 0.66] } },
        }),
      }),
    );
    expect(card.verdict).toBe("clear");
    // Delta is positive (A − B) ⇒ config A (opus) is better.
    expect(card.conclusion).toContain("opus resolves +6pp more than glm-5.2");
    expect(card.conclusion).toContain("N=84");
    expect(card.conclusion).toContain("clear result");
    expect(card.mdeLine).toBe("This run can detect differences ≥ 11pp; observed |Δ| = 6pp.");
  });

  test("underpowered verdict never names a winner and prescribes", () => {
    const card = buildReportCard(inputs({ stats: stats({ verdict: "underpowered" }) }));
    expect(namesWinner(card)).toBe(false);
    expect(card.conclusion).toContain("underpowered");
    expect(card.conclusion).toContain("more tasks/trials");
  });
});

describe("requested-vs-ran task disclosure (clamp echo)", () => {
  test("carries requestedTasks and discloses the gap in both renders when the run was capped", () => {
    const card = buildReportCard(inputs({ stats: stats({ nTasks: 5 }), requestedTasks: 20 }));
    expect(card.requestedTasks).toBe(20);
    expect(renderCardText(card)).toContain("requested 20 tasks; ran 5 (capped to the available task set)");
    expect(renderCardHtml(card)).toContain("Requested 20 tasks; ran 5 (capped to the available task set).");
  });

  test("drops requestedTasks (no disclosure) when the full requested set ran", () => {
    const exact = buildReportCard(inputs({ stats: stats({ nTasks: 20 }), requestedTasks: 20 }));
    expect(exact.requestedTasks).toBeUndefined();
    expect(renderCardText(exact)).not.toContain("capped to the available task set");

    const unset = buildReportCard(inputs({ stats: stats({ nTasks: 5 }) }));
    expect(unset.requestedTasks).toBeUndefined();
    expect(renderCardHtml(unset)).not.toContain("capped to the available task set");
  });
});

describe("integrity lint", () => {
  test("terminal + HTML renders both carry the tier chip and the MDE line", () => {
    const card = buildReportCard(inputs({ stats: stats({ verdict: "clear", pairedDelta: { est: 0.06, ci95: [0.02, 0.11] } }) }));
    const text = renderCardText(card);
    const html = renderCardHtml(card);
    for (const out of [text, html]) {
      expect(out).toContain("Clear result");
      expect(out).toContain("can detect differences ≥ 11pp");
    }
    // Disclosures present: exclusions + quarantine.
    expect(text).toContain("exclusions: t-42");
    expect(html).toContain("Quarantined");
  });

  test("assertCardIntegrity throws if a rendered winner drops the MDE line", () => {
    const card = buildReportCard(inputs({ stats: stats({ verdict: "clear", pairedDelta: { est: 0.06, ci95: [0.02, 0.11] } }) }));
    const noMde = `[Clear result] opus wins`; // tier present, MDE missing
    expect(() => assertCardIntegrity(card, noMde)).toThrow(CardIntegrityError);
    expect(() => assertCardIntegrity(card, noMde)).toThrow(/omits the MDE line/);
  });

  test("assertCardIntegrity throws if the tier chip is dropped", () => {
    const card = buildReportCard(inputs());
    const noTier = `opus resolves more; this run can detect differences ≥ 11pp`;
    expect(() => assertCardIntegrity(card, noTier)).toThrow(/omits the verdict tier/);
  });

  test("underpowered card render throws if 'underpowered' is scrubbed from output", () => {
    const card = buildReportCard(inputs({ stats: stats({ verdict: "underpowered" }) }));
    // A hand-built rendering that hides the prescription.
    const scrubbed = `[Underpowered]\nThis run can detect differences ≥ 11pp; observed |Δ| = 4pp.`
      .replace(/Underpowered/g, "Result");
    expect(() => assertCardIntegrity(card, scrubbed)).toThrow(/verdict tier/);
  });

  test("HTML is self-contained and escapes config ids", () => {
    const card = buildReportCard(inputs({ stats: stats({ configs: ["opus", "<img src=x>"] }), repoLabel: "acme/x" }));
    const html = renderCardHtml(card);
    expect(html).toContain("<!doctype html>");
    expect(html).not.toMatch(/src=["']https?:/);
    expect(html).not.toContain("<img src=x>");
    expect(html).toContain("&lt;img src=x&gt;");
  });
});
