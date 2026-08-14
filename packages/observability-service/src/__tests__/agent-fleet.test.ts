/**
 * Agent Fleet Service + query-builder tests.
 *
 * Reads `agent_session_summary` (one row per coding-agent session), scoped
 * to the app's dominant repo. Coverage focus: the current-vs-prior period
 * math (`computePriorPeriod`, pure and easy to get subtly wrong), the
 * tool-error-rate / clean-session-rate division (a div-by-zero trap),
 * dominant-repo resolution and its "no repo yet" fallback, the cost-anomaly
 * threshold/guard logic, and — the part that keeps the feature private —
 * that every query only ever selects/groups by impersonal dimensions
 * (branch, agent type, model), reading `ActorId` only for `uniqExact`.
 */

import { AgentFleetService } from '../services/agent-fleet';
import { AnalyticsService } from '../service';
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
import type { TenantContext, VerifiedAppId } from '../tenant-context';

describe('computePriorPeriod', () => {
  it('returns the immediately preceding window of equal length (7-day range)', () => {
    // current = Jan 8..14 (7 days inclusive) → prior = Jan 1..7 (7 days)
    const { priorStart } = computePriorPeriod('2024-01-08', '2024-01-14');
    expect(priorStart).toBe('2024-01-01');
  });

  it('returns a single-day prior period for a single-day range', () => {
    const { priorStart } = computePriorPeriod('2024-01-15', '2024-01-15');
    expect(priorStart).toBe('2024-01-14');
  });

  it('handles a month boundary correctly', () => {
    const { priorStart } = computePriorPeriod('2024-03-01', '2024-03-03');
    expect(priorStart).toBe('2024-02-27');
  });
});

describe('buildAgentFleetDominantRepoQuery', () => {
  it('groups by GitRepo, orders by total cost, and excludes untagged sessions', () => {
    const { query, params } = buildAgentFleetDominantRepoQuery({ appId: 'app-1', tenantId: 'tenant-1' });
    expect(query).toContain('GROUP BY GitRepo');
    expect(query).toContain('ORDER BY sum(CostUsd) DESC');
    expect(query).toContain("GitRepo != ''");
    expect(query).toContain('LIMIT 1');
    expect(params).toEqual({ appId: 'app-1', tenantId: 'tenant-1' });
  });
});

const repoScope = { appId: 'app-1', tenantId: 'tenant-1', repo: 'github.com/agentmark-ai/app' };

describe('buildAgentFleetTilesQuery', () => {
  const input = { ...repoScope, startDate: '2024-01-08', endDate: '2024-01-14', priorStart: '2024-01-01' };

  it('scopes to agent_session_summary by tenant + app + repo — never ActorId as a filter or groupBy', () => {
    const { query } = buildAgentFleetTilesQuery(input);
    expect(query).toContain('FROM agent_session_summary FINAL');
    expect(query).toContain('AppId = {appId:String}');
    expect(query).toContain('TenantId = {tenantId:String}');
    expect(query).toContain('GitRepo = {repo:String}');
    // The ONLY use of ActorId is uniqExact — a count, never a per-row SELECT
    // or a GROUP BY dimension.
    expect(query).toContain('uniqExact(ActorId) AS actors');
    expect(query).not.toMatch(/GROUP BY[^)]*ActorId/i);
    expect(query).not.toContain('ActorId AS');
  });

  it('projects cleanSessions (ErrorCount = 0) alongside the tool-call inputs', () => {
    const { query } = buildAgentFleetTilesQuery(input);
    expect(query).toContain('countIf(ErrorCount = 0) AS cleanSessions');
  });

  it('projects steeredSessions (UserTurnCount > 1) over interactive origins only, for the hands-on rate tile', () => {
    const { query } = buildAgentFleetTilesQuery(input);
    // UserTurnCount > 1 = a human stepped in past the initial task hand-off;
    // backs agent_hands_on_rate. It must be `> 1`, not `>= 1`: the first user
    // turn is the task itself, not steering. The origin predicate matters just
    // as much, because headless/worker runs can't be steered. Unclassified ''
    // rows count as interactive, since data written before origin
    // classification is overwhelmingly human and heals on re-sync.
    expect(query).toContain(
      "countIf(UserTurnCount > 1 AND Origin IN ('', 'interactive')) AS interactiveSteeredSessions"
    );
  });

  it('projects total session cost (sum of CostUsd) for the Total Spend tile', () => {
    const { query } = buildAgentFleetTilesQuery(input);
    // Backs total_agent_cost — the agent-session spend sum, bucketed
    // current/prior in the same scan as the other tiles.
    expect(query).toContain('sum(CostUsd) AS costUsd');
  });

  it('projects the steering signals over interactive origins: rejected tool calls and prompt-free sessions', () => {
    const { query } = buildAgentFleetTilesQuery(input);
    // Backs agent_tool_denial_rate (rejected ÷ interactive tool calls) …
    expect(query).toContain(
      "sumIf(RejectedToolCallCount, Origin IN ('', 'interactive')) AS interactiveRejectedToolCalls"
    );
    // … and agent_auto_approved_rate, where `= 0` is the whole definition: a
    // session is auto-approved only if it never stopped to ask at all. Origin
    // scoping is what keeps the tile meaningful: a headless run never prompts,
    // so counting it would peg the rate at 100% by construction.
    expect(query).toContain(
      "countIf(PermissionPromptCount = 0 AND Origin IN ('', 'interactive')) AS interactiveAutoApprovedSessions"
    );
  });

  it('projects interactive-population denominators alongside the interactive numerators', () => {
    const { query } = buildAgentFleetTilesQuery(input);
    // A rate over the interactive population needs BOTH sides scoped — an
    // interactive numerator over an all-sessions denominator would just
    // understate every behavior rate instead of fixing it.
    expect(query).toContain("countIf(Origin IN ('', 'interactive')) AS interactiveSessions");
    expect(query).toContain("sumIf(ToolCallCount, Origin IN ('', 'interactive')) AS interactiveToolCalls");
  });

  it('keeps the activity/quality/cost aggregates all-inclusive — no origin filter on the scan or the fleet truth columns', () => {
    const { query } = buildAgentFleetTilesQuery(input);
    // Spend, session count, actors, tool volume/errors, and clean sessions
    // are fleet-wide truth: an agent run's dollars and failures are real.
    // The origin predicate must live only inside the interactive aggregates,
    // never in WHERE (which would silently shrink every tile).
    expect(query).not.toMatch(/WHERE[\s\S]*Origin/);
    expect(query).toContain('count() AS sessions');
    expect(query).toContain('uniqExact(ActorId) AS actors');
    expect(query).toContain('sum(ToolCallCount) AS toolCalls');
    expect(query).toContain('sum(ErrorCount) AS toolErrors');
    expect(query).toContain('countIf(ErrorCount = 0) AS cleanSessions');
  });

  it('binds every param the query references, with no extras', () => {
    const { params } = buildAgentFleetTilesQuery(input);
    expect(params).toEqual({
      tenantId: 'tenant-1',
      appId: 'app-1',
      repo: 'github.com/agentmark-ai/app',
      startDate: '2024-01-08',
      endDate: '2024-01-14',
      priorStart: '2024-01-01',
    });
  });

  it("org scope drops the app/repo predicates (tenant-wide sweep) and their params — TenantId stays", () => {
    const { query, params } = buildAgentFleetTilesQuery({ ...input, scope: 'org' });
    expect(query).toContain('TenantId = {tenantId:String}');
    expect(query).not.toContain('AppId');
    expect(query).not.toContain('GitRepo');
    expect(params).toEqual({
      tenantId: 'tenant-1',
      startDate: '2024-01-08',
      endDate: '2024-01-14',
      priorStart: '2024-01-01',
    });
  });
});

