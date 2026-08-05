/**
 * Agent-findings compute — the nightly job behind the dashboard's Findings
 * page. Per active (tenant, app) scope inside the detection window:
 *
 *   load DetectionSession[] (findings-store fold over agent spans)
 *     → run the @outerlayer/insights-core detectors (deterministic, no LLM)
 *     → cluster error signatures; label themes via the capped Haiku call
 *       when an API key is configured (findings never depend on a model)
 *     → replace the scope's agent_finding / agent_theme rows wholesale
 *       (delete + insert → idempotent re-runs)
 *
 * Calibration guards (the noise lessons from local validation):
 *   - a scope below `minSessions` in the window computes nothing — findings
 *     over a handful of sessions read as noise, not a pattern;
 *   - per-detector findings are capped at `maxFindingsPerDetector` AFTER
 *     ranking (dollars desc), so a bad week surfaces its worst offenders
 *     rather than a wall of rows. Rows are aggregated by pattern, never by
 *     person.
 */

import {
  DETECTORS,
  clusterErrorSignatures,
  rankFindings,
  runDetectors,
  summarizeClusters,
  unusedSkillsFinding,
  unversionedSkillsFinding,
} from "@outerlayer/insights-core";
import type { LlmClient } from "@outerlayer/insights-core";
import type { DetectionSession, Finding, Theme } from "@outerlayer/insights-core";
import type { FindingsScope, FindingsStore } from "../stores/clickhouse/findings-store";
import type { SkillInventoryStore } from "../stores/supabase/skill-inventory-store";
import { resolveTopicsConfig, type TopicsEnv } from "./topics-enrichment-service";

/** Display cap: session_ids on a finding row (session_count keeps the full number). */
const SESSION_IDS_CAP = 8;
/** Postgres insert batch size. */
const INSERT_BATCH = 500;

/**
 * Detection window. Findings describe RECENT waste, and the window bounds the
 * Workers span scan. A constant until someone actually needs a knob.
 */
const FINDINGS_LOOKBACK_DAYS = 14;
/**
 * Scopes with fewer sessions in the window compute nothing — single-player
 * findings read as noise, not a pattern.
 */
const FINDINGS_MIN_SESSIONS = 3;
/** Per-detector finding cap after dollar ranking — worst offenders, not a wall. */
const FINDINGS_MAX_PER_DETECTOR = 5;
/**
 * Activation window for the unused-skills finding. Deliberately LONGER than the
 * detection window: "installed but never used" needs a horizon over which a
 * genuinely-used skill would have fired at least once, and it matches the
 * dashboard's Context adoption overlay so the two surfaces never disagree.
 */
const UNUSED_SKILLS_LOOKBACK_DAYS = 90;

export interface FindingsComputeConfig {
  enabled: boolean;
  tenantAllowlist: string[];
}

/**
 * Findings gate on the SAME enablement as topics enrichment: both are the
 * insight layer, rolled out to the same tenants — one switch, one allowlist,
 * ONE parser. If a tenant ever needs findings and enrichment split, that is
 * the day a narrower override earns its existence.
 */
export function resolveFindingsComputeConfig(env: TopicsEnv): FindingsComputeConfig {
  const { enabled, tenantAllowlist } = resolveTopicsConfig(env);
  return { enabled, tenantAllowlist };
}

/** The Supabase surface the persist step needs — structural, so tests stay simple. */
export interface FindingsPersistClient {
  from(table: "agent_finding" | "agent_theme"): {
    delete(): {
      eq(
        column: "tenant_id",
        value: string,
      ): { eq(column: "app_id", value: string): PromiseLike<{ error: { message: string } | null }> };
    };
    insert(rows: Record<string, unknown>[]): PromiseLike<{ error: { message: string } | null }>;
  };
}

export interface FindingRow {
  tenant_id: string;
  app_id: string;
  detector_id: string;
  severity: string;
  summary: string;
  suggestion: string | null;
  cost_usd: number | null;
  session_count: number;
  session_ids: string[];
  evidence: Finding["evidence"];
  project: string | null;
  computed_at: string;
}

interface ThemeRow {
  tenant_id: string;
  app_id: string;
  label: string;
  description: string;
  severity: string;
  cluster_keys: string[];
  evidence_session_ids: string[];
  computed_at: string;
}

/** Rank (dollars desc) then cap per detector — exported for tests. */
export function capPerDetector(
  findings: Finding[],
  maxPerDetector: number,
): Finding[] {
  const kept: Finding[] = [];
  const counts = new Map<string, number>();
  for (const finding of rankFindings(findings)) {
    const seen = counts.get(finding.detectorId) ?? 0;
    if (seen >= maxPerDetector) continue;
    counts.set(finding.detectorId, seen + 1);
    kept.push(finding);
  }
  return kept;
}

export function toFindingRows(
  scope: FindingsScope,
  findings: Finding[],
  sessions: DetectionSession[],
  computedAt: string,
): FindingRow[] {
  const byId = new Map(sessions.map((s) => [s.id, s]));
  return findings.map((f) => ({
    tenant_id: scope.tenantId,
    app_id: scope.appId,
    detector_id: f.detectorId,
    severity: f.severity,
    summary: f.summary,
    suggestion: f.suggestion ?? null,
    cost_usd: f.costUsd,
    session_count: f.sessionIds.length,
    session_ids: f.sessionIds.slice(0, SESSION_IDS_CAP),
    evidence: f.evidence,
    project: (f.sessionIds[0] ? byId.get(f.sessionIds[0])?.project : null) ?? null,
    computed_at: computedAt,
  }));
}

