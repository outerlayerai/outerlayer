/**
 * The Overview response derivation — the inventory ∪ usage join. The edge
 * cases here ARE the feature: inventory with no usage must produce a zero
 * row (ClickHouse alone can't), usage with no inventory survives only while
 * the window still holds its activity, and name-keyed scope collisions null
 * out `scopePath`.
 */
import { describe, expect, it } from "vitest";
import type { ContextTreeResponse } from "../types";
import { deriveOverviewResponse, type OverviewAnalytics } from "../overview-read-model";

const TREE: ContextTreeResponse = {
  gitConnection: { repository: "acme/app", branch: "main" },
  head: { commitSha: "c1", snapshotId: "s1", syncedAt: "2026-07-10T00:00:00Z" },
  entries: [
    { path: ".outerlayer/AGENTS.md", kind: "instructions", scopePath: "", blobSha: "b0" },
    { path: "apps/web/.outerlayer/AGENTS.md", kind: "instructions", scopePath: "apps/web", blobSha: "b1" },
    { path: ".outerlayer/commands/ship.md", kind: "command", scopePath: "", blobSha: "b2" },
    { path: ".outerlayer/skills/alpha/SKILL.md", kind: "skill", scopePath: "", skillName: "alpha", blobSha: "b3" },
    { path: ".outerlayer/skills/silent/SKILL.md", kind: "skill", scopePath: "", skillName: "silent", blobSha: "b4" },
    // The same skill name in TWO scopes — the name-keyed join collision.
    { path: "apps/web/.outerlayer/skills/alpha/SKILL.md", kind: "skill", scopePath: "apps/web", skillName: "alpha", blobSha: "b5" },
  ],
  excludedCounts: [],
  issues: [
    { type: "missing-skill-md", path: ".outerlayer/skills/silent/SKILL.md", scopePath: "", detail: "no SKILL.md" },
  ],
  mcpServerCounts: [{ path: ".outerlayer/mcp.json", count: 2, servers: ["github", "stripe"] }],
};

const usageRow = {
  rangeSessions: 4,
  priorActivations: 10,
  recentActivations: 2,
  lookbackActivations: 30,
  lookbackSessions: 12,
  lastActivatedAt: "2026-08-09 10:00:00",
};

function analytics(overrides: Partial<OverviewAnalytics> = {}): OverviewAnalytics {
  return {
    skills: [
      { skill: "alpha", rangeActivations: 20, ...usageRow },
      // Usage for a name the repo no longer carries, still active this window.
      { skill: "ghost", rangeActivations: 7, ...usageRow },
      // Usage for a removed name with NOTHING in the range — dropped as noise.
      { skill: "ancient", rangeActivations: 0, ...usageRow },
    ],
    mcpServers: [
      {
        server: "github",
        rangeCalls: 50,
        rangeSessions: 9,
        priorCalls: 40,
        recentCalls: 5,
        lookbackCalls: 200,
        lookbackSessions: 30,
        lookbackTools: 6,
        lastUsedAt: "2026-08-09 09:00:00",
      },
    ],
    coverage: {
      rangeSessions: 50,
      rangeSessionsWithSkill: 34,
      priorSessions: 40,
      priorSessionsWithSkill: 22,
      lookbackSessions: 120,
    },
    topics: [{ topicId: "t1", name: "Migrations", sessions: 12 }],
    trends: [
      { skill: "alpha", day: "2026-08-08", activations: 3 },
      { skill: "alpha", day: "2026-08-09", activations: 5 },
    ],
    ...overrides,
  };
}

const derive = (a: OverviewAnalytics | null) =>
  deriveOverviewResponse({ range: "30d", recentDays: 14, lookbackDays: 90, tree: TREE, analytics: a });

describe("deriveOverviewResponse", () => {
  it("joins inventory ∪ usage: zero rows for unused inventory, orphans kept only with range activity", () => {
    const result = derive(analytics());
    expect(result.skills.map((r) => [r.skillName, r.inRepo, r.activations])).toEqual([
      ["alpha", true, 20],
      ["ghost", false, 7],
      // Inventory with no usage still gets its row — the never candidate.
      ["silent", true, 0],
      // "ancient" (removed AND nothing in the range) is dropped.
    ]);
  });

  it("nulls scopePath on a name-keyed scope collision and pins the issue on the right skill", () => {
    const result = derive(analytics());
    const alpha = result.skills.find((r) => r.skillName === "alpha")!;
    expect(alpha.scopePath).toBeNull();
    const silent = result.skills.find((r) => r.skillName === "silent")!;
    expect(silent.scopePath).toBe("");
    expect(silent.issues).toEqual(["missing-skill-md"]);
    expect(alpha.issues).toEqual([]);
  });

  it("attaches the grouped trend series to its skill only", () => {
    const result = derive(analytics());
    expect(result.skills.find((r) => r.skillName === "alpha")!.trend).toEqual([
      { day: "2026-08-08", activations: 3 },
      { day: "2026-08-09", activations: 5 },
    ]);
    expect(result.skills.find((r) => r.skillName === "silent")!.trend).toEqual([]);
  });

  it("joins MCP servers off every mcp.json, keeping unused ones as zero rows", () => {
    const result = derive(analytics());
    expect(result.mcpServers.map((r) => [r.serverName, r.inRepo, r.calls, r.toolsUsed])).toEqual([
      ["github", true, 50, 6],
      ["stripe", true, 0, 0],
    ]);
    expect(result.mcpServers[1]!.configPath).toBe(".outerlayer/mcp.json");
    expect(result.mcpServers[1]!.lastUsedAt).toBeNull();
  });

  it("carries coverage, topics, and the no-telemetry inventory counts", () => {
    const result = derive(analytics());
    expect(result.coverage).toEqual({
      sessions: 50,
      sessionsWithSkill: 34,
      priorSessions: 40,
      priorSessionsWithSkill: 22,
      lookbackSessions: 120,
    });
    expect(result.topics).toEqual([{ topicId: "t1", name: "Migrations", sessions: 12 }]);
    // Two AGENTS.md scopes, one command, no subagents.
    expect(result.inventory).toEqual({ instructionScopes: 2, commands: 1, subagents: 0 });
  });

  it("degrades to inventory-only rows when analytics is null — never zeros masquerading as data", () => {
    const result = derive(null);
    expect(result.degraded).toBe(true);
    expect(result.coverage).toBeNull();
    expect(result.topics).toEqual([]);
    // Inventory rows survive; orphaned usage obviously can't exist.
    expect(result.skills.map((r) => r.skillName)).toEqual(["alpha", "silent"]);
    expect(result.mcpServers.map((r) => r.serverName)).toEqual(["github", "stripe"]);
  });
});