describe('buildAgentFleetModelMixQuery', () => {
  it('array-joins Models and groups by model, never by an identity dimension', () => {
    const { query, params } = buildAgentFleetModelMixQuery({
      ...repoScope,
      startDate: '2024-01-08',
      endDate: '2024-01-14',
      limit: 6,
    });
    expect(query).toContain('ARRAY JOIN Models AS model');
    expect(query).toContain('GROUP BY model');
    expect(query).not.toContain('ActorId');
    expect(params.limit).toBe(6);
  });
});

describe('buildAgentFleetDimensionQuery', () => {
  // The column is spliced into GROUP BY and a WHERE. An object-literal map
  // answers an inherited key with a truthy function, so a caller passing an
  // unvalidated string would build a query around it rather than fail.
  it.each(['constructor', '__proto__', 'toString', 'hasOwnProperty', 'valueOf'])(
    'throws rather than build a query for the inherited dimension %s',
    inherited => {
      expect(() =>
        buildAgentFleetDimensionQuery({
          ...repoScope,
          dimension: inherited as never,
          startDate: '2024-01-08',
          endDate: '2024-01-14',
          limit: 10,
        }),
      ).toThrow(/unknown dimension/);
    },
  );

  it('groups by GitBranch for the "branch" dimension', () => {
    const { query } = buildAgentFleetDimensionQuery({
      ...repoScope,
      dimension: 'branch',
      startDate: '2024-01-08',
      endDate: '2024-01-14',
      limit: 10,
    });
    expect(query).toContain('GitBranch AS dimensionValue');
    expect(query).toContain('GROUP BY dimensionValue');
    expect(query).not.toContain('ActorId');
  });

  it('groups by AgentType for the "agent_type" dimension', () => {
    const { query } = buildAgentFleetDimensionQuery({
      ...repoScope,
      dimension: 'agent_type',
      startDate: '2024-01-08',
      endDate: '2024-01-14',
      limit: 10,
    });
    expect(query).toContain('AgentType AS dimensionValue');
    expect(query).not.toContain('GitBranch AS dimensionValue');
    expect(query).not.toContain('ActorId');
  });

  it('projects cost, session count, AND tool-error-rate for the same dimension in one row', () => {
    const { query } = buildAgentFleetDimensionQuery({
      ...repoScope,
      dimension: 'branch',
      startDate: '2024-01-08',
      endDate: '2024-01-14',
      limit: 10,
    });
    expect(query).toContain('count() AS sessions');
    expect(query).toContain('sum(CostUsd) AS costUsd');
    // Errors ÷ tool calls — the SAME definition as the overview tiles, so
    // "Tool Error Rate" means one thing everywhere (zero calls → 0, not NaN).
    expect(query).toContain(
      'if(sum(ToolCallCount) > 0, sum(ErrorCount) / sum(ToolCallCount), 0) AS toolErrorRate'
    );
    expect(query).not.toContain('countIf(ErrorCount > 0) / count()');
  });

  it('org scope repo-qualifies branch labels and requires a repo tag — `main` in two repos never merges', () => {
    const { query, params } = buildAgentFleetDimensionQuery({
      ...repoScope,
      scope: 'org',
      dimension: 'branch',
      startDate: '2024-01-08',
      endDate: '2024-01-14',
      limit: 10,
    });
    expect(query).toContain("concat(GitRepo, ':', GitBranch) AS dimensionValue");
    expect(query).toContain("GitRepo != ''");
    // Tenant-wide sweep: no app/repo pin.
    expect(query).not.toContain('AppId');
    expect(query).not.toContain('GitRepo = {repo:String}');
    expect(params).toEqual({ tenantId: 'tenant-1', startDate: '2024-01-08', endDate: '2024-01-14', limit: 10 });
  });

  it('org scope leaves global taxonomies (worker_kind) unqualified — no repo prefix', () => {
    const { query } = buildAgentFleetDimensionQuery({
      ...repoScope,
      scope: 'org',
      dimension: 'worker_kind',
      startDate: '2024-01-08',
      endDate: '2024-01-14',
      limit: 10,
    });
    expect(query).toContain('WorkerKind AS dimensionValue');
    expect(query).not.toContain('concat');
  });
});

describe('buildAgentFleetModelBreakdownQuery', () => {
  it('array-joins Models and projects cost, session count, AND tool-error-rate per model', () => {
    const { query, params } = buildAgentFleetModelBreakdownQuery({
      ...repoScope,
      startDate: '2024-01-08',
      endDate: '2024-01-14',
      limit: 10,
    });
    expect(query).toContain('ARRAY JOIN Models AS model');
    expect(query).toContain('model AS dimensionValue');
    expect(query).toContain('uniqExact(TraceId) AS sessions');
    expect(query).toContain('sum(CostUsd) AS costUsd');
    expect(query).toContain(
      'if(sum(ToolCallCount) > 0, sum(ErrorCount) / sum(ToolCallCount), 0) AS toolErrorRate',
    );
    expect(query).toContain("AND model != ''");
    expect(query).not.toContain('ActorId');
    expect(params).toEqual({
      appId: 'app-1',
      tenantId: 'tenant-1',
      repo: repoScope.repo,
      startDate: '2024-01-08',
      endDate: '2024-01-14',
      limit: 10,
    });
  });
});

describe('buildAgentFleetToolBreakdownQuery', () => {
  const input = { appId: 'app-1', tenantId: 'tenant-1', startDate: '2024-01-08', endDate: '2024-01-14', limit: 10 };

  it('reads otel_traces scoped to tenant + app only (no repo pin) and filters tool spans', () => {
    const { query, params } = buildAgentFleetToolBreakdownQuery(input);
    expect(query).toContain('FROM otel_traces FINAL');
    expect(query).toContain("SpanName LIKE 'agent.tool.%'");
    expect(query).toContain('TenantId = {tenantId:String}');
    expect(query).toContain('AppId = {appId:String}');
    expect(query).not.toContain('GitRepo');
    expect(params).toEqual({
      tenantId: 'tenant-1',
      appId: 'app-1',
      startDate: '2024-01-08',
      endDate: '2024-01-14',
      limit: 10,
    });
  });

  it('strips the "agent.tool." prefix and counts requests + errors', () => {
    const { query } = buildAgentFleetToolBreakdownQuery(input);
    expect(query).toContain('substringUTF8(SpanName, 12) AS dimensionValue');
    expect(query).toContain('count() AS requests');
    expect(query).toContain("countIf(StatusCode IN ('2', 'STATUS_CODE_ERROR', 'ERROR', 'Error')) AS errors");
  });
});

describe('buildAgentFleetDailyTrendQuery', () => {
  it('buckets agent_session_summary by day and projects sessions/cost/toolErrorRate/cleanSessionRate', () => {
    const { query, params } = buildAgentFleetDailyTrendQuery({
      ...repoScope,
      startDate: '2024-01-08',
      endDate: '2024-01-14',
    });
    expect(query).toContain('FROM agent_session_summary FINAL');
    expect(query).toContain('toDate(StartedAt) AS date');
    expect(query).toContain('GROUP BY date');
    expect(query).toContain('ORDER BY date ASC');
    expect(query).toContain('count() AS sessions');
    expect(query).toContain('sum(CostUsd) AS costUsd');
    expect(query).toContain(
      'if(sum(ToolCallCount) > 0, sum(ErrorCount) / sum(ToolCallCount), 0) AS toolErrorRate',
    );
    expect(query).toContain(
      'if(count() > 0, countIf(ErrorCount = 0) / count(), 0) AS cleanSessionRate',
    );
    expect(params).toEqual({
      appId: 'app-1',
      tenantId: 'tenant-1',
      repo: repoScope.repo,
      startDate: '2024-01-08',
      endDate: '2024-01-14',
    });
  });
});

