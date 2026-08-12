/**
 * Agent Fleet Sub-Service
 *
 * Backs the three agent-fleet dashboard templates:
 *  - Agent Fleet Overview: sessions, tool-error-rate, clean-session-rate,
 *    active-actor count (current vs. prior period + daily trend), model mix.
 *  - Repo Activity: cost + sessions + tool-error-rate by branch/agent type,
 *    cost anomalies.
 *  - Agent Execution Health: session-grain percentile TRENDS (cost,
 *    duration, turn count) — never a single blended snapshot number.
 *
 * Reads `agent_session_summary` (one row per coding-agent session), scoped
 * to the app's dominant repo (by cost) unless the caller wants everything —
 * see `queries-agent-fleet.ts`'s header for why.
 *
 * Privacy constraint: this service reads `ActorId` ONLY to compute
 * `uniqExact(ActorId)` — a bare count. It must never expose a per-actor
 * breakdown; see `queries-agent-fleet.ts`'s header comment and
 * `apps/tenant-dashboard/src/lib/dashboards/__tests__/privacy-constraints.test.ts`.
 */

import type { IClickHouseQuery } from '../client';
import { isoToClickHouseDate } from '../date-utils';
import { formatRetentionCutoffDate } from '../shared';
import {
  buildAgentFleetDominantRepoQuery,
  buildAgentFleetTilesQuery,
  buildAgentFleetModelMixQuery,
  buildAgentFleetDimensionQuery,
  buildAgentFleetModelBreakdownQuery,
  buildAgentFleetToolBreakdownQuery,
  buildAgentFleetDailyTrendQuery,
  buildAgentFleetPercentileTrendQuery,
  buildAgentFleetAutonomyMixTrendQuery,
  buildAgentFleetActiveActorTrendQuery,
  buildAgentFleetTrajectorySignalTrendQuery,
  buildAgentFleetCostAnomalyQuery,
  buildAgentPrAttributionQuery,
  buildAgentPrCostAttributionQuery,
  buildAutonomyLadderAttributionQuery,
  computePriorPeriod,
} from '../queries-agent-fleet';
import type {
  DateRange,
  AgentFleetOverviewResponse,
  AgentFleetDimension,
  AgentFleetQueryOptions,
  AgentFleetDimensionResponse,
  AgentFleetPercentileTrendResponse,
  AgentFleetAutonomyMixTrendResponse,
  AgentFleetActiveActorTrendResponse,
  AgentFleetTrajectorySignalTrendResponse,
  AgentFleetCostAnomalyResponse,
  AgentPrAttributionResponse,
  AgentPrAttributionItem,
  AgentPrCostAttributionResponse,
  AgentAutonomyLadderAttributionResponse,
  MetricsBreakdownDimension,
  MetricsBreakdownResponse,
  AgentFleetDailyTrendResponse,
} from '../types';
import type { TenantContext } from '../tenant-context';
import { QUERY_TIMEOUT_SETTINGS, toNumber } from '../shared';

interface RawTileRow {
  period: 'current' | 'prior';
  sessions: string | number;
  actors: string | number;
  toolCalls: string | number;
  toolErrors: string | number;
  cleanSessions: string | number;
  costUsd: string | number;
  // Behavior-rate inputs, scoped to interactive-origin sessions — numerators
  // AND denominators, so each rate is over the population that can actually
  // prompt (see the tiles query header).
  interactiveSessions: string | number;
  interactiveToolCalls: string | number;
  interactiveRejectedToolCalls: string | number;
  interactiveAutoApprovedSessions: string | number;
  interactiveSteeredSessions: string | number;
}

interface RawModelMixRow {
  model: string;
  sessions: string | number;
}

interface RawDimensionRow {
  dimensionValue: string;
  sessions: string | number;
  costUsd: string | number;
  toolErrorRate: string | number;
}

interface RawPercentileTrendRow {
  date: string;
  costP50: string | number;
  costP95: string | number;
  durationP50: string | number;
  durationP95: string | number;
  durationP99: string | number;
  turnCountP95: string | number;
  interventionsMean: string | number;
}

