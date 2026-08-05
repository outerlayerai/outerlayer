// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Magu Studios, Inc.

import { describe, expect, it } from "vitest";
import type { Finding } from "../types.js";
import type { WeeklyRollup } from "../digest/index.js";
import { composeDigest, renderDigestEmail, renderDigestSlack } from "../digest/index.js";

// ---------- fixtures ----------

function finding(over: Partial<Finding> & { detectorId: string }): Finding {
  return {
    severity: "warn",
    sessionIds: ["s-1"],
    summary: `${over.detectorId} fired`,
    evidence: [{ sessionId: "s-1" }],
    costUsd: null,
    timeMin: null,
    ...over,
  };
}

function week(over: Partial<WeeklyRollup> = {}): WeeklyRollup {
  return {
    periodStart: "2026-06-29",
    periodEnd: "2026-07-05",
    sessions: 40,
    costUsd: 260,
    toolCalls: 500,
    toolErrors: 32,
    activeActors: 8,
    ...over,
  };
}

const priorWeek = (over: Partial<WeeklyRollup> = {}): WeeklyRollup =>
  week({ periodStart: "2026-06-22", periodEnd: "2026-06-28", sessions: 32, costUsd: 200, toolCalls: 400, toolErrors: 20, ...over });

/** The canonical two-week fixture: spend +30%, error rate +28%, actors flat. */
function pairInput() {
  const fCost = finding({
    detectorId: "cost-outlier",
    severity: "warn",
    sessionIds: ["s-1", "s-2"],
    summary: "acme session cost $120.00 (12× the team's p95) — 6 API errors",
    costUsd: 80,
    suggestion: "Check the top recurring error.",
  });
  const fLoop = finding({
    detectorId: "edit-retry-loop",
    sessionIds: ["s-3"],
    summary: "Agent retried the same edit to db.ts 5× in a row without success",
    costUsd: 45.5,
    timeMin: 20,
  });
  const fChurn = finding({
    detectorId: "context-churn",
    severity: "info",
    sessionIds: ["s-4"],
    summary: "4 context compactions — the session repeatedly outgrew its window",
    costUsd: 12,
  });
  const fCluster = finding({
    detectorId: "tool-error-cluster",
    severity: "high",
    sessionIds: ["s-1", "s-3", "s-4"],
    summary: 'Bash keeps failing with "unknown flag: --limit"',
    costUsd: null,
  });
  return {
    tenantName: "Acme Robotics",
    deepLinkBase: "https://app.outerlayer.dev/t/acme",
    current: week(),
    prior: priorWeek(),
    // Scrambled on purpose: compose must re-rank ($ desc, nulls last).
    findings: [fChurn, fCluster, fCost, fLoop],
    priorFindings: [
      finding({ detectorId: "cost-outlier", sessionIds: ["p-1"], costUsd: 60 }),
      finding({ detectorId: "context-churn", sessionIds: ["p-2"], costUsd: null }),
    ],
  };
}

// ---------- composeDigest ----------