describe('buildAgentFleetPercentileTrendQuery', () => {
  it('buckets by day and computes cost/duration/turn-count percentiles per day — never a single blended number', () => {
    const { query, params } = buildAgentFleetPercentileTrendQuery({
      ...repoScope,
      startDate: '2024-01-08',
      endDate: '2024-01-14',
    });
    expect(query).toContain('GROUP BY date');
    expect(query).toContain('ORDER BY date');
    // Rows roll up to the root session BEFORE any percentile is taken:
    // agent_session_summary is one row per trace, so percentiles over raw rows
    // would enter each resumption and each subagent as its own "session".
    expect(query).toContain(
      "GROUP BY if(ParentSessionId != '', ParentSessionId, if(SessionId != '', SessionId, TraceId))",
    );
    expect(query).toContain('sum(CostUsd) AS sessionCostUsd');
    expect(query).toContain(
      "dateDiff('millisecond', min(StartedAt), max(EndedAt)) AS sessionDurationMs",
    );
    // Percentiles read the rolled-up figures, never the per-trace columns.
    expect(query).toContain('quantile(0.5)(sessionCostUsd) AS costP50');
    expect(query).toContain('quantile(0.95)(sessionCostUsd) AS costP95');
    expect(query).toContain('quantile(0.95)(rootTurnCount) AS turnCountP95');
    expect(query).not.toContain('quantile(0.5)(CostUsd)');
    expect(query).not.toContain('quantile(0.95)(CostUsd)');
    expect(query).not.toContain('quantile(0.95)(TurnCount)');
    expect(query).not.toContain("dateDiff('millisecond', StartedAt, EndedAt)");
    // Turn count and steering come from the ROOT transcript — a subagent's
    // turns are programmatic, not conversation.
    expect(query).toContain("argMax(TurnCount, (ParentSessionId = '', TurnCount)) AS rootTurnCount");
    expect(query).toContain("rootOrigin IN ('', 'interactive')");
    expect(query).not.toContain('ActorId');
    expect(params).toEqual({
      tenantId: 'tenant-1',
      appId: 'app-1',
      repo: 'github.com/agentmark-ai/app',
      startDate: '2024-01-08',
      endDate: '2024-01-14',
    });
  });
});

describe('buildAgentFleetActiveActorTrendQuery', () => {
  it('buckets uniqExact(ActorId) by day — a count trend, never a list', () => {
    const { query } = buildAgentFleetActiveActorTrendQuery({
      ...repoScope,
      startDate: '2024-01-08',
      endDate: '2024-01-14',
    });
    expect(query).toContain('uniqExact(ActorId) AS activeActors');
    expect(query).toContain('GROUP BY date');
    expect(query).not.toContain('ActorId AS');
  });
});

describe('buildAgentFleetTrajectorySignalTrendQuery', () => {
  const input = { ...repoScope, startDate: '2024-01-08', endDate: '2024-01-14' };

  it('buckets by day: tool-error rate over every origin, denial rate and hands-on share over interactive origins only', () => {
    const { query } = buildAgentFleetTrajectorySignalTrendQuery(input);
    expect(query).toContain('GROUP BY date');
    // Fleet quality truth: no origin predicate on the tool-error rate.
    expect(query).toContain('if(sum(ToolCallCount) > 0, sum(ErrorCount) / sum(ToolCallCount), 0) AS toolErrorRate');
    // Behavior rates: interactive numerator AND denominator.
    expect(query).toContain("sumIf(RejectedToolCallCount, Origin IN ('', 'interactive')) / sumIf(ToolCallCount, Origin IN ('', 'interactive'))");
    expect(query).toContain("countIf(UserTurnCount > 1 AND Origin IN ('', 'interactive')) / countIf(Origin IN ('', 'interactive'))");
    expect(query).not.toContain('ActorId');
  });

  it('binds every param the query references, with no extras', () => {
    const { params } = buildAgentFleetTrajectorySignalTrendQuery(input);
    expect(params).toEqual({
      tenantId: 'tenant-1',
      appId: 'app-1',
      repo: 'github.com/agentmark-ai/app',
      startDate: '2024-01-08',
      endDate: '2024-01-14',
    });
  });

  it('org scope drops the app/repo predicates like every other fleet query', () => {
    const { query, params } = buildAgentFleetTrajectorySignalTrendQuery({ ...input, scope: 'org' });
    expect(query).not.toContain('AppId');
    expect(query).not.toContain('GitRepo');
    expect(params).toEqual({ tenantId: 'tenant-1', startDate: '2024-01-08', endDate: '2024-01-14' });
  });
});

describe('buildAgentFleetCostAnomalyQuery', () => {
  const input = { ...repoScope, startDate: '2024-01-01', latestDate: '2024-01-14', minDeltaUsd: 1, limit: 10 };

  it('groups by GitBranch, splits baseline (before latestDate) from recent (= latestDate), never touches ActorId', () => {
    const { query } = buildAgentFleetCostAnomalyQuery(input);
    expect(query).toContain('GitBranch AS branch');
    expect(query).toContain("avgIf(dailyCost, date < {latestDate:Date}) AS baselineMean");
    expect(query).toContain("stddevPopIf(dailyCost, date < {latestDate:Date}) AS baselineStddev");
    expect(query).toContain("sumIf(dailyCost, date = {latestDate:Date}) AS recentCost");
    expect(query).not.toContain('ActorId');
  });

  it('requires at least 3 baseline days, a positive stddev, a 2-sigma threshold, and a dollar floor', () => {
    const { query } = buildAgentFleetCostAnomalyQuery(input);
    expect(query).toContain('baselineDays >= 3');
    expect(query).toContain('baselineStddev > 0');
    expect(query).toContain('recentCost > baselineMean + (2 * baselineStddev)');
    expect(query).toContain('(recentCost - baselineMean) >= {minDeltaUsd:Float64}');
  });

  it('binds every param the query references', () => {
    const { params } = buildAgentFleetCostAnomalyQuery(input);
    expect(params).toEqual({
      tenantId: 'tenant-1',
      appId: 'app-1',
      repo: 'github.com/agentmark-ai/app',
      startDate: '2024-01-01',
      latestDate: '2024-01-14',
      minDeltaUsd: 1,
      limit: 10,
    });
  });
});

describe('buildAgentPrAttributionQuery', () => {
  const input = { appId: 'app-1', tenantId: 'tenant-1', repo: 'github.com/agentmark-ai/app' };

  it('selects branch + pr-link number pairs scoped to tenant/app/repo, never ActorId', () => {
    const { query } = buildAgentPrAttributionQuery(input);
    expect(query).toContain('FROM agent_session_summary FINAL');
    expect(query).toContain('GitBranch AS branch');
    expect(query).toContain('pn AS prNumber');
    // Steering signal for the clean-job composite: the group's max user-turn count.
    expect(query).toContain('max(UserTurnCount) AS maxUserTurns');
    expect(query).toContain('TenantId = {tenantId:String}');
    expect(query).toContain('AppId = {appId:String}');
    expect(query).toContain('GitRepo = {repo:String}');
    // Sessions with neither a branch nor any pr-link contribute nothing.
    expect(query).toContain("(GitBranch != '' OR PrNumber > 0 OR notEmpty(PrNumbers))");
    // Repo rides every row so org-scope consumers can match within a repo.
    expect(query).toContain('GitRepo AS repo');
    expect(query).toContain('GROUP BY GitRepo, GitBranch, pn');
    expect(query).not.toContain('ActorId');
  });

  it('expands a session to ONE ROW PER LINKED PR, keeping link-less sessions via LEFT join and legacy scalar rows via the union', () => {
    const { query } = buildAgentPrAttributionQuery(input);
    // union of array + scalar: rows written before PrNumbers existed still attribute
    expect(query).toContain(
      'WITH arrayDistinct(arrayConcat(if(PrNumber > 0, [PrNumber], emptyArrayUInt32()), PrNumbers)) AS sessionPrs',
    );
    // LEFT keeps branch-only sessions as a prNumber=0 row
    expect(query).toContain('LEFT ARRAY JOIN sessionPrs AS pn');
  });

  it('is deliberately NOT date-filtered — the session that produced a PR can predate the window', () => {
    const { query } = buildAgentPrAttributionQuery(input);
    expect(query).not.toContain('StartedAt');
    expect(query).not.toContain('Date');
  });

  it('binds every param the query references, with no extras', () => {
    const { params } = buildAgentPrAttributionQuery(input);
    expect(params).toEqual({
      tenantId: 'tenant-1',
      appId: 'app-1',
      repo: 'github.com/agentmark-ai/app',
    });
  });
});

