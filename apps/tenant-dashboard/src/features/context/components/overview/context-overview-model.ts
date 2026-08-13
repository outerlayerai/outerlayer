/**
 * Pure view model for the Context Overview: status verdicts and their
 * first-run gating, tile deltas (percent and percentage-point), sorting and
 * the top-N split. Framework-free so every judgment call is asserted
 * directly, without a DOM.
 *
 * The one rule that spans everything here: a zero must read as YOUNG, not
 * failing. No `never` verdict (red pill, needs-attention entry) is ever
 * emitted unless the analytics backend answered AND the app has run at least
 * one session inside the lookback horizon.
 */
import type {
  ContextOverviewRange,
  ContextOverviewResponse,
  OverviewCoverage,
  OverviewIssueType,
  OverviewMcpRow,
  OverviewSkillRow,
} from "../../types";

/** Rows shown before the inline "Show all" expander. */
export const OVERVIEW_TOP_N = 8;

/** Day counts behind each range value — labels and sparkline windows. */
export const OVERVIEW_RANGE_DAYS: Record<ContextOverviewRange, number> = {
  "24h": 1,
  "7d": 7,
  "30d": 30,
  "90d": 90,
};

export type OverviewStatus = "active" | "quiet" | "never";

/**
 * Whether status verdicts may be shown at all. `degraded` means usage is
 * unknown (unknown ≠ never); a lookback with zero sessions means the app is
 * new — first run — and everything must render as young rather than dead.
 */
export function verdictsAvailable(response: ContextOverviewResponse): boolean {
  return !response.degraded && (response.coverage?.lookbackSessions ?? 0) > 0;
}

/** First run: analytics answered, but the app has never run a session. */
export function isFirstRun(response: ContextOverviewResponse): boolean {
  return !response.degraded && (response.coverage?.lookbackSessions ?? 0) === 0;
}

/** Verdict thresholds are the FIXED windows, never the selected range —
 *  flipping the range selector must not change a pill. */
export function skillStatus(row: OverviewSkillRow): OverviewStatus {
  if (row.lookbackActivations === 0) return "never";
  return row.recentActivations > 0 ? "active" : "quiet";
}

export function mcpStatus(row: OverviewMcpRow): OverviewStatus {
  if (row.lookbackCalls === 0) return "never";
  return row.recentCalls > 0 ? "active" : "quiet";
}

export interface StatusCounts {
  active: number;
  quiet: number;
  never: number;
}

/** Status counts over the IN-REPO rows only — a removed skill's history is
 *  context, not a verdict about the current inventory. */
function countStatuses<T extends { inRepo: boolean }>(
  rows: readonly T[],
  statusOf: (row: T) => OverviewStatus,
): StatusCounts {
  const counts: StatusCounts = { active: 0, quiet: 0, never: 0 };
  for (const row of rows) {
    if (!row.inRepo) continue;
    counts[statusOf(row)] += 1;
  }
  return counts;
}

export function countSkillStatuses(rows: readonly OverviewSkillRow[]): StatusCounts {
  return countStatuses(rows, skillStatus);
}

export function countMcpStatuses(rows: readonly OverviewMcpRow[]): StatusCounts {
  return countStatuses(rows, mcpStatus);
}

// ---------------------------------------------------------------------------
// Deltas
// ---------------------------------------------------------------------------

export interface OverviewDelta {
  glyph: "▲" | "▼" | "▪";
  text: string;
  sentiment: "good" | "bad" | "neutral";
}

/**
 * Percent change vs the prior window, or `null` when the prior window is
 * empty — the tile says "no prior data" instead of fabricating a percent.
 * More usage is adoption going up, so up is good here.
 */
export function percentDelta(current: number, prior: number): OverviewDelta | null {
  if (prior === 0) return null;
  const change = ((current - prior) / prior) * 100;
  if (Math.abs(change) < 0.05) return { glyph: "▪", text: "±0.0%", sentiment: "neutral" };
  const up = change > 0;
  return {
    glyph: up ? "▲" : "▼",
    text: `${up ? "+" : "−"}${Math.abs(change).toFixed(1)}%`,
    sentiment: up ? "good" : "bad",
  };
}

/** Coverage percentage for a window, or `null` when it had no sessions. */
export function coveragePct(sessions: number, withSkill: number): number | null {
  if (sessions === 0) return null;
  return (withSkill / sessions) * 100;
}

/**
 * Coverage delta in PERCENTAGE POINTS — a share-of-sessions change is a
 * difference of two rates, and "+6pp" must not misread as relative growth.
 */
