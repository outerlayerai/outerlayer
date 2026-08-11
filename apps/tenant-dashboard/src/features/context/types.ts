/**
 * Wire types for the context authoring surface: the shapes the read service
 * returns and every consumer (React Server Component (RSC) page, hooks, tree/viewer components) reads.
 * Pure types only — no runtime, no "use client" — so a server module and a
 * client component can both import them without dragging one environment into
 * the other.
 *
 * Every response describes ONE snapshot (head by default, or an explicit
 * `snapshotId`); no consumer may assume "head".
 */
import type { ContextKind, ClassifyIssue, FieldIssue } from "@repo/context-core";
import type { Database } from "../../types/db";

/** The synced `context_head` pointer for the app's connected branch. */
export interface ContextHead {
  commitSha: string;
  snapshotId: string;
  /** ISO-8601. */
  syncedAt: string;
}

/** The app's git connection — enough to distinguish empty states and label the tree. */
export interface ContextGitConnection {
  repository: string;
  branch: string;
  /**
   * `github` (legacy rows may be null → treated as github). Feeds the
   * oversize provider deep-link. Optional so pure-model fixtures need not set it;
   * the read service always populates it from the git connection.
   */
  provider?: string | null;
}

/** One classified, content-mirrored file in a snapshot's tree. */
export interface ContextTreeEntry {
  /** Repo-relative, `/`-normalized. */
  path: string;
  kind: ContextKind;
  /** Parent dir of the governing `.outerlayer/` (or the file's own dir for external-instructions). `''` = repo root. */
  scopePath: string;
  /** Present for `skill` / `skill-reference` only. */
  skillName?: string;
  blobSha: string;
}

/** Per-skill count of non-content files (assets/scripts) that live in git but are not mirrored. */
export interface ContextExcludedCount {
  scopePath: string;
  skillName: string;
  count: number;
}

export interface ContextTreeResponse {
  /** `null` when the app has no git connection at all → "connect a repo" empty state. */
  gitConnection: ContextGitConnection | null;
  /** `null` when connected but never synced → "set up context" empty state. */
  head: ContextHead | null;
  /** Content entries excluding `external-instructions` and internal `config`. */
  entries: ContextTreeEntry[];
  excludedCounts: ContextExcludedCount[];
  /** Derived annotations (missing SKILL.md, shadowing) keyed by their target path. */
  issues: ClassifyIssue[];
  /**
   * Per-`mcp.json` installed servers for the tree's "· N servers" annotation
   * and the adoption overlay. `servers` are config keys (not secrets), so
   * carrying the names is safe; `count` is their length.
   */
  mcpServerCounts: Array<{ path: string; count: number; servers: string[] }>;
  /**
   * App publish policy (`app.require_pull_request`): when true, publishing
   * opens a pull request and the dialog states so. Optional so pure-model
   * fixtures need not set it; the read service always populates it.
   */
  requirePullRequest?: boolean;
}

export interface ContextFileResponse {
  path: string;
  kind: ContextKind;
  blobSha: string;
  commitSha: string;
  /** Exact file bytes, or `null` when the blob is oversize (>1 MB) and not mirrored. */
  content: string | null;
  oversize: boolean;
  frontmatter: {
    /** Parsed leading YAML frontmatter mapping, or `null` (no frontmatter / mcp+json / oversize). */
    parsed: Record<string, unknown> | null;
    /** Display-only validation notes (schema errors + unknown-key warnings). Never blocks in read-only UI. */
    issues: FieldIssue[];
  };
}

/** One day's activation counts in a skill's trend series. */
interface SkillTrendPoint {
  day: string;
  activations: number;
  sessions: number;
}

/** One session that activated a skill, for the drill-down list. */
interface SkillDrilldownSession {
  traceId: string;
  title: string | null;
  activations: number;
  lastActivatedAt: string | null;
}

/** One task topic the activating sessions cluster under. */
interface SkillDrilldownTopic {
  topicId: string;
  name: string;
  sessions: number;
}

/** The per-skill drill-down payload: trend, activating sessions, and topic breakdown. */
export interface SkillDrilldownResponse {
  trend: SkillTrendPoint[];
  sessions: SkillDrilldownSession[];
  topics: SkillDrilldownTopic[];
  lookbackDays: number;
}

/** One tool's usage split inside a server's drill-down. */
interface McpToolUsage {
  tool: string;
  recentCalls: number;
  totalCalls: number;
  sessions: number;
  lastUsedAt: string | null;
}

/** One day's call counts in a server's trend series. */
interface McpTrendPoint {
  day: string;
  calls: number;
  sessions: number;
}

