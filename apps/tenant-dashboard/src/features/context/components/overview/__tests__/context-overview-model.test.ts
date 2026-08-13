/**
 * The Overview view model's judgment calls: status verdicts off the FIXED
 * windows, first-run gating (zero must read as young, not failing), the
 * delta arithmetic (percent vs percentage points), sorting, the top-N split,
 * and the needs-attention worklist.
 */
import { describe, expect, it } from "vitest";
import type {
  ContextOverviewResponse,
  OverviewMcpRow,
  OverviewSkillRow,
} from "../../../types";
import {
  attentionItems,
  countMcpStatuses,
  countSkillStatuses,
  coverageDelta,
  coveragePct,
  isFirstRun,
  mcpStatus,
  percentDelta,
  skillStatus,
  sortSkillRows,
  topNSplit,
  verdictsAvailable,
} from "../context-overview-model";

function skill(overrides: Partial<OverviewSkillRow> & { skillName: string }): OverviewSkillRow {
  return {
    scopePath: "",
    inRepo: true,
    activations: 0,
    priorActivations: 0,
    sessions: 0,
    recentActivations: 0,
    lookbackActivations: 0,
    lastActivatedAt: null,
    trend: [],
    issues: [],
    ...overrides,
  };
}

function mcp(overrides: Partial<OverviewMcpRow> & { serverName: string }): OverviewMcpRow {
  return {
    configPath: ".outerlayer/mcp.json",
    inRepo: true,
    calls: 0,
    priorCalls: 0,
    sessions: 0,
    recentCalls: 0,
    lookbackCalls: 0,
    toolsUsed: 0,
    lastUsedAt: null,
    ...overrides,
  };
}

function response(overrides: Partial<ContextOverviewResponse> = {}): ContextOverviewResponse {
  return {
    range: "30d",
    recentDays: 14,
    lookbackDays: 90,
    degraded: false,
    totals: { activations: 0, priorActivations: 0 },
    skills: [],
    mcpServers: [],
    coverage: {
      sessions: 10,
      sessionsWithSkill: 5,
      priorSessions: 10,
      priorSessionsWithSkill: 5,
      lookbackSessions: 40,
    },
    topics: [],
    inventory: { instructionScopes: 0, commands: 0, subagents: 0 },
    ...overrides,
  };
}

describe("status verdicts", () => {
  it("derives never/quiet/active from the FIXED windows, not the selected range", () => {
    // Zero in the selected range but recent activity → still active: flipping
    // the range selector must never change a pill.
    expect(skillStatus(skill({ skillName: "a", activations: 0, recentActivations: 3, lookbackActivations: 5 }))).toBe("active");
    expect(skillStatus(skill({ skillName: "b", recentActivations: 0, lookbackActivations: 5 }))).toBe("quiet");
    expect(skillStatus(skill({ skillName: "c", lookbackActivations: 0, activations: 0 }))).toBe("never");
    expect(mcpStatus(mcp({ serverName: "s", recentCalls: 1, lookbackCalls: 2 }))).toBe("active");
    expect(mcpStatus(mcp({ serverName: "t", recentCalls: 0, lookbackCalls: 2 }))).toBe("quiet");
    expect(mcpStatus(mcp({ serverName: "u", lookbackCalls: 0 }))).toBe("never");
  });

  it("counts statuses over in-repo rows only — removed rows are history, not inventory", () => {
    const rows = [
      skill({ skillName: "a", recentActivations: 1, lookbackActivations: 2 }),
      skill({ skillName: "b", lookbackActivations: 2 }),
      skill({ skillName: "gone", inRepo: false, recentActivations: 9, lookbackActivations: 9 }),
      skill({ skillName: "c" }),
    ];
    expect(countSkillStatuses(rows)).toEqual({ active: 1, quiet: 1, never: 1 });
    expect(
      countMcpStatuses([
        mcp({ serverName: "s", recentCalls: 1, lookbackCalls: 1 }),
        mcp({ serverName: "gone", inRepo: false, recentCalls: 5, lookbackCalls: 5 }),
      ]),
    ).toEqual({ active: 1, quiet: 0, never: 0 });
  });
});

describe("first-run gating", () => {
  it("withholds verdicts while degraded (unknown ≠ never)", () => {
    expect(verdictsAvailable(response({ degraded: true, coverage: null }))).toBe(false);
  });

  it("withholds verdicts until the app has run a session in the lookback", () => {
    const young = response({
      coverage: { sessions: 0, sessionsWithSkill: 0, priorSessions: 0, priorSessionsWithSkill: 0, lookbackSessions: 0 },
    });
    expect(verdictsAvailable(young)).toBe(false);
    expect(isFirstRun(young)).toBe(true);
    // Degraded is NOT first run — unknown must not claim "young" either.
    expect(isFirstRun(response({ degraded: true, coverage: null }))).toBe(false);
    expect(verdictsAvailable(response())).toBe(true);
    expect(isFirstRun(response())).toBe(false);
  });
});