function toThemeRows(
  scope: FindingsScope,
  themes: Theme[],
  computedAt: string,
): ThemeRow[] {
  return themes.map((t) => ({
    tenant_id: scope.tenantId,
    app_id: scope.appId,
    label: t.label,
    description: t.description,
    severity: t.severity,
    cluster_keys: t.clusterKeys,
    evidence_session_ids: t.evidenceSessionIds,
    computed_at: computedAt,
  }));
}

async function persistScope(
  supabase: FindingsPersistClient,
  scope: FindingsScope,
  findingRows: FindingRow[],
  themeRows: ThemeRow[],
): Promise<void> {
  for (const table of ["agent_finding", "agent_theme"] as const) {
    const { error } = await supabase
      .from(table)
      .delete()
      .eq("tenant_id", scope.tenantId)
      .eq("app_id", scope.appId);
    if (error) throw new Error(`delete ${table}: ${error.message}`);
  }
  const inserts: ["agent_finding" | "agent_theme", (FindingRow | ThemeRow)[]][] = [
    ["agent_finding", findingRows],
    ["agent_theme", themeRows],
  ];
  for (const [table, rows] of inserts) {
    for (let i = 0; i < rows.length; i += INSERT_BATCH) {
      const { error } = await supabase
        .from(table)
        .insert(rows.slice(i, i + INSERT_BATCH) as unknown as Record<string, unknown>[]);
      if (error) throw new Error(`insert ${table}: ${error.message}`);
    }
  }
}

export interface FindingsRunLog {
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
}

export interface FindingsRunResult {
  scopes: number;
  computed: number;
  skippedBelowFloor: number;
  failed: number;
  findings: number;
  themes: number;
}

/**
 * One full compute pass. Scope failures are isolated: a throwing scope logs
 * and moves on, so one bad tenant never blanks the run.
 */
export async function runFindingsCompute(deps: {
  store: FindingsStore;
  supabase: FindingsPersistClient;
  config: FindingsComputeConfig;
  /** Theme labeler on the topics provider stack; null → themes skip, findings unaffected. */
  themesClient: LlmClient | null;
  /** Installed-skill inventory (context mirror); null → the unused-skills finding is skipped. */
  skillInventory: SkillInventoryStore | null;
  log: FindingsRunLog;
  now: () => Date;
}): Promise<FindingsRunResult> {
  const { store, supabase, config, themesClient, skillInventory, log, now } = deps;
  const scopes = (await store.listActiveScopes(FINDINGS_LOOKBACK_DAYS)).filter(
    (scope) =>
      config.tenantAllowlist.length === 0 ||
      config.tenantAllowlist.includes(scope.tenantId),
  );

  const result: FindingsRunResult = {
    scopes: scopes.length,
    computed: 0,
    skippedBelowFloor: 0,
    failed: 0,
    findings: 0,
    themes: 0,
  };

  for (const scope of scopes) {
    try {
      const sessions = await store.loadDetectionSessions(scope, FINDINGS_LOOKBACK_DAYS);
      if (sessions.length < FINDINGS_MIN_SESSIONS) {
        result.skippedBelowFloor += 1;
        continue;
      }

      const findings = capPerDetector(
        runDetectors(DETECTORS, sessions, {}, (detectorId, err) =>
          log.warn("detector failed", { detectorId, error: String(err).slice(0, 200) }),
        ),
        FINDINGS_MAX_PER_DETECTOR,
      );

      // Repo-level skill findings — a matched pair over one two-source join
      // (installed inventory from the mirror × activated skills from CH over a
      // longer window): unused = installed − activated (dead weight),
      // unversioned = relied-on − installed (promote candidates). Isolated so
      // a mirror hiccup drops only these, never the detector findings already
      // computed for the scope. A never-synced mirror (null) skips both — with
      // no repo to compare against, neither verdict is honest.
      if (skillInventory) {
        try {
          const installed = await skillInventory.listInstalledSkills(scope.appId);
          if (installed !== null) {
            const activated = await store.loadActivatedSkills(
              scope,
              UNUSED_SKILLS_LOOKBACK_DAYS,
            );
            const unused = unusedSkillsFinding({
              installedSkills: installed,
              activatedSkillNames: new Set(activated.map((s) => s.skillName)),
              lookbackDays: UNUSED_SKILLS_LOOKBACK_DAYS,
            });
            if (unused) findings.push(unused);
            const unversioned = unversionedSkillsFinding({
              installedSkills: installed,
              activatedSkills: activated,
              lookbackDays: UNUSED_SKILLS_LOOKBACK_DAYS,
            });
            if (unversioned) findings.push(unversioned);
          }
        } catch (err) {
          log.warn("skill findings skipped for scope", {
            tenantId: scope.tenantId,
            appId: scope.appId,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }

      const clusters = clusterErrorSignatures(sessions);
      const summarized = await summarizeClusters(clusters, { client: themesClient });

      const computedAt = now().toISOString();
      const findingRows = toFindingRows(scope, findings, sessions, computedAt);
      const themeRows = toThemeRows(scope, summarized.themes, computedAt);
      await persistScope(supabase, scope, findingRows, themeRows);

      result.computed += 1;
      result.findings += findingRows.length;
      result.themes += themeRows.length;
    } catch (err) {
      result.failed += 1;
      log.warn("findings compute failed for scope", {
        tenantId: scope.tenantId,
        appId: scope.appId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  log.info("findings compute pass complete", { ...result });
  return result;
}