interface RawAutonomyMixTrendRow {
  date: string;
  workerKind: string;
  sessions: string | number;
}

interface RawActiveActorTrendRow {
  date: string;
  activeActors: string | number;
}

interface RawTrajectorySignalTrendRow {
  date: string;
  toolErrorRate: string | number;
  denialRate: string | number;
  handsOnShare: string | number;
}

interface RawCostAnomalyRow {
  dimensionValue: string;
  recentCostUsd: string | number;
  baselineMeanUsd: string | number;
  deltaUsd: string | number;
}

interface RawPrAttributionRow {
  repo: string;
  branch: string;
  prNumber: string | number;
  maxUserTurns: string | number;
}

interface RawPrCostAttributionRow {
  repo: string;
  branch: string;
  prNumber: string | number;
  costUsd: string | number;
}

interface RawAutonomyLadderRow {
  repo: string;
  branch: string;
  prNumber: string | number;
  minLevel: string | number;
  classifiedSessions: string | number;
}

interface RawToolBreakdownRow {
  dimensionValue: string;
  requests: string | number;
  errors: string | number;
}

interface RawDailyTrendRow {
  date: string;
  sessions: string | number;
  costUsd: string | number;
  toolErrorRate: string | number;
  cleanSessionRate: string | number;
}

/** Minimum flagged delta before a cost anomaly surfaces — see the query header. */
const COST_ANOMALY_MIN_DELTA_USD = 1;

export class AgentFleetService {
  constructor(private readonly client: IClickHouseQuery) {}

  /**
   * Resolves the app's dominant repo (by total session cost) — every other
   * method in this service scopes to it. Falls back to `''` (matches every
   * session with no `GitRepo` tag, or none if the app has none) when the app
   * has no repo-tagged sessions yet.
   */
  private async resolveRepo(ctx: TenantContext): Promise<string> {
    const { appId, tenantId } = ctx;
    const q = buildAgentFleetDominantRepoQuery({ appId, tenantId });
    const result = await this.client.query({
      query: q.query,
      query_params: q.params,
      format: 'JSONEachRow',
      clickhouse_settings: QUERY_TIMEOUT_SETTINGS,
    });
    const rows = await result.json<{ repo: string }>();
    return rows[0]?.repo ?? '';
  }

  /**
   * `app` scope (default) resolves the dominant repo first — one extra query;
   * `org` scope needs no repo at all (queries pin TenantId alone), so the
   * resolver round-trip is skipped entirely.
   */
  private async resolveScope(
    ctx: TenantContext,
    options?: AgentFleetQueryOptions,
  ): Promise<{ repo: string; scope: 'app' | 'org' }> {
    if (options?.scope === 'org') return { repo: '', scope: 'org' };
    return { repo: await this.resolveRepo(ctx), scope: 'app' };
  }

  /**
   * The earliest date this tenant may read, given its plan's retention.
   *
   * Every other query surface clamps its start date this way; without it the
   * fleet views answer whatever `startDate` the caller asks for, so a tenant on
   * a short-retention plan reads history it does not retain. `-1` means
   * unlimited and resolves to the epoch, which never wins the comparison.
   *
   * String comparison is exact here because both sides are `YYYY-MM-DD`.
   */
  private clampToRetention(ctx: TenantContext, startDate: string): string {
    const cutoff = formatRetentionCutoffDate(ctx.dataRetentionDays ?? -1);
    return startDate > cutoff ? startDate : cutoff;
  }

