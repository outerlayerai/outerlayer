/**
 * Pure derivation for the Context Overview response: the inventory ∪ usage
 * join. The mirrored tree is the row source of truth — ClickHouse alone
 * cannot produce a "never used" row, because a skill nothing activated has no
 * usage row at all — and usage is layered on top:
 *
 * - inventory with no usage → a zero row (a `never` candidate; the verdict
 *   itself is the view model's job, gated on the app having sessions at all)
 * - usage with no inventory → `inRepo: false`, kept only while it still has
 *   activity in the selected range (a deleted skill's history matters for the
 *   window's accounting, not forever)
 * - the join is keyed by NAME only (activation events don't say which scope's
 *   copy fired), so same-named skills across scopes share one row and
 *   `scopePath` goes `null` on collision.
 *
 * Kept pure and framework-free so the join edge cases are asserted directly.
 */
import type {
  McpOverviewRow,
  SessionCoverageRow,
  SkillOverviewRow,
  SkillTrendByDayRow,
  TopicRollupRow,
} from "@repo/observability-service";
import type {
  ContextOverviewRange,
  ContextOverviewResponse,
  ContextTreeResponse,
  OverviewIssueType,
  OverviewMcpRow,
  OverviewSkillRow,
  OverviewTopic,
} from "./types";

/** The ClickHouse half of the Overview; `null` = analytics degraded. */
export interface OverviewAnalytics {
  skills: SkillOverviewRow[];
  mcpServers: McpOverviewRow[];
  coverage: SessionCoverageRow | null;
  topics: TopicRollupRow[];
  trends: SkillTrendByDayRow[];
}

interface DeriveOverviewInput {
  range: ContextOverviewRange;
  recentDays: number;
  lookbackDays: number;
  tree: ContextTreeResponse;
  analytics: OverviewAnalytics | null;
}

/** The skill name of a `<scopeDir>/skills/<name>/…` issue path, or null. */
function skillNameOfIssuePath(path: string): string | null {
  const segs = path.split("/");
  const idx = segs.lastIndexOf("skills");
  return idx >= 0 && idx + 1 < segs.length - 1 ? (segs[idx + 1] ?? null) : null;
}

/** Empty-string ClickHouse timestamps become null — absent, not epoch. */
function tsOrNull(raw: string | undefined): string | null {
  return raw ? raw : null;
}