describe("deltas", () => {
  // AC-058-02 (the arithmetic half: the UI test proves the URL/refetch half)
  it("computes signed percent deltas and refuses to fabricate one from an empty prior", () => {
    expect(percentDelta(150, 100)).toEqual({ glyph: "▲", text: "+50.0%", sentiment: "good" });
    expect(percentDelta(75, 100)).toEqual({ glyph: "▼", text: "−25.0%", sentiment: "bad" });
    expect(percentDelta(100, 100)).toEqual({ glyph: "▪", text: "±0.0%", sentiment: "neutral" });
    expect(percentDelta(100, 0)).toBeNull();
  });

  it("computes coverage deltas in PERCENTAGE POINTS, not relative growth", () => {
    // 68% now vs 55% prior → +13pp (a "+23.6%" here would misread badly).
    const delta = coverageDelta({
      sessions: 50,
      sessionsWithSkill: 34,
      priorSessions: 40,
      priorSessionsWithSkill: 22,
      lookbackSessions: 120,
    });
    expect(delta).toEqual({ glyph: "▲", text: "+13.0pp", sentiment: "good" });
    expect(coveragePct(0, 0)).toBeNull();
    expect(
      coverageDelta({
        sessions: 50,
        sessionsWithSkill: 34,
        priorSessions: 0,
        priorSessionsWithSkill: 0,
        lookbackSessions: 120,
      }),
    ).toBeNull();
  });
});

describe("sorting and the top-N split", () => {
  const rows = [
    skill({ skillName: "beta", activations: 10, sessions: 1 }),
    skill({ skillName: "alpha", activations: 10, sessions: 9 }),
    skill({ skillName: "gamma", activations: 30, sessions: 2 }),
  ];

  it("sorts by the key with a stable name tiebreak", () => {
    expect(sortSkillRows(rows, "activations", "desc").map((r) => r.skillName)).toEqual([
      "gamma",
      "alpha",
      "beta",
    ]);
    expect(sortSkillRows(rows, "sessions", "asc").map((r) => r.skillName)).toEqual([
      "beta",
      "gamma",
      "alpha",
    ]);
    expect(sortSkillRows(rows, "name", "asc").map((r) => r.skillName)).toEqual([
      "alpha",
      "beta",
      "gamma",
    ]);
  });

  it("splits at top-N with an exact hidden count, and expansion shows everything", () => {
    const many = Array.from({ length: 11 }, (_, i) => skill({ skillName: `s${i}` }));
    expect(topNSplit(many, false)).toEqual({ visible: many.slice(0, 8), hiddenCount: 3 });
    expect(topNSplit(many, true)).toEqual({ visible: many, hiddenCount: 0 });
    expect(topNSplit(many.slice(0, 8), false)).toEqual({ visible: many.slice(0, 8), hiddenCount: 0 });
  });
});

describe("needs attention", () => {
  it("lists never-used artifacts with file links, plus inventory issues", () => {
    const r = response({
      skills: [
        skill({ skillName: "dead" }),
        skill({ skillName: "broken", issues: ["missing-skill-md"] }),
        skill({ skillName: "fine", recentActivations: 1, lookbackActivations: 2 }),
      ],
      mcpServers: [mcp({ serverName: "stripe" })],
    });
    expect(attentionItems(r)).toEqual([
      { kind: "skill-never", name: "dead", filePath: ".outerlayer/skills/dead/SKILL.md" },
      // A skill whose SKILL.md is missing cannot link to it.
      { kind: "skill-never", name: "broken", filePath: null },
      { kind: "server-never", name: "stripe", filePath: ".outerlayer/mcp.json" },
      { kind: "issue", name: "broken", issue: "missing-skill-md", filePath: null },
    ]);
  });

  it("suppresses never verdicts (but keeps issues) before verdicts are available", () => {
    const r = response({
      degraded: true,
      coverage: null,
      skills: [skill({ skillName: "dead" }), skill({ skillName: "broken", issues: ["shadowed"] })],
    });
    expect(attentionItems(r)).toEqual([
      { kind: "issue", name: "broken", issue: "shadowed", filePath: ".outerlayer/skills/broken/SKILL.md" },
    ]);
  });
});