  async getAgentFleetOverview(
    ctx: TenantContext,
    dateRange: DateRange,
    options?: AgentFleetQueryOptions,
  ): Promise<AgentFleetOverviewResponse> {
    const { appId, tenantId } = ctx;
    const { repo, scope } = await this.resolveScope(ctx, options);

    const startDate = this.clampToRetention(ctx, isoToClickHouseDate(dateRange.start));
    const endDate = isoToClickHouseDate(dateRange.end);
    const { priorStart } = computePriorPeriod(startDate, endDate);

    const tilesQuery = buildAgentFleetTilesQuery({ appId, tenantId, repo, scope, startDate, endDate, priorStart });
    const modelMixQuery = buildAgentFleetModelMixQuery({ appId, tenantId, repo, scope, startDate, endDate, limit: 6 });

    const [tilesResult, modelMixResult] = await Promise.all([
      this.client.query({
        query: tilesQuery.query,
        query_params: tilesQuery.params,
        format: 'JSONEachRow',
        clickhouse_settings: QUERY_TIMEOUT_SETTINGS,
      }),
      this.client.query({
        query: modelMixQuery.query,
        query_params: modelMixQuery.params,
        format: 'JSONEachRow',
        clickhouse_settings: QUERY_TIMEOUT_SETTINGS,
      }),
    ]);

    const tileRows = await tilesResult.json<RawTileRow>();
    const modelMixRows = await modelMixResult.json<RawModelMixRow>();

    const current = tileRows.find((r) => r.period === 'current');
    const prior = tileRows.find((r) => r.period === 'prior');

    const currentSessions = toNumber(current?.sessions);
    const priorSessions = toNumber(prior?.sessions);
    const currentToolCalls = toNumber(current?.toolCalls);
    const currentToolErrors = toNumber(current?.toolErrors);
    const priorToolCalls = toNumber(prior?.toolCalls);
    const priorToolErrors = toNumber(prior?.toolErrors);
    // Denominators for the behavior rates (hands-on / denial / auto-approve):
    // interactive sessions only, matching their interactive-only numerators.
    const currentInteractiveSessions = toNumber(current?.interactiveSessions);
    const priorInteractiveSessions = toNumber(prior?.interactiveSessions);
    const currentInteractiveToolCalls = toNumber(current?.interactiveToolCalls);
    const priorInteractiveToolCalls = toNumber(prior?.interactiveToolCalls);
    const rate = (numerator: number, denominator: number) => (denominator > 0 ? numerator / denominator : 0);

    return {
      sessions: { current: currentSessions, prior: priorSessions },
      toolErrorRate: {
        current: rate(currentToolErrors, currentToolCalls),
        prior: rate(priorToolErrors, priorToolCalls),
      },
      cleanSessionRate: {
        current: rate(toNumber(current?.cleanSessions), currentSessions),
        prior: rate(toNumber(prior?.cleanSessions), priorSessions),
      },
      handsOnRate: {
        current: rate(toNumber(current?.interactiveSteeredSessions), currentInteractiveSessions),
        prior: rate(toNumber(prior?.interactiveSteeredSessions), priorInteractiveSessions),
      },
      activeActors: { current: toNumber(current?.actors), prior: toNumber(prior?.actors) },
      totalCost: { current: toNumber(current?.costUsd), prior: toNumber(prior?.costUsd) },
      toolDenialRate: {
        current: rate(toNumber(current?.interactiveRejectedToolCalls), currentInteractiveToolCalls),
        prior: rate(toNumber(prior?.interactiveRejectedToolCalls), priorInteractiveToolCalls),
      },
      autoApprovedRate: {
        current: rate(toNumber(current?.interactiveAutoApprovedSessions), currentInteractiveSessions),
        prior: rate(toNumber(prior?.interactiveAutoApprovedSessions), priorInteractiveSessions),
      },
      modelMix: modelMixRows.map((row) => ({ model: row.model, sessions: toNumber(row.sessions) })),
    };
  }