describe('buildAgentPrCostAttributionQuery', () => {
  const input = { appId: 'app-1', tenantId: 'tenant-1', repo: 'github.com/agentmark-ai/app' };

  it('sums cost per (branch, pr-link) group, scoped to tenant/app/repo, never ActorId', () => {
    const { query } = buildAgentPrCostAttributionQuery(input);
    expect(query).toContain('FROM agent_session_summary FINAL');
    expect(query).toContain('GitBranch AS branch');
    expect(query).toContain('pn AS prNumber');
    expect(query).toContain('GitRepo = {repo:String}');
    expect(query).toContain("(GitBranch != '' OR PrNumber > 0 OR notEmpty(PrNumbers))");
    expect(query).toContain('GitRepo AS repo');
    expect(query).toContain('GROUP BY GitRepo, GitBranch, pn');
    expect(query).not.toContain('ActorId');
  });

  it("splits a multi-PR session's cost evenly across its links so no dollar is counted twice", () => {
    const { query } = buildAgentPrCostAttributionQuery(input);
    expect(query).toContain(
      'WITH arrayDistinct(arrayConcat(if(PrNumber > 0, [PrNumber], emptyArrayUInt32()), PrNumbers)) AS sessionPrs',
    );
    expect(query).toContain('LEFT ARRAY JOIN sessionPrs AS pn');
    // divide-before-sum, floored at 1 so link-less (pn=0) rows keep full cost
    expect(query).toContain('sum(CostUsd / greatest(1, length(sessionPrs))) AS costUsd');
  });

  it('is NOT date-filtered — a PR accrues cost from sessions predating its merge window', () => {
    const { query } = buildAgentPrCostAttributionQuery(input);
    expect(query).not.toContain('StartedAt');
    expect(query).not.toContain('Date');
  });

  it('binds exactly the referenced params', () => {
    expect(buildAgentPrCostAttributionQuery(input).params).toEqual({
      tenantId: 'tenant-1',
      appId: 'app-1',
      repo: 'github.com/agentmark-ai/app',
    });
  });
});

describe('buildAutonomyLadderAttributionQuery', () => {
  const input = { appId: 'app-1', tenantId: 'tenant-1', repo: 'github.com/agentmark-ai/app' };

  it('pins the published cut points: agent-origin L4 first, then the unknown guard, 3+/1-2 steering, then machine-run', () => {
    const { query } = buildAutonomyLadderAttributionQuery(input);
    // Agent-origin runs (SDK-spawned / headless) classify L4 BEFORE the
    // steering arms: their extra "user" turns and denials are programmatic,
    // not human steering, so a multi-turn SDK loop must not read as
    // "assisted". The arm ORDER is the contract, so pin the full multiIf.
    expect(query).toContain(
      `multiIf(
      Origin = 'agent', 4,
      Origin != 'worker' AND (WorkerKind = '' OR (WorkerKind NOT IN ('cloud', 'ci') AND UserTurnCount = 0)), 0,
      greatest(UserTurnCount - 1, 0) >= 3 OR RejectedToolCallCount >= 3, 1,
      greatest(UserTurnCount - 1, 0) >= 1 OR RejectedToolCallCount >= 1, 2,
      WorkerKind IN ('cloud', 'ci') OR Origin = 'worker', 4,
      3
    ) AS level`
    );
    // Group verdict: minimum CLASSIFIABLE level; unknowns never win the min.
    expect(query).toContain('minIf(level, level > 0) AS minLevel');
    expect(query).toContain('countIf(level > 0) AS classifiedSessions');
    expect(query).toContain('GROUP BY GitRepo, GitBranch, pn');
    expect(query).not.toContain('ActorId');
  });

  it('confers a multi-PR session level on EVERY linked PR (array∪scalar expansion)', () => {
    const { query } = buildAutonomyLadderAttributionQuery(input);
    expect(query).toContain(
      'LEFT ARRAY JOIN arrayDistinct(arrayConcat(if(PrNumber > 0, [PrNumber], emptyArrayUInt32()), PrNumbers)) AS pn',
    );
    expect(query).toContain("(GitBranch != '' OR PrNumber > 0 OR notEmpty(PrNumbers))");
  });

  it('is deliberately NOT date-filtered and carries repo for org-scope matching', () => {
    const { query } = buildAutonomyLadderAttributionQuery(input);
    expect(query).not.toContain('StartedAt) >=');
    expect(query).toContain('GitRepo AS repo');
  });

  it('org scope drops the app/repo predicates like every other fleet query', () => {
    const { query, params } = buildAutonomyLadderAttributionQuery({ ...input, scope: 'org' });
    expect(query).not.toContain('AppId');
    expect(params).toEqual({ tenantId: 'tenant-1' });
  });
});