export function coverageDelta(coverage: OverviewCoverage): OverviewDelta | null {
  const current = coveragePct(coverage.sessions, coverage.sessionsWithSkill);
  const prior = coveragePct(coverage.priorSessions, coverage.priorSessionsWithSkill);
  if (current === null || prior === null) return null;
  const diff = current - prior;
  if (Math.abs(diff) < 0.05) return { glyph: "▪", text: "±0.0pp", sentiment: "neutral" };
  const up = diff > 0;
  return {
    glyph: up ? "▲" : "▼",
    text: `${up ? "+" : "−"}${Math.abs(diff).toFixed(1)}pp`,
    sentiment: up ? "good" : "bad",
  };
}

// ---------------------------------------------------------------------------
// Sorting and the top-N split
// ---------------------------------------------------------------------------

export type OverviewSortKey = "name" | "activations" | "sessions";
export type OverviewSortDir = "asc" | "desc";

function skillSortValue(row: OverviewSkillRow, key: OverviewSortKey): string | number {
  if (key === "name") return row.skillName;
  return key === "activations" ? row.activations : row.sessions;
}

function mcpSortValue(row: OverviewMcpRow, key: OverviewSortKey): string | number {
  if (key === "name") return row.serverName;
  return key === "activations" ? row.calls : row.sessions;
}

function compareValues(a: string | number, b: string | number, dir: OverviewSortDir): number {
  const sign = dir === "asc" ? 1 : -1;
  if (typeof a === "string" || typeof b === "string") {
    return sign * String(a).localeCompare(String(b));
  }
  return sign * (a - b);
}

export function sortSkillRows(
  rows: readonly OverviewSkillRow[],
  key: OverviewSortKey,
  dir: OverviewSortDir,
): OverviewSkillRow[] {
  return [...rows].sort(
    (a, b) =>
      compareValues(skillSortValue(a, key), skillSortValue(b, key), dir) ||
      a.skillName.localeCompare(b.skillName),
  );
}

export function sortMcpRows(
  rows: readonly OverviewMcpRow[],
  key: OverviewSortKey,
  dir: OverviewSortDir,
): OverviewMcpRow[] {
  return [...rows].sort(
    (a, b) =>
      compareValues(mcpSortValue(a, key), mcpSortValue(b, key), dir) ||
      a.serverName.localeCompare(b.serverName),
  );
}

/** Top-N with an inline expander — never a pager on a rollup. */
export function topNSplit<T>(
  rows: readonly T[],
  expanded: boolean,
  topN: number = OVERVIEW_TOP_N,
): { visible: T[]; hiddenCount: number } {
  if (expanded || rows.length <= topN) return { visible: [...rows], hiddenCount: 0 };
  return { visible: rows.slice(0, topN), hiddenCount: rows.length - topN };
}

// ---------------------------------------------------------------------------
// Needs attention
// ---------------------------------------------------------------------------

export interface AttentionItem {
  kind: "skill-never" | "server-never" | "issue";
  name: string;
  issue?: OverviewIssueType;
  /** Deep link into the Files view, or `null` when no file can be named
   *  (ambiguous scope, or the missing file itself). */
  filePath: string | null;
}

/** The `.outerlayer` dir governing a scope (`''` = repo root). */
function scopeDirOf(scopePath: string): string {
  return scopePath === "" ? ".outerlayer" : `${scopePath}/.outerlayer`;
}

function skillFilePath(row: OverviewSkillRow): string | null {
  if (row.scopePath === null || row.issues.includes("missing-skill-md")) return null;
  return `${scopeDirOf(row.scopePath)}/skills/${row.skillName}/SKILL.md`;
}

/**
 * The worklist: never-used artifacts (only when verdicts are available) and
 * inventory issues. Dead weight is a finding with an action, not an empty
 * cell someone has to notice.
 */
export function attentionItems(response: ContextOverviewResponse): AttentionItem[] {
  const items: AttentionItem[] = [];
  if (verdictsAvailable(response)) {
    for (const row of response.skills) {
      if (row.inRepo && skillStatus(row) === "never") {
        items.push({ kind: "skill-never", name: row.skillName, filePath: skillFilePath(row) });
      }
    }
    for (const row of response.mcpServers) {
      if (row.inRepo && mcpStatus(row) === "never") {
        items.push({ kind: "server-never", name: row.serverName, filePath: row.configPath });
      }
    }
  }
  for (const row of response.skills) {
    for (const issue of row.issues) {
      items.push({
        kind: "issue",
        name: row.skillName,
        issue,
        filePath: issue === "missing-skill-md" ? null : skillFilePath(row),
      });
    }
  }
  return items;
}