  async getAgentFleetDimensionBreakdown(
    ctx: TenantContext,
    dateRange: DateRange,
    dimension: AgentFleetDimension,
    options?: AgentFleetQueryOptions,
  ): Promise<AgentFleetDimensionResponse> {
    const { appId, tenantId } = ctx;
    const { repo, scope } = await this.resolveScope(ctx, options);
    const startDate = this.clampToRetention(ctx, isoToClickHouseDate(dateRange.start));
    const endDate = isoToClickHouseDate(dateRange.end);

    const q = buildAgentFleetDimensionQuery({ appId, tenantId, repo, scope, dimension, startDate, endDate, limit: 10 });
    const result = await this.client.query({
      query: q.query,
      query_params: q.params,
      format: 'JSONEachRow',
      clickhouse_settings: QUERY_TIMEOUT_SETTINGS,
    });
    const rows = await result.json<RawDimensionRow>();

    return {
      items: rows.map((row) => ({
        dimensionValue: row.dimensionValue,
        sessions: toNumber(row.sessions),
        costUsd: toNumber(row.costUsd),
        toolErrorRate: toNumber(row.toolErrorRate),
      })),
    };
  }

  /**
   * Cost/session/error ranking for one dimension — the unified read behind
   * `GET /v1/metrics/breakdown`. `branch`/`agent_type`/`worker_kind` and
   * `model` are `agent_session_summary` reads scoped to the resolved repo
   * (like every other dimension query in this service); `tool` reads
   * `otel_traces` scoped to tenant+app only (see
   * `buildAgentFleetToolBreakdownQuery`) — the one dimension with no
   * session-grain cost to rank by, so its items carry `requests` instead of
   * `sessions`/`costUsd`.
   */
  async getAgentFleetMetricsBreakdown(
    ctx: TenantContext,
    dateRange: DateRange,
    dimension: MetricsBreakdownDimension,
    limit: number,
    options?: AgentFleetQueryOptions,
  ): Promise<MetricsBreakdownResponse> {
    const { appId, tenantId } = ctx;
    const endDate = isoToClickHouseDate(dateRange.end);

    if (dimension === 'tool') {
      const startDate = this.clampToRetention(ctx, isoToClickHouseDate(dateRange.start));
      const q = buildAgentFleetToolBreakdownQuery({ appId, tenantId, startDate, endDate, limit });
      const result = await this.client.query({
        query: q.query,
        query_params: q.params,
        format: 'JSONEachRow',
        clickhouse_settings: QUERY_TIMEOUT_SETTINGS,
      });
      const rows = await result.json<RawToolBreakdownRow>();
      return {
        dimension,
        items: rows.map((row) => {
          const requests = toNumber(row.requests);
          const errors = toNumber(row.errors);
          return {
            key: row.dimensionValue,
            requests,
            toolErrorRate: requests > 0 ? errors / requests : 0,
          };
        }),
      };
    }

    const { repo, scope } = await this.resolveScope(ctx, options);
    const startDate = this.clampToRetention(ctx, isoToClickHouseDate(dateRange.start));

    if (dimension === 'model') {
      const q = buildAgentFleetModelBreakdownQuery({ appId, tenantId, repo, scope, startDate, endDate, limit });
      const result = await this.client.query({
        query: q.query,
        query_params: q.params,
        format: 'JSONEachRow',
        clickhouse_settings: QUERY_TIMEOUT_SETTINGS,
      });
      const rows = await result.json<RawDimensionRow>();
      return {
        dimension,
        items: rows.map((row) => ({
          key: row.dimensionValue,
          sessions: toNumber(row.sessions),
          costUsd: toNumber(row.costUsd),
          toolErrorRate: toNumber(row.toolErrorRate),
        })),
      };
    }

    const q = buildAgentFleetDimensionQuery({ appId, tenantId, repo, scope, dimension, startDate, endDate, limit });
    const result = await this.client.query({
      query: q.query,
      query_params: q.params,
      format: 'JSONEachRow',
      clickhouse_settings: QUERY_TIMEOUT_SETTINGS,
    });
    const rows = await result.json<RawDimensionRow>();
    return {
      dimension,
      items: rows.map((row) => ({
        key: row.dimensionValue,
        sessions: toNumber(row.sessions),
        costUsd: toNumber(row.costUsd),
        toolErrorRate: toNumber(row.toolErrorRate),
      })),
    };
  }

