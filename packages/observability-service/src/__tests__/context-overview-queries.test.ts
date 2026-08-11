import { describe, expect, it } from 'vitest';
import {
  buildMcpOverviewQuery,
  buildSessionCoverageQuery,
  buildSkillOverviewQuery,
  buildSkillTrendByDayQuery,
  buildTopicRollupQuery,
} from '../queries-context-overview';

const input = { tenantId: 't1', appId: 'a1', rangeDays: 30, recentDays: 14, lookbackDays: 90 };

/** Every windowed query binds the same param set, derived — never hardcoded. */
const WINDOW_PARAMS = {
  tenantId: 't1',
  appId: 'a1',
  rangeDays: 30,
  priorDays: 60,
  recentDays: 14,
  lookbackDays: 90,
  scanDays: 90,
};

describe('buildSkillOverviewQuery', () => {
  it('reads the rollup with range, prior, recent and lookback windows', () => {
    const { query, params } = buildSkillOverviewQuery(input);
    expect(params).toEqual(WINDOW_PARAMS);
    expect(query).toContain('FROM skill_activation_by_day');
    expect(query).toContain(
      'uniqExactMergeIf(Activations, Day >= today() - {rangeDays:UInt32}) AS rangeActivations',
    );
    expect(query).toContain(
      'uniqExactMergeIf(Activations, Day >= today() - {priorDays:UInt32} AND Day < today() - {rangeDays:UInt32}) AS priorActivations',
    );
    expect(query).toContain(
      'uniqExactMergeIf(Activations, Day >= today() - {recentDays:UInt32}) AS recentActivations',
    );
    expect(query).toContain(
      'uniqExactMergeIf(Activations, Day >= today() - {lookbackDays:UInt32}) AS lookbackActivations',
    );
    expect(query).toContain('Day >= today() - {scanDays:UInt32}');
    expect(query).toContain('GROUP BY Skill');
    // Bound params only — raw values never reach the SQL string.
    expect(query).not.toContain('t1');
    expect(query).not.toContain('a1');
  });

  it('widens the scan window to cover the prior period past the lookback', () => {
    // AC-058-02: deltas compare against the equal-length prior period — for
    // a 90d range the prior window is 90–180 days ago, outside the lookback.
    const { params } = buildSkillOverviewQuery({ ...input, rangeDays: 90 });
    expect(params).toEqual({ ...WINDOW_PARAMS, rangeDays: 90, priorDays: 180, scanDays: 180 });
  });

  it('caps lastActivatedAt at the lookback horizon — prior-only usage must not read as recent', () => {
    const { query } = buildSkillOverviewQuery(input);
    expect(query).toContain('maxIf(LastActivatedAt, Day >= today() - {lookbackDays:UInt32})');
  });

  it('never touches the raw span table and carries no actor identity', () => {
    const { query } = buildSkillOverviewQuery(input);
    expect(query).not.toContain('otel_traces');
    expect(query).not.toContain('ActorId');
  });
});

describe('buildMcpOverviewQuery', () => {
  it('mirrors the skill windows over mcp_tool_use and counts tools USED, not defined', () => {
    const { query, params } = buildMcpOverviewQuery(input);
    expect(params).toEqual(WINDOW_PARAMS);
    expect(query).toContain('FROM mcp_tool_use');
    expect(query).toContain(
      'uniqExactMergeIf(Calls, Day >= today() - {priorDays:UInt32} AND Day < today() - {rangeDays:UInt32}) AS priorCalls',
    );
    expect(query).toContain(
      'uniqExactIf(Tool, Day >= today() - {lookbackDays:UInt32}) AS lookbackTools',
    );
    expect(query).toContain('GROUP BY Server');
    expect(query).not.toContain('otel_traces');
    expect(query).not.toContain('ActorId');
  });
});

describe('buildSessionCoverageQuery', () => {
  it('counts sessions per window and their skill-activating subset via the session-grain rollup', () => {
    const { query, params } = buildSessionCoverageQuery(input);
    expect(params).toEqual(WINDOW_PARAMS);
    expect(query).toContain('FROM agent_session_summary AS s FINAL');
    expect(query).toContain('FROM skill_activation_sessions');
    expect(query).toContain(
      "uniqExactIf(s.TraceId, toDate(s.StartedAt) >= today() - {rangeDays:UInt32} AND w.TraceId != '') AS rangeSessionsWithSkill",
    );
    // The prior window is bounded on BOTH sides — a wide scan window must not
    // leak 60-to-90-day-old sessions into a 30d range's prior period.
    expect(query).toContain(
      'toDate(s.StartedAt) >= today() - {priorDays:UInt32} AND toDate(s.StartedAt) < today() - {rangeDays:UInt32}',
    );
    expect(query).toContain(
      'uniqExactIf(s.TraceId, toDate(s.StartedAt) >= today() - {lookbackDays:UInt32}) AS lookbackSessions',
    );
    expect(query).not.toContain('otel_traces');
    expect(query).not.toContain('ActorId');
  });
});

describe('buildTopicRollupQuery', () => {
  it('groups the drill-down topic join once over all skills in the range', () => {
    const { query, params } = buildTopicRollupQuery(input);
    expect(params).toEqual({ tenantId: 't1', appId: 'a1', rangeDays: 30 });
    expect(query).toContain('FROM trace_facets AS f FINAL');
    expect(query).toContain('FROM skill_activation_sessions');
    // All skills: no per-skill filter anywhere in the rollup.
    expect(query).not.toContain('Skill =');
    expect(query).toContain('LIMIT 8');
  });
});

describe('buildSkillTrendByDayQuery', () => {
  it('reads every skill series in one grouped query over the range window', () => {
    const { query, params } = buildSkillTrendByDayQuery({
      tenantId: 't1',
      appId: 'a1',
      rangeDays: 30,
    });
    expect(params).toEqual({ tenantId: 't1', appId: 'a1', rangeDays: 30 });
    expect(query).toContain('FROM skill_activation_by_day');
    expect(query).toContain('GROUP BY Skill, Day');
    expect(query).toContain('ORDER BY Skill, Day');
    expect(query).not.toContain('otel_traces');
  });
});
