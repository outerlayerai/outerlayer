import { describe, expect, it } from 'vitest';
import {
  buildSkillSessionsQuery,
  buildSkillTopicsQuery,
  buildSkillTrendQuery,
} from '../queries-skill-adoption';

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