  /**
   * Daily sessions/cost/tool-error-rate/clean-session-rate — the unified
   * read behind `GET /v1/metrics/trends`. One `agent_session_summary` scan
   * bucketed per day; see `buildAgentFleetDailyTrendQuery` for why this
   * doesn't reuse `queries.ts`'s `otel_traces` cost trend.
   */
  async getAgentFleetDailyTrend(
    ctx: TenantContext,
    dateRange: DateRange,
    options?: AgentFleetQueryOptions,
  ): Promise<AgentFleetDailyTrendResponse> {
    const { appId, tenantId } = ctx;
    const { repo, scope } = await this.resolveScope(ctx, options);
    const startDate = this.clampToRetention(ctx, isoToClickHouseDate(dateRange.start));
    const endDate = isoToClickHouseDate(dateRange.end);

    const q = buildAgentFleetDailyTrendQuery({ appId, tenantId, repo, scope, startDate, endDate });
    const result = await this.client.query({
      query: q.query,
      query_params: q.params,
      format: 'JSONEachRow',
      clickhouse_settings: QUERY_TIMEOUT_SETTINGS,
    });
    const rows = await result.json<RawDailyTrendRow>();

    return {
      points: rows.map((row) => ({
        date: row.date,
        sessions: toNumber(row.sessions),
        costUsd: toNumber(row.costUsd),
        toolErrorRate: toNumber(row.toolErrorRate),
        cleanSessionRate: toNumber(row.cleanSessionRate),
      })),
    };
  }

  async getAgentFleetPercentileTrend(
    ctx: TenantContext,
    dateRange: DateRange,
    options?: AgentFleetQueryOptions,
  ): Promise<AgentFleetPercentileTrendResponse> {
    const { appId, tenantId } = ctx;
    const { repo, scope } = await this.resolveScope(ctx, options);
    const startDate = this.clampToRetention(ctx, isoToClickHouseDate(dateRange.start));
    const endDate = isoToClickHouseDate(dateRange.end);

    const q = buildAgentFleetPercentileTrendQuery({ appId, tenantId, repo, scope, startDate, endDate });
    const result = await this.client.query({
      query: q.query,
      query_params: q.params,
      format: 'JSONEachRow',
      clickhouse_settings: QUERY_TIMEOUT_SETTINGS,
    });
    const rows = await result.json<RawPercentileTrendRow>();

    return {
      points: rows.map((row) => ({
        date: row.date,
        costP50: toNumber(row.costP50),
        costP95: toNumber(row.costP95),
        durationP50Ms: toNumber(row.durationP50),
        durationP95Ms: toNumber(row.durationP95),
        durationP99Ms: toNumber(row.durationP99),
        turnCountP95: toNumber(row.turnCountP95),
        interventionsMean: toNumber(row.interventionsMean),
      })),
    };
  }

  /**
   * Daily session counts by worker kind (run-origin: seat | cloud | ci |
   * shared) — the autonomy-mix trend. Legacy unlabeled rows are excluded,
   * never guessed (see `buildAgentFleetAutonomyMixTrendQuery`).
   */
  async getAgentFleetAutonomyMixTrend(
    ctx: TenantContext,
    dateRange: DateRange,
    options?: AgentFleetQueryOptions,
  ): Promise<AgentFleetAutonomyMixTrendResponse> {
    const { appId, tenantId } = ctx;
    const { repo, scope } = await this.resolveScope(ctx, options);
    const startDate = this.clampToRetention(ctx, isoToClickHouseDate(dateRange.start));
    const endDate = isoToClickHouseDate(dateRange.end);

    const q = buildAgentFleetAutonomyMixTrendQuery({ appId, tenantId, repo, scope, startDate, endDate });
    const result = await this.client.query({
      query: q.query,
      query_params: q.params,
      format: 'JSONEachRow',
      clickhouse_settings: QUERY_TIMEOUT_SETTINGS,
    });
    const rows = await result.json<RawAutonomyMixTrendRow>();

    return {
      points: rows.map((row) => ({
        date: row.date,
        workerKind: row.workerKind,
        sessions: toNumber(row.sessions),
      })),
    };
  }