describe("composeDigest", () => {
  it("composes the full model for a week pair: deltas, ranked top findings, WoW dollars, watch-this", () => {
    expect(composeDigest(pairInput())).toEqual({
      tenantName: "Acme Robotics",
      periodStart: "2026-06-29",
      periodEnd: "2026-07-05",
      tiles: {
        sessions: { current: 40, prior: 32, deltaPct: 25 },
        costUsd: { current: 260, prior: 200, deltaPct: 30 },
        // Rates are fractions of toolErrors/toolCalls; delta rounded to 2dp.
        toolErrorRate: { current: 32 / 500, prior: 20 / 400, deltaPct: 28 },
        activeActors: { current: 8, prior: 8, deltaPct: 0 },
      },
      topFindings: [
        // $80 beats $45.50 beats $12; the null-cost high-severity cluster
        // ranks last and falls out of the top 3 (dollars lead, not labels).
        {
          detectorId: "cost-outlier",
          severity: "warn",
          summary: "acme session cost $120.00 (12× the team's p95) — 6 API errors",
          costUsd: 80,
          sessionCount: 2,
          wowDelta: 20,
        },
        {
          detectorId: "edit-retry-loop",
          severity: "warn",
          summary: "Agent retried the same edit to db.ts 5× in a row without success",
          costUsd: 45.5,
          sessionCount: 1,
          wowDelta: null, // no prior finding from this detector
        },
        {
          detectorId: "context-churn",
          severity: "info",
          summary: "4 context compactions — the session repeatedly outgrew its window",
          costUsd: 12,
          sessionCount: 1,
          wowDelta: null, // prior match exists but had no honest $ figure
        },
      ],
      watchThis: "Spend is up 30% week over week ($200.00 → $260.00) — worth a look before it compounds.",
      deepLinkBase: "https://app.outerlayer.dev/t/acme",
    });
  });

  it("returns null on a quiet week (< 3 sessions) and composes at exactly 3", () => {
    expect(composeDigest({ ...pairInput(), current: week({ sessions: 2 }) })).toBeNull();
    const atFloor = composeDigest({ ...pairInput(), current: week({ sessions: 3 }) });
    expect(atFloor?.tiles.sessions.current).toBe(3);
  });

  it("first week is a baseline week: priors and deltas null everywhere, no watch-this", () => {
    const model = composeDigest({ ...pairInput(), prior: null, priorFindings: [] });
    expect(model?.tiles).toEqual({
      sessions: { current: 40, prior: null, deltaPct: null },
      costUsd: { current: 260, prior: null, deltaPct: null },
      toolErrorRate: { current: 32 / 500, prior: null, deltaPct: null },
      activeActors: { current: 8, prior: null, deltaPct: null },
    });
    expect(model?.topFindings.map((f) => f.wowDelta)).toEqual([null, null, null]);
    // No prior week → no comparative claim, even though every finding is "new".
    expect(model?.watchThis).toBeNull();
  });

  it("deltaPct is null (not Infinity) when the prior value was 0", () => {
    const model = composeDigest({
      ...pairInput(),
      prior: priorWeek({ costUsd: 0, toolCalls: 0, toolErrors: 0 }),
    });
    expect(model?.tiles.costUsd).toEqual({ current: 260, prior: 0, deltaPct: null });
    expect(model?.tiles.toolErrorRate).toEqual({ current: 32 / 500, prior: 0, deltaPct: null });
  });

  it("watch-this picks the error-rate spike when it is the largest adverse delta", () => {
    // Spend +5% (below threshold), error rate 5% → 10% (+100%).
    const model = composeDigest({
      ...pairInput(),
      current: week({ costUsd: 210, toolCalls: 500, toolErrors: 50 }),
    });
    expect(model?.watchThis).toBe(
      "Tool error rate is up 100% week over week (5.0% → 10.0%) — one recurring failure usually explains most of it.",
    );
  });

  it("watch-this tie-break: equal spikes read as cost, never error rate", () => {
    // Both spend and error rate up exactly 50%.
    const model = composeDigest({
      ...pairInput(),
      current: week({ costUsd: 300, toolCalls: 480, toolErrors: 36 }),
    });
    expect(model?.watchThis).toBe(
      "Spend is up 50% week over week ($200.00 → $300.00) — worth a look before it compounds.",
    );
  });

  it("watch-this falls back to a brand-new top finding when nothing crossed 25%", () => {
    const input = pairInput();
    const model = composeDigest({
      ...input,
      current: week({ costUsd: 210, toolErrors: 21, toolCalls: 400 }), // +5% spend, flat rate
      priorFindings: [finding({ detectorId: "context-churn", costUsd: 5 })], // top finding unseen last week
    });
    expect(model?.watchThis).toBe(
      "New this week: acme session cost $120.00 (12× the team's p95) — 6 API errors.",
    );
  });

  it("watch-this is null when nothing is adverse — a rise of exactly 25% does not qualify", () => {
    const model = composeDigest({
      ...pairInput(),
      current: week({ costUsd: 250, toolErrors: 25, toolCalls: 500 }), // spend +25%, rate flat
    });
    expect(model?.tiles.costUsd.deltaPct).toBe(25);
    expect(model?.watchThis).toBeNull();
  });
});

// ---------- renderDigestEmail ----------