describe('AgentFleetService', () => {
  const mockQuery = vi.fn();
  const mockClient = { query: mockQuery } as any;
  const verifiedAppId = 'app-123' as VerifiedAppId;
  const testCtx: TenantContext = {
    userId: 'test-user',
    tenantId: 'tenant-123',
    appId: verifiedAppId,
    dataRetentionDays: -1,
  };
  const dateRange = { start: '2024-01-08', end: '2024-01-14' };

  let service: AgentFleetService;

  beforeEach(() => {
    vi.clearAllMocks();
    service = new AgentFleetService(mockClient);
  });

  // Every query surface floors its start date at the tenant's retention
  // cutoff, so a requested range can never reach past what the plan retains.
  describe('retention floor', () => {
    /** Days before today, as the YYYY-MM-DD ClickHouse date param. */
    const daysAgo = (n: number) =>
      new Date(Date.now() - n * 86_400_000).toISOString().split('T')[0]!;

    async function startDateFor(dataRetentionDays: number, requestedStart: string) {
      mockQuery
        .mockResolvedValueOnce({ json: vi.fn().mockResolvedValue([{ repo: 'r' }]) })
        .mockResolvedValueOnce({ json: vi.fn().mockResolvedValue([]) })
        .mockResolvedValueOnce({ json: vi.fn().mockResolvedValue([]) });
      await service.getAgentFleetOverview(
        { ...testCtx, dataRetentionDays },
        { start: requestedStart, end: '2099-01-01' },
      );
      return mockQuery.mock.calls[1]![0].query_params.startDate as string;
    }

    it('raises a start date older than the retention window up to the cutoff', async () => {
      // 30-day plan asked for two years of history.
      expect(await startDateFor(30, '2023-01-01')).toBe(daysAgo(30));
    });

    it('leaves a start date inside the retention window untouched', async () => {
      const inside = daysAgo(5);
      expect(await startDateFor(30, inside)).toBe(inside);
    });

    it('honors an arbitrarily old start date when retention is unlimited', async () => {
      // -1 is the unlimited sentinel; its cutoff is the epoch, which never wins.
      expect(await startDateFor(-1, '2020-03-04')).toBe('2020-03-04');
    });
  });

  describe('getAgentFleetOverview', () => {
    it('resolves the dominant repo first, then scopes the tiles + model-mix queries to it', async () => {
      mockQuery
        .mockResolvedValueOnce({ json: vi.fn().mockResolvedValue([{ repo: 'github.com/agentmark-ai/app' }]) })
        .mockResolvedValueOnce({ json: vi.fn().mockResolvedValue([]) })
        .mockResolvedValueOnce({ json: vi.fn().mockResolvedValue([]) });

      await service.getAgentFleetOverview(testCtx, dateRange);

      expect(mockQuery).toHaveBeenCalledTimes(3);
      const [repoCall, tilesCall, modelMixCall] = mockQuery.mock.calls.map((c) => c[0]);
      // First call is the dominant-repo resolution query — confirmed by shape.
      expect(repoCall.query).toContain('GROUP BY GitRepo');
      expect(tilesCall.query_params.repo).toBe('github.com/agentmark-ai/app');
      expect(modelMixCall.query_params.repo).toBe('github.com/agentmark-ai/app');
    });

    it('falls back to an empty-string repo when the app has no repo-tagged sessions yet', async () => {
      mockQuery
        .mockResolvedValueOnce({ json: vi.fn().mockResolvedValue([]) }) // no dominant repo found
        .mockResolvedValueOnce({ json: vi.fn().mockResolvedValue([]) })
        .mockResolvedValueOnce({ json: vi.fn().mockResolvedValue([]) });

      await service.getAgentFleetOverview(testCtx, dateRange);

      const [, tilesCall] = mockQuery.mock.calls.map((c) => c[0]);
      expect(tilesCall.query_params.repo).toBe('');
    });

    it('computes quality rates over ALL sessions and behavior rates over interactive sessions only, avoiding div-by-zero', async () => {
      mockQuery
        .mockResolvedValueOnce({ json: vi.fn().mockResolvedValue([{ repo: 'r' }]) })
        .mockResolvedValueOnce({
          json: vi.fn().mockResolvedValue([
            // Interactive counts deliberately differ from the all-inclusive
            // ones (5 of 10 sessions, 8 of 20 tool calls) so a behavior rate
            // computed over the wrong denominator produces a different number.
            { period: 'current', sessions: '10', actors: '3', toolCalls: '20', toolErrors: '4', cleanSessions: '7', costUsd: '15.75', interactiveSessions: '5', interactiveToolCalls: '8', interactiveRejectedToolCalls: '2', interactiveAutoApprovedSessions: '3', interactiveSteeredSessions: '2' },
            // Prior period: agent runs only — real activity and errors, zero
            // interactive sessions.
            { period: 'prior', sessions: '4', actors: '1', toolCalls: '6', toolErrors: '1', cleanSessions: '3', costUsd: '2.5', interactiveSessions: '0', interactiveToolCalls: '0', interactiveRejectedToolCalls: '0', interactiveAutoApprovedSessions: '0', interactiveSteeredSessions: '0' },
          ]),
        })
        .mockResolvedValueOnce({ json: vi.fn().mockResolvedValue([]) });

      const result = await service.getAgentFleetOverview(testCtx, dateRange);

      // Activity/spend tiles are fleet-wide: agent runs count.
      expect(result.sessions).toEqual({ current: 10, prior: 4 });
      expect(result.activeActors).toEqual({ current: 3, prior: 1 });
      expect(result.totalCost).toEqual({ current: 15.75, prior: 2.5 });
      // 4/20 and 1/6 — error rate over ALL tool calls (agent-run failures are real)
      expect(result.toolErrorRate).toEqual({ current: 0.2, prior: 1 / 6 });
      // 7/10 and 3/4 clean sessions — a floor ("didn't obviously fail"), over ALL sessions
      expect(result.cleanSessionRate).toEqual({ current: 0.7, prior: 0.75 });
      // 2/5 interactive sessions needed mid-session steering — NOT 2/10:
      // the denominator is the interactive population.
      expect(result.handsOnRate.current).toBe(0.4);
      // 2/8 interactive tool calls were human-denied (rejected ÷ interactive
      // tool calls — NOT ÷ all 20, and NOT ÷ sessions)
      expect(result.toolDenialRate.current).toBe(0.25);
      // 3/5 interactive sessions ran without a single permission prompt — NOT 3/10
      expect(result.autoApprovedRate.current).toBe(0.6);
      // A period whose sessions are ALL agent runs has no behavior signal:
      // rates are 0, not NaN or Infinity.
      expect(result.handsOnRate.prior).toBe(0);
      expect(result.toolDenialRate.prior).toBe(0);
      expect(result.autoApprovedRate.prior).toBe(0);
    });

    it('org scope skips the dominant-repo round-trip and sweeps the tenant (no app/repo params)', async () => {
      mockQuery
        .mockResolvedValueOnce({ json: vi.fn().mockResolvedValue([]) })
        .mockResolvedValueOnce({ json: vi.fn().mockResolvedValue([]) });

      await service.getAgentFleetOverview(testCtx, dateRange, { scope: 'org' });

      // Exactly two calls: tiles + model mix. No repo-resolution query.
      expect(mockQuery).toHaveBeenCalledTimes(2);
      const [tilesCall, modelMixCall] = mockQuery.mock.calls.map((c) => c[0]);
      expect(tilesCall.query).not.toContain('AppId');
      expect(tilesCall.query_params).not.toHaveProperty('appId');
      expect(tilesCall.query_params).not.toHaveProperty('repo');
      expect(modelMixCall.query_params).toEqual(
        expect.objectContaining({ tenantId: 'tenant-123' })
      );
    });

    it('maps model-mix rows to {model, sessions}, preserving the query\'s DESC order', async () => {
      mockQuery
        .mockResolvedValueOnce({ json: vi.fn().mockResolvedValue([{ repo: 'r' }]) })
        .mockResolvedValueOnce({ json: vi.fn().mockResolvedValue([]) })
        .mockResolvedValueOnce({
          json: vi.fn().mockResolvedValue([
            { model: 'anthropic/claude-opus-4-8', sessions: '12' },
            { model: 'anthropic/claude-sonnet-5', sessions: '4' },
          ]),
        });

      const result = await service.getAgentFleetOverview(testCtx, dateRange);

      expect(result.modelMix).toEqual([
        { model: 'anthropic/claude-opus-4-8', sessions: 12 },
        { model: 'anthropic/claude-sonnet-5', sessions: 4 },
      ]);
    });
  });

  describe('getAgentFleetDimensionBreakdown', () => {
    it('resolves the repo, then returns {dimensionValue, sessions, costUsd, toolErrorRate} rows', async () => {
      mockQuery
        .mockResolvedValueOnce({ json: vi.fn().mockResolvedValue([{ repo: 'r' }]) })
        .mockResolvedValueOnce({
          json: vi.fn().mockResolvedValue([
            { dimensionValue: 'main', sessions: '8', costUsd: '12.5', toolErrorRate: '0.125' },
            { dimensionValue: 'feature/x', sessions: '3', costUsd: '4.25', toolErrorRate: '0' },
          ]),
        });

      const result = await service.getAgentFleetDimensionBreakdown(testCtx, dateRange, 'branch');

      expect(result.items).toEqual([
        { dimensionValue: 'main', sessions: 8, costUsd: 12.5, toolErrorRate: 0.125 },
        { dimensionValue: 'feature/x', sessions: 3, costUsd: 4.25, toolErrorRate: 0 },
      ]);
      const [, dimCall] = mockQuery.mock.calls.map((c) => c[0]);
      expect(dimCall.query).toContain('GitBranch AS dimensionValue');
    });

    it('passes the "agent_type" dimension through to the AgentType column', async () => {
      mockQuery
        .mockResolvedValueOnce({ json: vi.fn().mockResolvedValue([{ repo: 'r' }]) })
        .mockResolvedValueOnce({ json: vi.fn().mockResolvedValue([]) });

      await service.getAgentFleetDimensionBreakdown(testCtx, dateRange, 'agent_type');

      const [, dimCall] = mockQuery.mock.calls.map((c) => c[0]);
      expect(dimCall.query).toContain('AgentType AS dimensionValue');
    });
  });

  describe('getAgentFleetMetricsBreakdown', () => {
    it('resolves the repo and maps agent_session_summary dimensions to {key, sessions, costUsd, toolErrorRate}', async () => {
      mockQuery
        .mockResolvedValueOnce({ json: vi.fn().mockResolvedValue([{ repo: 'r' }]) })
        .mockResolvedValueOnce({
          json: vi.fn().mockResolvedValue([
            { dimensionValue: 'main', sessions: '8', costUsd: '12.5', toolErrorRate: '0.125' },
          ]),
        });

      const result = await service.getAgentFleetMetricsBreakdown(testCtx, dateRange, 'branch', 10);

      expect(result).toEqual({
        dimension: 'branch',
        items: [{ key: 'main', sessions: 8, costUsd: 12.5, toolErrorRate: 0.125 }],
      });
      const [, dimCall] = mockQuery.mock.calls.map((c) => c[0]);
      expect(dimCall.query).toContain('GitBranch AS dimensionValue');
    });

    it('routes the "model" dimension through buildAgentFleetModelBreakdownQuery (ARRAY JOIN Models)', async () => {
      mockQuery
        .mockResolvedValueOnce({ json: vi.fn().mockResolvedValue([{ repo: 'r' }]) })
        .mockResolvedValueOnce({
          json: vi.fn().mockResolvedValue([
            { dimensionValue: 'claude-opus-5', sessions: '4', costUsd: '9', toolErrorRate: '0' },
          ]),
        });

      const result = await service.getAgentFleetMetricsBreakdown(testCtx, dateRange, 'model', 10);

      expect(result).toEqual({
        dimension: 'model',
        items: [{ key: 'claude-opus-5', sessions: 4, costUsd: 9, toolErrorRate: 0 }],
      });
      const [, dimCall] = mockQuery.mock.calls.map((c) => c[0]);
      expect(dimCall.query).toContain('ARRAY JOIN Models AS model');
    });

    // proves AC-052-15
    it('routes the "tool" dimension through buildAgentFleetToolBreakdownQuery, skips repo resolution, and maps {key, requests, toolErrorRate}', async () => {
      mockQuery.mockResolvedValueOnce({
        json: vi.fn().mockResolvedValue([
          { dimensionValue: 'bash', requests: '20', errors: '5' },
          { dimensionValue: 'edit', requests: '10', errors: '0' },
        ]),
      });

      const result = await service.getAgentFleetMetricsBreakdown(testCtx, dateRange, 'tool', 10);

      // Exactly one query — no dominant-repo round-trip for the tool dimension.
      expect(mockQuery).toHaveBeenCalledTimes(1);
      expect(result).toEqual({
        dimension: 'tool',
        items: [
          { key: 'bash', requests: 20, toolErrorRate: 0.25 },
          { key: 'edit', requests: 10, toolErrorRate: 0 },
        ],
      });
      const [toolCall] = mockQuery.mock.calls.map((c) => c[0]);
      expect(toolCall.query).toContain('FROM otel_traces FINAL');
      expect(toolCall.query_params).not.toHaveProperty('repo');
    });
  });

  describe('getAgentFleetDailyTrend', () => {
    it('resolves the repo and maps each daily row into a trend point, preserving order', async () => {
      mockQuery
        .mockResolvedValueOnce({ json: vi.fn().mockResolvedValue([{ repo: 'r' }]) })
        .mockResolvedValueOnce({
          json: vi.fn().mockResolvedValue([
            { date: '2024-01-08', sessions: '5', costUsd: '10.5', toolErrorRate: '0.1', cleanSessionRate: '0.8' },
            { date: '2024-01-09', sessions: '3', costUsd: '4.25', toolErrorRate: '0', cleanSessionRate: '1' },
          ]),
        });

      const result = await service.getAgentFleetDailyTrend(testCtx, dateRange);

      expect(result.points).toEqual([
        { date: '2024-01-08', sessions: 5, costUsd: 10.5, toolErrorRate: 0.1, cleanSessionRate: 0.8 },
        { date: '2024-01-09', sessions: 3, costUsd: 4.25, toolErrorRate: 0, cleanSessionRate: 1 },
      ]);
      const [, trendCall] = mockQuery.mock.calls.map((c) => c[0]);
      expect(trendCall.query).toContain('FROM agent_session_summary FINAL');
      expect(trendCall.query_params.repo).toBe('r');
    });
  });

  describe('getAgentFleetPercentileTrend', () => {
    it('maps each daily row into a trend point, preserving order', async () => {
      mockQuery
        .mockResolvedValueOnce({ json: vi.fn().mockResolvedValue([{ repo: 'r' }]) })
        .mockResolvedValueOnce({
          json: vi.fn().mockResolvedValue([
            { date: '2024-01-08', costP50: '0.5', costP95: '3.2', durationP50: '45000', durationP95: '180000', durationP99: '400000', turnCountP95: '22', interventionsMean: '1.4' },
            { date: '2024-01-09', costP50: '0.6', costP95: '2.9', durationP50: '40000', durationP95: '170000', durationP99: '390000', turnCountP95: '20', interventionsMean: 0 },
          ]),
        });

      const result = await service.getAgentFleetPercentileTrend(testCtx, dateRange);

      expect(result.points).toEqual([
        { date: '2024-01-08', costP50: 0.5, costP95: 3.2, durationP50Ms: 45000, durationP95Ms: 180000, durationP99Ms: 400000, turnCountP95: 22, interventionsMean: 1.4 },
        { date: '2024-01-09', costP50: 0.6, costP95: 2.9, durationP50Ms: 40000, durationP95Ms: 170000, durationP99Ms: 390000, turnCountP95: 20, interventionsMean: 0 },
      ]);
    });

    it('returns an empty points array when the app has no sessions in range (never a fabricated snapshot)', async () => {
      mockQuery
        .mockResolvedValueOnce({ json: vi.fn().mockResolvedValue([{ repo: 'r' }]) })
        .mockResolvedValueOnce({ json: vi.fn().mockResolvedValue([]) });

      const result = await service.getAgentFleetPercentileTrend(testCtx, dateRange);
      expect(result.points).toEqual([]);
    });
  });

  describe('getAgentFleetActiveActorTrend', () => {
    it('maps each daily row to {date, activeActors}', async () => {
      mockQuery
        .mockResolvedValueOnce({ json: vi.fn().mockResolvedValue([{ repo: 'r' }]) })
        .mockResolvedValueOnce({
          json: vi.fn().mockResolvedValue([
            { date: '2024-01-08', activeActors: '3' },
            { date: '2024-01-09', activeActors: '5' },
          ]),
        });

      const result = await service.getAgentFleetActiveActorTrend(testCtx, dateRange);

      expect(result.points).toEqual([
        { date: '2024-01-08', activeActors: 3 },
        { date: '2024-01-09', activeActors: 5 },
      ]);
    });
  });

  describe('getAgentFleetTrajectorySignalTrend', () => {
    it('resolves the repo, then maps each daily row to numeric rates, preserving order', async () => {
      mockQuery
        .mockResolvedValueOnce({ json: vi.fn().mockResolvedValue([{ repo: 'r' }]) })
        .mockResolvedValueOnce({
          json: vi.fn().mockResolvedValue([
            { date: '2024-01-08', toolErrorRate: '0.12', denialRate: '0.03', handsOnShare: '0.4' },
            { date: '2024-01-09', toolErrorRate: 0, denialRate: 0, handsOnShare: 0 },
          ]),
        });

      const result = await service.getAgentFleetTrajectorySignalTrend(testCtx, dateRange);

      expect(result.points).toEqual([
        { date: '2024-01-08', toolErrorRate: 0.12, denialRate: 0.03, handsOnShare: 0.4 },
        { date: '2024-01-09', toolErrorRate: 0, denialRate: 0, handsOnShare: 0 },
      ]);
      const [, trendCall] = mockQuery.mock.calls.map((c) => c[0]);
      expect(trendCall.query_params.repo).toBe('r');
    });

    it('returns an empty points array when nothing ran in range (a missing day is absent, never zero-filled)', async () => {
      mockQuery
        .mockResolvedValueOnce({ json: vi.fn().mockResolvedValue([{ repo: 'r' }]) })
        .mockResolvedValueOnce({ json: vi.fn().mockResolvedValue([]) });

      const result = await service.getAgentFleetTrajectorySignalTrend(testCtx, dateRange);
      expect(result.points).toEqual([]);
    });
  });

  describe('getAgentFleetCostAnomalies', () => {
    it('resolves the repo, passes a $1 minimum delta floor, and maps rows to the anomaly item shape', async () => {
      mockQuery
        .mockResolvedValueOnce({ json: vi.fn().mockResolvedValue([{ repo: 'r' }]) })
        .mockResolvedValueOnce({
          json: vi.fn().mockResolvedValue([
            { dimensionValue: 'feat/expensive-thing', recentCostUsd: '42.5', baselineMeanUsd: '3.1', deltaUsd: '39.4' },
          ]),
        });

      const result = await service.getAgentFleetCostAnomalies(testCtx, dateRange);

      expect(result.items).toEqual([
        { dimensionValue: 'feat/expensive-thing', recentCostUsd: 42.5, baselineMeanUsd: 3.1, deltaUsd: 39.4 },
      ]);
      const [, anomalyCall] = mockQuery.mock.calls.map((c) => c[0]);
      expect(anomalyCall.query_params.minDeltaUsd).toBe(1);
    });

    it('returns no items when nothing crosses the anomaly threshold', async () => {
      mockQuery
        .mockResolvedValueOnce({ json: vi.fn().mockResolvedValue([{ repo: 'r' }]) })
        .mockResolvedValueOnce({ json: vi.fn().mockResolvedValue([]) });

      const result = await service.getAgentFleetCostAnomalies(testCtx, dateRange);
      expect(result.items).toEqual([]);
    });
  });

  describe('getAgentPrAttribution', () => {
    it('resolves the dominant repo first, then dedupes branches and pr-link numbers from the pairs', async () => {
      mockQuery
        .mockResolvedValueOnce({ json: vi.fn().mockResolvedValue([{ repo: 'github.com/agentmark-ai/app' }]) })
        .mockResolvedValueOnce({
          json: vi.fn().mockResolvedValue([
            // Same branch across a pr-linked and an unlinked session; string
            // PrNumber (ClickHouse JSON numerics can arrive as strings).
            // maxUserTurns 3 → this PR needed steering (UserTurnCount > 1).
            { repo: 'github.com/agentmark-ai/app', branch: 'agent/feat-x', prNumber: '512', maxUserTurns: '3' },
            { repo: 'github.com/agentmark-ai/app', branch: 'agent/feat-x', prNumber: 0, maxUserTurns: 1 },
            { repo: 'github.com/agentmark-ai/app', branch: 'agent/feat-y', prNumber: 0, maxUserTurns: 1 },
            // pr-link with no branch (metrics-tier session): number still
            // counts; maxUserTurns 1 → NOT steered (only the initial ask).
            { repo: 'github.com/agentmark-ai/app', branch: '', prNumber: 513, maxUserTurns: 1 },
          ]),
        });

      const result = await service.getAgentPrAttribution(testCtx);

      expect(result).toEqual({
        branches: ['agent/feat-x', 'agent/feat-y'],
        prNumbers: [512, 513],
        // Only PR 512 had a session with > 1 user turn.
        steeredPrNumbers: [512],
        // Repo-qualified rows pass through verbatim (numerics coerced).
        items: [
          { repo: 'github.com/agentmark-ai/app', branch: 'agent/feat-x', prNumber: 512, steered: true },
          { repo: 'github.com/agentmark-ai/app', branch: 'agent/feat-x', prNumber: 0, steered: false },
          { repo: 'github.com/agentmark-ai/app', branch: 'agent/feat-y', prNumber: 0, steered: false },
          { repo: 'github.com/agentmark-ai/app', branch: '', prNumber: 513, steered: false },
        ],
      });
      const [repoCall, attrCall] = mockQuery.mock.calls.map((c) => c[0]);
      expect(repoCall.query).toContain('GROUP BY GitRepo');
      expect(attrCall.query_params.repo).toBe('github.com/agentmark-ai/app');
    });

    it('returns empty sets when the app has no attributable sessions', async () => {
      mockQuery
        .mockResolvedValueOnce({ json: vi.fn().mockResolvedValue([]) }) // no dominant repo
        .mockResolvedValueOnce({ json: vi.fn().mockResolvedValue([]) });

      const result = await service.getAgentPrAttribution(testCtx);
      expect(result).toEqual({ branches: [], prNumbers: [], steeredPrNumbers: [], items: [] });
    });
  });

  describe('getAutonomyLadderAttribution', () => {
    it('resolves the repo, then returns per-(repo,branch,PR) min levels with numerics coerced', async () => {
      mockQuery
        .mockResolvedValueOnce({ json: vi.fn().mockResolvedValue([{ repo: 'github.com/agentmark-ai/app' }]) })
        .mockResolvedValueOnce({
          json: vi.fn().mockResolvedValue([
            { repo: 'github.com/agentmark-ai/app', branch: 'agent/x', prNumber: '512', minLevel: '3', classifiedSessions: '2' },
            // A group with only legacy sessions: minIf yields 0.
            { repo: 'github.com/agentmark-ai/app', branch: 'old/y', prNumber: 0, minLevel: 0, classifiedSessions: 0 },
          ]),
        });

      const result = await service.getAutonomyLadderAttribution(testCtx);

      expect(result).toEqual({
        items: [
          { repo: 'github.com/agentmark-ai/app', branch: 'agent/x', prNumber: 512, minLevel: 3, classifiedSessions: 2 },
          { repo: 'github.com/agentmark-ai/app', branch: 'old/y', prNumber: 0, minLevel: 0, classifiedSessions: 0 },
        ],
      });
    });
  });

  describe('getAgentPrCostAttribution', () => {
    it('resolves the dominant repo first, then returns per-(branch,PR) cost with numerics coerced', async () => {
      mockQuery
        .mockResolvedValueOnce({ json: vi.fn().mockResolvedValue([{ repo: 'github.com/agentmark-ai/app' }]) })
        .mockResolvedValueOnce({
          json: vi.fn().mockResolvedValue([
            // ClickHouse JSON numerics can arrive as strings — must coerce.
            { branch: 'agent/feat-x', prNumber: '512', costUsd: '12.5' },
            { branch: 'agent/feat-y', prNumber: 0, costUsd: 3 },
          ]),
        });

      const result = await service.getAgentPrCostAttribution(testCtx);

      expect(result).toEqual({
        items: [
          { branch: 'agent/feat-x', prNumber: 512, costUsd: 12.5 },
          { branch: 'agent/feat-y', prNumber: 0, costUsd: 3 },
        ],
      });
      const [, costCall] = mockQuery.mock.calls.map((c) => c[0]);
      expect(costCall.query).toContain('sum(CostUsd / greatest(1, length(sessionPrs))) AS costUsd');
      expect(costCall.query_params.repo).toBe('github.com/agentmark-ai/app');
    });

    it('returns an empty item set when the app has no attributable sessions', async () => {
      mockQuery
        .mockResolvedValueOnce({ json: vi.fn().mockResolvedValue([]) })
        .mockResolvedValueOnce({ json: vi.fn().mockResolvedValue([]) });

      expect(await service.getAgentPrCostAttribution(testCtx)).toEqual({ items: [] });
    });
  });
});