  async getAgentFleetActiveActorTrend(
    ctx: TenantContext,
    dateRange: DateRange,
    options?: AgentFleetQueryOptions,
  ): Promise<AgentFleetActiveActorTrendResponse> {
    const { appId, tenantId } = ctx;
    const { repo, scope } = await this.resolveScope(ctx, options);
    const startDate = this.clampToRetention(ctx, isoToClickHouseDate(dateRange.start));
    const endDate = isoToClickHouseDate(dateRange.end);

    const q = buildAgentFleetActiveActorTrendQuery({ appId, tenantId, repo, scope, startDate, endDate });
    const result = await this.client.query({
      query: q.query,
      query_params: q.params,
      format: 'JSONEachRow',
      clickhouse_settings: QUERY_TIMEOUT_SETTINGS,
    });
    const rows = await result.json<RawActiveActorTrendRow>();

    return {
      points: rows.map((row) => ({ date: row.date, activeActors: toNumber(row.activeActors) })),
    };
  }

  /**
   * Daily trajectory-signal rates — tool-error rate (every origin), denial
   * rate and hands-on-session share (interactive origins only) — as one
   * trend. Rates only; see `buildAgentFleetTrajectorySignalTrendQuery`.
   */
  async getAgentFleetTrajectorySignalTrend(
    ctx: TenantContext,
    dateRange: DateRange,
    options?: AgentFleetQueryOptions,
  ): Promise<AgentFleetTrajectorySignalTrendResponse> {
    const { appId, tenantId } = ctx;
    const { repo, scope } = await this.resolveScope(ctx, options);
    const startDate = this.clampToRetention(ctx, isoToClickHouseDate(dateRange.start));
    const endDate = isoToClickHouseDate(dateRange.end);

    const q = buildAgentFleetTrajectorySignalTrendQuery({ appId, tenantId, repo, scope, startDate, endDate });
    const result = await this.client.query({
      query: q.query,
      query_params: q.params,
      format: 'JSONEachRow',
      clickhouse_settings: QUERY_TIMEOUT_SETTINGS,
    });
    const rows = await result.json<RawTrajectorySignalTrendRow>();

    return {
      points: rows.map((row) => ({
        date: row.date,
        toolErrorRate: toNumber(row.toolErrorRate),
        denialRate: toNumber(row.denialRate),
        handsOnShare: toNumber(row.handsOnShare),
      })),
    };
  }

  /**
   * The session→PR attribution set for the dominant repo: distinct session
   * branches + explicitly linked PR numbers, deduped and cleaned (`''`
   * branches and `0` PrNumbers are "absent", not values). Deliberately not
   * date-windowed — see `buildAgentPrAttributionQuery`.
   */
  async getAgentPrAttribution(ctx: TenantContext, options?: AgentFleetQueryOptions): Promise<AgentPrAttributionResponse> {
    const { appId, tenantId } = ctx;
    const { repo, scope } = await this.resolveScope(ctx, options);

    const q = buildAgentPrAttributionQuery({ appId, tenantId, repo, scope });
    const result = await this.client.query({
      query: q.query,
      query_params: q.params,
      format: 'JSONEachRow',
      clickhouse_settings: QUERY_TIMEOUT_SETTINGS,
    });
    const rows = await result.json<RawPrAttributionRow>();

    const branches = new Set<string>();
    const prNumbers = new Set<number>();
    const steeredPrNumbers = new Set<number>();
    const items: AgentPrAttributionItem[] = [];
    for (const row of rows) {
      const n = toNumber(row.prNumber);
      const steered = toNumber(row.maxUserTurns) > 1;
      items.push({ repo: row.repo, branch: row.branch, prNumber: n, steered });
      if (row.branch !== '') branches.add(row.branch);
      if (n > 0) {
        prNumbers.add(n);
        // A PR is steered if ANY of its sessions needed mid-session steering
        // (UserTurnCount > 1). max() over the group already collapses the
        // session rows for this (branch, PR), and the union across groups keeps
        // a PR steered if it's steered on any branch.
        if (steered) steeredPrNumbers.add(n);
      }
    }
    return { branches: [...branches], prNumbers: [...prNumbers], steeredPrNumbers: [...steeredPrNumbers], items };
  }

