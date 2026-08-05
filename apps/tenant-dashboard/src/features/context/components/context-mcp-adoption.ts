/**
 * MCP adoption for the context tree — the usage overlay on top of each
 * mirrored `mcp.json`. The tree response carries the installed server names
 * (parsed from the mirrored config); ClickHouse carries which servers
 * sessions actually call. The join is the product: an installed server no
 * session touches still loads its tool definitions into EVERY session's
 * context, so dead weight here has a per-session token cost — but a dormant
 * server may still be required on a rare escalation path, so the framing is
 * cost, never "safe to delete".
 *
 * Usage is keyed by server NAME only — a session doesn't say which scope's
 * mcp.json copy served the call, so in a monorepo two same-named servers
 * share one usage figure (same caveat as the skills overlay).
 */

/** Per-server usage counts — the MCP-adoption overlay payload rows. */
export interface McpServerUsage {
  serverName: string;
  /** Calls inside the recent window (the "is it live" signal). */
  recentCalls: number;
  /** Calls across the whole lookback window. */
  totalCalls: number;
  /** Distinct sessions that called the server in the lookback window. */
  totalSessions: number;
  lastUsedAt: string | null;
}

type McpServerStatus = "active" | "quiet" | "never";

/**
 * Status for one installed server given its usage row. `undefined` = the
 * server is configured but nothing called it in the lookback window →
 * `never`. A present row with zero recent calls is `quiet`; any recent →
 * `active`. Same thresholds as the skill overlay so the chips read alike.
 */
export function mcpServerStatus(usage: McpServerUsage | undefined): McpServerStatus {
  if (!usage || usage.totalCalls === 0) return "never";
  return usage.recentCalls > 0 ? "active" : "quiet";
}

/** Roll-up shown on the mcp.json file row (the muted last-used time, or "never"). */
export interface McpAdoptionSummary {
  total: number;
  never: number;
  quiet: number;
  /** Sum of recent calls across the file's servers (the active headline). */
  recentCalls: number;
  /** Most recent use across the file's servers — the row's last-used time. */
  lastUsedAt: string | null;
}

/**
 * Summary for one mcp.json's installed server list. Returns `undefined` when
 * the usage overlay hasn't loaded — unknown must never render as "never
 * used" — or when the file declares no servers (nothing to summarize).
 */
export function summarizeMcpAdoption(
  servers: readonly string[],
  usage: ReadonlyMap<string, McpServerUsage> | undefined,
): McpAdoptionSummary | undefined {
  if (!usage || servers.length === 0) return undefined;
  const summary: McpAdoptionSummary = {
    total: servers.length,
    never: 0,
    quiet: 0,
    recentCalls: 0,
    lastUsedAt: null,
  };
  for (const name of servers) {
    const row = usage.get(name);
    const status = mcpServerStatus(row);
    if (status === "never") summary.never += 1;
    else if (status === "quiet") summary.quiet += 1;
    else summary.recentCalls += row!.recentCalls;
    // ClickHouse "YYYY-MM-DD HH:MM:SS" strings order lexicographically.
    if (row?.lastUsedAt && (summary.lastUsedAt === null || row.lastUsedAt > summary.lastUsedAt)) {
      summary.lastUsedAt = row.lastUsedAt;
    }
  }
  return summary;
}

/** Index usage rows by server name for O(1) lookup while building the tree. */
export function indexMcpUsage(
  servers: readonly McpServerUsage[],
): Map<string, McpServerUsage> {
  return new Map(servers.map((s) => [s.serverName, s]));
}