describe('buildAgentFleetDimensionQuery — worker_kind dimension', () => {
  it('maps worker_kind to the WorkerKind column (run-origin, never an identity column)', () => {
    const { query } = buildAgentFleetDimensionQuery({
      ...repoScope,
      dimension: 'worker_kind',
      startDate: '2024-01-08',
      endDate: '2024-01-14',
      limit: 10,
    });
    expect(query).toContain('WorkerKind AS dimensionValue');
    expect(query).toContain("WorkerKind != ''");
    expect(query).toContain('GROUP BY dimensionValue');
    // The dimension column comes from the fixed map, never ActorId.
    expect(query).not.toContain('ActorId');
  });
});

describe('buildAgentFleetPercentileTrendQuery — interventions column', () => {
  it('projects the daily mean of max(UserTurnCount − 1, 0) over interactive sessions, alongside the percentiles', () => {
    const { query } = buildAgentFleetPercentileTrendQuery({
      ...repoScope,
      startDate: '2024-01-08',
      endDate: '2024-01-14',
    });
    // Exact aggregate pinned: the initial prompt is not an intervention
    // (hence − 1), a zero-user-turn session must not go negative, and only
    // interactive-origin sessions count — an SDK loop's programmatic turns
    // are not human steering, and a flood of single-prompt agent runs would
    // crush the mean toward zero. `ifNotFinite(…, 0)` keeps a day with only
    // agent runs on the chart as zero steering load instead of NaN.
    // Both the turn count and the origin come from the session's ROOT row, so
    // delegated runs neither add phantom steering nor dilute the mean.
    expect(query).toContain(
      "ifNotFinite(avgIf(greatest(rootUserTurnCount - 1, 0), rootOrigin IN ('', 'interactive')), 0) AS interventionsMean"
    );
    // The percentile columns stay all-inclusive — cost/duration/turn-shape
    // are fleet truth; only the steering signal is population-scoped.
    expect(query).toContain('quantile(0.5)(sessionCostUsd) AS costP50');
    expect(query).not.toMatch(/WHERE[\s\S]*Origin/);
  });
});