  /**
   * Per-(branch, PR-number) agent session spend for the dominant repo — the
   * numerator for direct cost-per-merged-PR. Same repo scope and no date
   * filter as `getAgentPrAttribution` (a PR's cost spans every session that
   * touched it). Rows are passed through verbatim (cost coerced to a
   * number); the caller decides which merged PR each group attributes to.
   */
  async getAgentPrCostAttribution(
    ctx: TenantContext,
    options?: AgentFleetQueryOptions,
  ): Promise<AgentPrCostAttributionResponse> {
    const { appId, tenantId } = ctx;
    const { repo, scope } = await this.resolveScope(ctx, options);

    const q = buildAgentPrCostAttributionQuery({ appId, tenantId, repo, scope });
    const result = await this.client.query({
      query: q.query,
      query_params: q.params,
      format: 'JSONEachRow',
      clickhouse_settings: QUERY_TIMEOUT_SETTINGS,
    });
    const rows = await result.json<RawPrCostAttributionRow>();

    return {
      items: rows.map((row) => ({
        repo: row.repo,
        branch: row.branch,
        prNumber: toNumber(row.prNumber),
        costUsd: toNumber(row.costUsd),
      })),
    };
  }

  /**
   * Per-(repo, branch, PR) minimum session autonomy level — the ladder's
   * session-side input. Same scope + no-date-filter posture as the other
   * attribution reads; the PR-side cohort (merged-in-window) is applied by
   * the caller's pure math, not here.
   */
  async getAutonomyLadderAttribution(
    ctx: TenantContext,
    options?: AgentFleetQueryOptions,
  ): Promise<AgentAutonomyLadderAttributionResponse> {
    const { appId, tenantId } = ctx;
    const { repo, scope } = await this.resolveScope(ctx, options);

    const q = buildAutonomyLadderAttributionQuery({ appId, tenantId, repo, scope });
    const result = await this.client.query({
      query: q.query,
      query_params: q.params,
      format: 'JSONEachRow',
      clickhouse_settings: QUERY_TIMEOUT_SETTINGS,
    });
    const rows = await result.json<RawAutonomyLadderRow>();

    return {
      items: rows.map((row) => ({
        repo: row.repo,
        branch: row.branch,
        prNumber: toNumber(row.prNumber),
        minLevel: toNumber(row.minLevel),
        classifiedSessions: toNumber(row.classifiedSessions),
      })),
    };
  }

  async getAgentFleetCostAnomalies(
    ctx: TenantContext,
    dateRange: DateRange,
    options?: AgentFleetQueryOptions,
  ): Promise<AgentFleetCostAnomalyResponse> {
    const { appId, tenantId } = ctx;
    const { repo, scope } = await this.resolveScope(ctx, options);
    const startDate = this.clampToRetention(ctx, isoToClickHouseDate(dateRange.start));
    const latestDate = isoToClickHouseDate(dateRange.end);

    const q = buildAgentFleetCostAnomalyQuery({
      appId,
      tenantId,
      repo,
      scope,
      startDate,
      latestDate,
      minDeltaUsd: COST_ANOMALY_MIN_DELTA_USD,
      limit: 10,
    });
    const result = await this.client.query({
      query: q.query,
      query_params: q.params,
      format: 'JSONEachRow',
      clickhouse_settings: QUERY_TIMEOUT_SETTINGS,
    });
    const rows = await result.json<RawCostAnomalyRow>();

    return {
      items: rows.map((row) => ({
        dimensionValue: row.dimensionValue,
        recentCostUsd: toNumber(row.recentCostUsd),
        baselineMeanUsd: toNumber(row.baselineMeanUsd),
        deltaUsd: toNumber(row.deltaUsd),
      })),
    };
  }
}