/** One session that called a server, for the drill-down list. */
interface McpDrilldownSession {
  traceId: string;
  title: string | null;
  calls: number;
  lastUsedAt: string | null;
}

/** The per-server drill-down payload: tool breakdown, call trend, and calling sessions. */
export interface McpDrilldownResponse {
  tools: McpToolUsage[];
  trend: McpTrendPoint[];
  sessions: McpDrilldownSession[];
  lookbackDays: number;
  recentDays: number;
}

/** The Overview's user-selected window. Mirrors the dashboards' range values;
 * defined here because features are leaves and cannot import each other. */
export type ContextOverviewRange = "24h" | "7d" | "30d" | "90d";

/** Inventory problems surfaced on Overview rows and the needs-attention rail. */
export type OverviewIssueType = "missing-skill-md" | "shadowed" | "misplaced";

/**
 * One skill in the Overview — the inventory ∪ usage join. ClickHouse alone
 * cannot produce a "never used" row, so rows are keyed off the mirrored
 * inventory and usage is layered on (zeros when nothing activated).
 */
export interface OverviewSkillRow {
  skillName: string;
  /** Scope of the inventory copy, or `null` when the name is absent from the
   *  repo or present in more than one scope (usage is name-keyed). */
  scopePath: string | null;
  /** `false` = activations recorded for a name no longer in the repo. */
  inRepo: boolean;
  /** Activations in the selected range window. */
  activations: number;
  /** Activations in the equal-length window before the range. */
  priorActivations: number;
  /** Distinct sessions in the selected range window. */
  sessions: number;
  /** Activations inside the fixed recent threshold — the active/quiet verdict
   *  must not change when the user flips the range selector. */
  recentActivations: number;
  /** Activations across the fixed lookback horizon — the never verdict. */
  lookbackActivations: number;
  lastActivatedAt: string | null;
  /** Day series over the range window (gaps = zero days; view zero-fills). */
  trend: Array<{ day: string; activations: number }>;
  issues: OverviewIssueType[];
}

/** One MCP server in the Overview — same join semantics as the skill rows. */
export interface OverviewMcpRow {
  serverName: string;
  /** The mcp.json declaring the server, or `null` when it isn't in the repo. */
  configPath: string | null;
  inRepo: boolean;
  calls: number;
  priorCalls: number;
  sessions: number;
  recentCalls: number;
  lookbackCalls: number;
  /** Distinct tools CALLED in the lookback — mcp.json carries no definitions,
   *  so "tools defined" is unknowable and never claimed. */
  toolsUsed: number;
  lastUsedAt: string | null;
}

/** Session coverage per window; `lookbackSessions` doubles as the first-run gate. */
export interface OverviewCoverage {
  sessions: number;
  sessionsWithSkill: number;
  priorSessions: number;
  priorSessionsWithSkill: number;
  lookbackSessions: number;
}

/** One task topic the skill-activating sessions cluster under. */
export interface OverviewTopic {
  topicId: string;
  name: string;
  sessions: number;
}

/** Counts of the artifact kinds that carry NO usage telemetry — shown as
 * inventory with an explicit note, never as fake zeros. */
interface OverviewInventory {
  /** Scopes carrying an instructions file (AGENTS.md/CLAUDE.md). */
  instructionScopes: number;
  commands: number;
  subagents: number;
}

/** The Overview payload: joined rows plus the coverage and topic rollups. */
export interface ContextOverviewResponse {
  range: ContextOverviewRange;
  /**
   * Window totals summed over ALL usage rows — including removed-skill usage
   * whose row the join drops for having no current-window activity. The
   * activations tile's period-over-period delta must count a deleted skill's
   * prior-window usage, or removal reads as growth.
   */
  totals: { activations: number; priorActivations: number };
  /** The fixed adoption thresholds the status pills derive from. */
  recentDays: number;
  lookbackDays: number;
  /** True when the analytics backend was unreachable or unconfigured — usage
   *  must render as unknown ("—"), never as zero, and no verdicts are earned. */
  degraded: boolean;
  skills: OverviewSkillRow[];
  mcpServers: OverviewMcpRow[];
  /** `null` when degraded. */
  coverage: OverviewCoverage | null;
  topics: OverviewTopic[];
  inventory: OverviewInventory;
}

/** One row of the `context_sync_event` ledger (a link/push/resync attempt). */
export type ContextSyncEventRow = Database["public"]["Tables"]["context_sync_event"]["Row"];

/** One page of the sync-event ledger for an app, newest-first, with an exact total for the pager. */
export interface ContextSyncHistoryResponse {
  rows: ContextSyncEventRow[];
  total: number;
}