describe('buildAgentFleetAutonomyMixTrendQuery', () => {
  const input = { ...repoScope, startDate: '2024-01-08', endDate: '2024-01-14' };

  it('groups daily session counts by WorkerKind, excluding unlabeled legacy rows', () => {
    const { query, params } = buildAgentFleetAutonomyMixTrendQuery(input);
    expect(query).toContain('FROM agent_session_summary FINAL');
    expect(query).toContain('WorkerKind AS workerKind');
    expect(query).toContain("WorkerKind != ''");
    expect(query).toContain('GROUP BY date, workerKind');
    expect(query).toContain('ORDER BY date, workerKind');
    expect(params).toEqual({
      tenantId: 'tenant-1',
      appId: 'app-1',
      repo: 'github.com/agentmark-ai/app',
      startDate: '2024-01-08',
      endDate: '2024-01-14',
    });
  });

  it('scopes to tenant + app + repo and never touches ActorId', () => {
    const { query } = buildAgentFleetAutonomyMixTrendQuery(input);
    expect(query).toContain('TenantId = {tenantId:String}');
    expect(query).toContain('AppId = {appId:String}');
    expect(query).toContain('GitRepo = {repo:String}');
    expect(query).not.toContain('ActorId');
  });
});

describe('AgentFleetService.getAgentFleetAutonomyMixTrend', () => {
  it('resolves the dominant repo, then returns per-day per-kind session counts coerced to numbers', async () => {
    const mockQuery = vi.fn();
    const service = new AgentFleetService({ query: mockQuery } as any);
    const ctx: TenantContext = {
      userId: 'test-user',
      tenantId: 'tenant-123',
      appId: 'app-123' as VerifiedAppId,
      dataRetentionDays: -1,
    };
    mockQuery
      .mockResolvedValueOnce({ json: vi.fn().mockResolvedValue([{ repo: 'github.com/agentmark-ai/app' }]) })
      .mockResolvedValueOnce({
        json: vi.fn().mockResolvedValue([
          { date: '2024-01-08', workerKind: 'seat', sessions: '12' },
          { date: '2024-01-08', workerKind: 'cloud', sessions: 3 },
          { date: '2024-01-09', workerKind: 'ci', sessions: '1' },
        ]),
      });

    const result = await service.getAgentFleetAutonomyMixTrend(ctx, { start: '2024-01-08', end: '2024-01-14' });

    expect(result).toEqual({
      points: [
        { date: '2024-01-08', workerKind: 'seat', sessions: 12 },
        { date: '2024-01-08', workerKind: 'cloud', sessions: 3 },
        { date: '2024-01-09', workerKind: 'ci', sessions: 1 },
      ],
    });
    const mixCall = mockQuery.mock.calls[1]![0];
    expect(mixCall.query_params.repo).toBe('github.com/agentmark-ai/app');
  });
});