export function deriveOverviewResponse(input: DeriveOverviewInput): ContextOverviewResponse {
  const { tree, analytics } = input;

  // --- Inventory: skills grouped by name, with their scopes and issues. ---
  const scopesBySkill = new Map<string, Set<string>>();
  for (const entry of tree.entries) {
    if (entry.skillName === undefined) continue;
    const scopes = scopesBySkill.get(entry.skillName) ?? new Set<string>();
    scopes.add(entry.scopePath);
    scopesBySkill.set(entry.skillName, scopes);
  }
  const issuesBySkill = new Map<string, Set<OverviewIssueType>>();
  for (const issue of tree.issues) {
    const name = skillNameOfIssuePath(issue.path);
    if (name === null) continue;
    const set = issuesBySkill.get(name) ?? new Set<OverviewIssueType>();
    set.add(issue.type);
    issuesBySkill.set(name, set);
  }

  const skillUsage = new Map((analytics?.skills ?? []).map((row) => [row.skill, row]));
  const trendBySkill = new Map<string, Array<{ day: string; activations: number }>>();
  for (const point of analytics?.trends ?? []) {
    const series = trendBySkill.get(point.skill) ?? [];
    series.push({ day: point.day, activations: Number(point.activations) });
    trendBySkill.set(point.skill, series);
  }

  // Window totals over EVERY usage row, summed before the orphan-drop below:
  // a removed skill with prior-window activity and none in the current window
  // gets no row, but its prior usage must still weigh the tile's delta.
  const totals = (analytics?.skills ?? []).reduce(
    (sum, row) => ({
      activations: sum.activations + Number(row.rangeActivations),
      priorActivations: sum.priorActivations + Number(row.priorActivations),
    }),
    { activations: 0, priorActivations: 0 },
  );

  const skillNames = new Set<string>([...scopesBySkill.keys(), ...skillUsage.keys()]);
  const skills: OverviewSkillRow[] = [];
  for (const skillName of skillNames) {
    const scopes = scopesBySkill.get(skillName);
    const usage = skillUsage.get(skillName);
    const inRepo = scopes !== undefined;
    const activations = Number(usage?.rangeActivations ?? 0);
    // A deleted skill's history matters only while the selected window still
    // contains its activity; a zero-range orphan is noise.
    if (!inRepo && activations === 0) continue;
    skills.push({
      skillName,
      scopePath: scopes !== undefined && scopes.size === 1 ? [...scopes][0]! : null,
      inRepo,
      activations,
      priorActivations: Number(usage?.priorActivations ?? 0),
      sessions: Number(usage?.rangeSessions ?? 0),
      recentActivations: Number(usage?.recentActivations ?? 0),
      lookbackActivations: Number(usage?.lookbackActivations ?? 0),
      lastActivatedAt: tsOrNull(usage?.lastActivatedAt),
      trend: trendBySkill.get(skillName) ?? [],
      issues: [...(issuesBySkill.get(skillName) ?? [])].sort(),
    });
  }
  skills.sort(
    (a, b) =>
      b.activations - a.activations ||
      b.lookbackActivations - a.lookbackActivations ||
      a.skillName.localeCompare(b.skillName),
  );

  // --- Inventory: MCP servers, keyed by name across every mirrored mcp.json. ---
  const configPathByServer = new Map<string, string>();
  for (const file of tree.mcpServerCounts) {
    for (const server of file.servers) {
      if (!configPathByServer.has(server)) configPathByServer.set(server, file.path);
    }
  }
  const mcpUsage = new Map((analytics?.mcpServers ?? []).map((row) => [row.server, row]));
  const serverNames = new Set<string>([...configPathByServer.keys(), ...mcpUsage.keys()]);
  const mcpServers: OverviewMcpRow[] = [];
  for (const serverName of serverNames) {
    const configPath = configPathByServer.get(serverName) ?? null;
    const usage = mcpUsage.get(serverName);
    const inRepo = configPath !== null;
    const calls = Number(usage?.rangeCalls ?? 0);
    if (!inRepo && calls === 0) continue;
    mcpServers.push({
      serverName,
      configPath,
      inRepo,
      calls,
      priorCalls: Number(usage?.priorCalls ?? 0),
      sessions: Number(usage?.rangeSessions ?? 0),
      recentCalls: Number(usage?.recentCalls ?? 0),
      lookbackCalls: Number(usage?.lookbackCalls ?? 0),
      toolsUsed: Number(usage?.lookbackTools ?? 0),
      lastUsedAt: tsOrNull(usage?.lastUsedAt),
    });
  }
  mcpServers.sort(
    (a, b) =>
      b.calls - a.calls ||
      b.lookbackCalls - a.lookbackCalls ||
      a.serverName.localeCompare(b.serverName),
  );

  const coverage = analytics?.coverage
    ? {
        sessions: Number(analytics.coverage.rangeSessions),
        sessionsWithSkill: Number(analytics.coverage.rangeSessionsWithSkill),
        priorSessions: Number(analytics.coverage.priorSessions),
        priorSessionsWithSkill: Number(analytics.coverage.priorSessionsWithSkill),
        lookbackSessions: Number(analytics.coverage.lookbackSessions),
      }
    : null;

  const topics: OverviewTopic[] = (analytics?.topics ?? []).map((topic) => ({
    topicId: topic.topicId,
    name: topic.name,
    sessions: Number(topic.sessions),
  }));

  // Kinds with no usage telemetry — inventory counts only, never fake zeros.
  const instructionScopes = new Set<string>();
  let commands = 0;
  let subagents = 0;
  for (const entry of tree.entries) {
    if (entry.kind === "instructions") instructionScopes.add(entry.scopePath);
    else if (entry.kind === "command") commands += 1;
    else if (entry.kind === "subagent") subagents += 1;
  }

  return {
    range: input.range,
    recentDays: input.recentDays,
    lookbackDays: input.lookbackDays,
    degraded: analytics === null,
    totals,
    skills,
    mcpServers,
    coverage,
    topics,
    inventory: { instructionScopes: instructionScopes.size, commands, subagents },
  };
}