describe("renderDigestEmail", () => {
  it("escapes every interpolated string — HTML in a finding summary arrives as entities", () => {
    const input = pairInput();
    input.tenantName = "Acme & Co";
    input.findings[2]!.summary = 'Agent looped on <b>db.ts & auth.ts</b> edits with "--force"';
    const html = renderDigestEmail(composeDigest(input)!);
    expect(html).toContain("Agent looped on &lt;b&gt;db.ts &amp; auth.ts&lt;/b&gt; edits with &quot;--force&quot;");
    expect(html).not.toContain("<b>db.ts");
    expect(html).toContain("Acme &amp; Co");
    expect(html).not.toContain("Acme & Co");
  });

  it("golden content: tile values, WoW deltas, finding meta line, watch-this, deep links", () => {
    const html = renderDigestEmail(composeDigest(pairInput())!);
    expect(html).toContain("$260.00"); // spend tile leads with dollars
    expect(html).toContain("▲ 30% WoW");
    expect(html).toContain("6.4%"); // error-rate tile as a percentage
    expect(html).toContain("▲ 28% WoW");
    expect(html).toContain("$80.00 · 2 sessions · ▲ $20.00 WoW"); // finding meta incl. WoW dollars
    expect(html).toContain("Spend is up 30% week over week ($200.00 → $260.00) — worth a look before it compounds.");
    expect(html).toContain('href="https://app.outerlayer.dev/t/acme/agents/overview"');
    expect(html).toContain('href="https://app.outerlayer.dev/t/acme/agents/findings"');
    expect(html).toContain("Jun 29, 2026 – Jul 5, 2026");
  });

  it("baseline week says so in prose instead of showing deltas", () => {
    const html = renderDigestEmail(composeDigest({ ...pairInput(), prior: null, priorFindings: [] })!);
    expect(html).toContain("baseline week");
    expect(html).not.toContain("% WoW");
  });
});

// ---------- renderDigestSlack ----------

type Block = { type: string; text?: { type: string; text: string }; fields?: { type: string; text: string }[] };

describe("renderDigestSlack", () => {
  it("emits blocks in order: header, watch-this, tiles, divider, one section per finding, context", () => {
    const blocks = renderDigestSlack(composeDigest(pairInput())!) as Block[];
    expect(blocks.map((b) => b.type)).toEqual([
      "header",
      "section", // watch-this
      "section", // tiles
      "divider",
      "section", // finding 1
      "section", // finding 2
      "section", // finding 3
      "context",
    ]);
    expect(blocks[2]!.fields!.map((f) => f.type)).toEqual(["mrkdwn", "mrkdwn", "mrkdwn", "mrkdwn"]);
    expect(blocks[2]!.fields![0]).toEqual({
      type: "mrkdwn",
      text: "*<https://app.outerlayer.dev/t/acme/agents/overview|Sessions>*\n40 · ▲ 25% WoW",
    });
  });

  it("escapes mrkdwn control chars in interpolated text but leaves plain_text raw", () => {
    const input = pairInput();
    input.tenantName = "Acme & Co";
    input.findings[2]!.summary = "Agent looped on <b>&</b> edits";
    const blocks = renderDigestSlack(composeDigest(input)!) as Block[];
    const findingTexts = blocks.filter((b) => b.type === "section" && b.text).map((b) => b.text!.text);
    const looped = findingTexts.find((t) => t.includes("Agent looped"))!;
    expect(looped).toContain("Agent looped on &lt;b&gt;&amp;&lt;/b&gt; edits");
    expect(looped).not.toContain("<b>&</b>");
    expect(looped).toContain("<https://app.outerlayer.dev/t/acme/agents/findings|View details>");
    // Header is plain_text: Slack renders entities literally there, so no escaping.
    expect(blocks[0]!.text).toEqual({ type: "plain_text", text: "Acme & Co — weekly agent digest", emoji: true });
  });

  it("baseline week with no findings: no watch-this section, no divider, tiles say baseline", () => {
    const blocks = renderDigestSlack(
      composeDigest({ ...pairInput(), prior: null, findings: [], priorFindings: [] })!,
    ) as Block[];
    expect(blocks.map((b) => b.type)).toEqual(["header", "section", "context"]);
    expect(blocks[1]!.fields![1]).toEqual({
      type: "mrkdwn",
      text: "*<https://app.outerlayer.dev/t/acme/agents/overview|Spend>*\n$260.00 · baseline week",
    });
    expect(blocks[2]!).toEqual({
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: "Acme Robotics · 2026-06-29 → 2026-07-05 · <https://app.outerlayer.dev/t/acme/agents/overview|Open dashboard>",
        },
      ],
    });
  });
});