describe('AnalyticsService facade — getAgentFleetAutonomyMixTrend', () => {
  it('routes through the agent-fleet sub-service and returns the mapped trend', async () => {
    const mockQuery = vi.fn();
    const facade = new AnalyticsService({ query: mockQuery } as any);
    const ctx: TenantContext = {
      userId: 'test-user',
      tenantId: 'tenant-123',
      appId: 'app-123' as VerifiedAppId,
      dataRetentionDays: -1,
    };
    mockQuery
      .mockResolvedValueOnce({ json: vi.fn().mockResolvedValue([{ repo: 'r' }]) })
      .mockResolvedValueOnce({
        json: vi.fn().mockResolvedValue([{ date: '2024-01-08', workerKind: 'cloud', sessions: '5' }]),
      });

    const result = await facade.getAgentFleetAutonomyMixTrend(ctx, { start: '2024-01-08', end: '2024-01-14' });

    expect(result).toEqual({ points: [{ date: '2024-01-08', workerKind: 'cloud', sessions: 5 }] });
    // The second call is the autonomy-mix query — pinned by its GROUP BY shape.
    expect(mockQuery.mock.calls[1]![0].query).toContain('GROUP BY date, workerKind');
  });

  it('routes the autonomy-ladder attribution through the sub-service and returns the mapped items', async () => {
    const mockQuery = vi.fn();
    const facade = new AnalyticsService({ query: mockQuery } as any);
    const ctx: TenantContext = {
      userId: 'test-user',
      tenantId: 'tenant-123',
      appId: 'app-123' as VerifiedAppId,
      dataRetentionDays: -1,
    };
    mockQuery
      .mockResolvedValueOnce({ json: vi.fn().mockResolvedValue([{ repo: 'r' }]) })
      .mockResolvedValueOnce({
        json: vi.fn().mockResolvedValue([
          { repo: 'r', branch: 'agent/x', prNumber: '7', minLevel: '3', classifiedSessions: '2' },
        ]),
      });

    const result = await facade.getAutonomyLadderAttribution(ctx);

    expect(result).toEqual({
      items: [{ repo: 'r', branch: 'agent/x', prNumber: 7, minLevel: 3, classifiedSessions: 2 }],
    });
    // The second call is the ladder query — pinned by its group-verdict shape.
    expect(mockQuery.mock.calls[1]![0].query).toContain('minIf(level, level > 0) AS minLevel');
  });
});

describe('AnalyticsService facade — getAgentFleetMetricsBreakdown / getAgentFleetDailyTrend', () => {
  const ctx: TenantContext = {
    userId: 'test-user',
    tenantId: 'tenant-123',
    appId: 'app-123' as VerifiedAppId,
    dataRetentionDays: -1,
  };

  it('routes getAgentFleetMetricsBreakdown through the agent-fleet sub-service', async () => {
    const mockQuery = vi.fn();
    const facade = new AnalyticsService({ query: mockQuery } as any);
    mockQuery.mockResolvedValueOnce({
      json: vi.fn().mockResolvedValue([{ dimensionValue: 'bash', requests: '3', errors: '0' }]),
    });

    const result = await facade.getAgentFleetMetricsBreakdown(ctx, { start: '2024-01-08', end: '2024-01-14' }, 'tool', 10);

    expect(result).toEqual({ dimension: 'tool', items: [{ key: 'bash', requests: 3, toolErrorRate: 0 }] });
  });

  it('routes getAgentFleetDailyTrend through the agent-fleet sub-service', async () => {
    const mockQuery = vi.fn();
    const facade = new AnalyticsService({ query: mockQuery } as any);
    mockQuery
      .mockResolvedValueOnce({ json: vi.fn().mockResolvedValue([{ repo: 'r' }]) })
      .mockResolvedValueOnce({
        json: vi.fn().mockResolvedValue([
          { date: '2024-01-08', sessions: '1', costUsd: '2', toolErrorRate: '0', cleanSessionRate: '1' },
        ]),
      });

    const result = await facade.getAgentFleetDailyTrend(ctx, { start: '2024-01-08', end: '2024-01-14' });

    expect(result).toEqual({
      points: [{ date: '2024-01-08', sessions: 1, costUsd: 2, toolErrorRate: 0, cleanSessionRate: 1 }],
    });
  });
});
