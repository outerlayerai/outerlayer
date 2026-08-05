import { describe, expect, it } from 'vitest';
import {
  buildSkillAdoptionQuery,
  buildSkillSessionsQuery,
  buildSkillTopicsQuery,
  buildSkillTrendQuery,
} from '../queries-skill-adoption';

describe('buildSkillAdoptionQuery', () => {
  const input = { tenantId: 't1', appId: 'a1', lookbackDays: 90, recentDays: 14 };

  it('reads the skill_activation_by_day rollup, parameterized and day-windowed', () => {
    const { query, params } = buildSkillAdoptionQuery(input);
    expect(params).toEqual({ tenantId: 't1', appId: 'a1', lookbackDays: 90, recentDays: 14 });
    expect(query).toContain('FROM skill_activation_by_day');
    expect(query).toContain('uniqExactMergeIf(Activations, Day >= today() - {recentDays:UInt32})');
    expect(query).toContain('uniqExactMergeIf(Sessions, Day >= today() - {recentDays:UInt32})');
    expect(query).toContain('uniqExactMerge(Activations)');
    expect(query).toContain('uniqExactMerge(Sessions)');
    expect(query).toContain('Day >= today() - {lookbackDays:UInt32}');
    // Bound params only — raw values never reach the SQL string.
    expect(query).not.toContain('t1');
    expect(query).not.toContain('a1');
  });

  it('never touches the raw span table — the rollup IS the perf contract', () => {
    const { query } = buildSkillAdoptionQuery(input);
    // The raw scan reads every span granule in the window (seconds on a busy
    // app) on an interactive path; the rollup read is indexed. Reintroducing
    // otel_traces (or its FINAL / LIMIT-BY dedupe) here is a perf regression.
    expect(query).not.toContain('otel_traces');
    expect(query).not.toContain('FINAL');
    expect(query).not.toContain('LIMIT 1 BY');
  });

  it('aggregates at skill grain only — no actor identity anywhere', () => {
    const { query } = buildSkillAdoptionQuery(input);
    expect(query).not.toContain('ActorId');
    expect(query).toContain('GROUP BY Skill');
  });
});

describe('skill drill-down queries', () => {
  const input = { tenantId: 't1', appId: 'a1', skill: 'my-skill', lookbackDays: 90 };

  describe('buildSkillTrendQuery', () => {
    it('reads a day series from the rollup, parameterized', () => {
      const { query, params } = buildSkillTrendQuery(input);
      expect(params).toEqual({ tenantId: 't1', appId: 'a1', skill: 'my-skill', lookbackDays: 90 });
      expect(query).toContain('FROM skill_activation_by_day');
      expect(query).toContain('Skill = {skill:String}');
      expect(query).toContain('Day >= today() - {lookbackDays:UInt32}');
      expect(query).toContain('GROUP BY Day');
      expect(query).toContain('ORDER BY Day');
      // Bound params only — raw values never reach the SQL string.
      expect(query).not.toContain('my-skill');
      expect(query).not.toContain('t1');
    });
  });

  describe('buildSkillSessionsQuery', () => {
    const sessionsInput = { ...input, limit: 20 };

    it('enumerates from the session-grain table and LEFT-joins titles', () => {
      const { query, params } = buildSkillSessionsQuery(sessionsInput);
      expect(params).toEqual({
        tenantId: 't1',
        appId: 'a1',
        skill: 'my-skill',
        lookbackDays: 90,
        limit: 20,
      });
      expect(query).toContain('FROM skill_activation_sessions');
      expect(query).toContain('GROUP BY TraceId');
      expect(query).toContain('LIMIT {limit:UInt32}');
      // LEFT join: a session with no summary row still activated the skill
      // and must stay in the list.
      expect(query).toContain('LEFT JOIN');
      expect(query).toContain('FROM agent_session_summary');
      expect(query).not.toContain('my-skill');
    });

    it('never reads raw spans and carries no actor identity', () => {
      const { query } = buildSkillSessionsQuery(sessionsInput);
      expect(query).not.toContain('otel_traces');
      expect(query).not.toContain('ActorId');
    });
  });

  describe('buildSkillTopicsQuery', () => {
    it('joins task-facet assignments of the activating sessions to topic names', () => {
      const { query, params } = buildSkillTopicsQuery(input);
      expect(params).toEqual({ tenantId: 't1', appId: 'a1', skill: 'my-skill', lookbackDays: 90 });
      expect(query).toContain('FROM trace_facets');
      expect(query).toContain("Facet = 'task'");
      expect(query).toContain('FROM trace_topic_maps');
      // TopicId is the stable identity across map versions; the name resolves
      // at the highest version carrying it.
      expect(query).toContain('argMax(Name, MapVersion)');
      expect(query).toContain('FROM skill_activation_sessions');
      expect(query).toContain('GROUP BY f.TopicId');
      expect(query).not.toContain('my-skill');
    });

    it('never reads raw spans and carries no actor identity', () => {
      const { query } = buildSkillTopicsQuery(input);
      expect(query).not.toContain('otel_traces');
      expect(query).not.toContain('ActorId');
    });
  });
});
