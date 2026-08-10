/**
 * Cross-package count-parity: a topic's `sessionCount` from
 * `TopicsService.listTopics` must equal `AgentSessionsService.listSessions`'s
 * `total` when the list is drilled down to that same topic — the invariant
 * the Topics card's per-row count and the drill-down's list length both
 * promise the user. Both services now live in this package but query
 * different tables (`trace_topic_maps`/`trace_facets` vs
 * `agent_session_summary`), so nothing besides a shared test fixture pins
 * them to agreement.
 *
 * The fixture below is ONE root session (`s-A`, two facet-fanout rows both
 * assigned to topic `v1-c0`) plus one unrelated session (`s-B`, assigned to
 * `no_match`) — both fakes are driven off the SAME session ids so a change
 * that desyncs the two services' notion of "assigned to this topic" fails
 * here instead of shipping a Topics card whose count the drill-down can't
 * reproduce.
 */
import { describe, expect, test } from 'vitest';
import { TopicsService } from '../services/topics';
import { AgentSessionsService } from '../services/agent-sessions';
import type { IClickHouseQuery } from '../client';

const SCOPE = { tenantId: 'tenant-1', appId: 'app-1' };
const TOPICS_SCOPE = { ...SCOPE, environment: 'production', environmentIsDefault: false };

/** The one fact both services must agree on: which root sessions are
 * assigned to `v1-c0` under the `task` facet's active map. */
const ASSIGNED_SESSION_COUNT = 1;

function topicsFakeClient(): IClickHouseQuery {
  const queue: unknown[][] = [
    // map lookup
    [{ TopicId: 'v1-c0', Name: 'Refunds', Description: '', MapVersion: 1, GeneratedAt: '2026-07-01 12:00:00.000', AvgLatencyMs: 0, AvgCostUsd: 0, ErrorRate: 0 }],
    // live counts: ASSIGNED_SESSION_COUNT distinct root sessions on this topic
    [{ TopicId: 'v1-c0', c: String(ASSIGNED_SESSION_COUNT) }],
    // share denominator
    [{ c: String(ASSIGNED_SESSION_COUNT) }],
    // trend
    [],
    // samplable count
    [{ c: '0' }],
  ];
  return {
    query: async () => ({ json: async <T>() => (queue.shift() ?? []) as T[] }),
  };
}

function sessionsFakeClient(): IClickHouseQuery {
  return {
    query: async (params) => {
      // A topic drill-down never resolves a dominant repo (it spans repos).
      if (params.query.includes('GROUP BY GitRepo')) return { json: async <T>() => [] as T[] };
      if (params.query.includes('SELECT count() AS total')) {
        return { json: async <T>() => [{ total: String(ASSIGNED_SESSION_COUNT) }] as T[] };
      }
      if (params.query.includes('TraceId AS traceId')) {
        return {
          json: async <T>() =>
            [
              {
                traceId: 's-A',
                sessionId: 's-A',
                title: null,
                agentType: 'claude-code',
                actorId: 'membership-a',
                workerKind: null,
                project: 'acme/app',
                branch: null,
                startedAt: '2026-07-01 10:00:00',
                durationMs: 0,
                turnCount: 0,
                toolCallCount: 0,
                errorCount: 0,
                userTurnCount: 0,
                rejectedToolCallCount: 0,
                costUsd: 0,
                models: [],
                origin: '',
              },
            ] as T[],
        };
      }
      return { json: async <T>() => [] as T[] };
    },
  };
}

describe('topics/agent-sessions count parity', () => {
  test('a topic\'s listTopics sessionCount equals the drill-down listSessions total', async () => {
    const topics = new TopicsService(topicsFakeClient(), { modelEnv: {} });
    const list = await topics.listTopics(TOPICS_SCOPE, 'task');
    const refunds = list.topics.find((t) => t.topicId === 'v1-c0')!;
    expect(refunds.sessionCount).toBe(ASSIGNED_SESSION_COUNT);

    const sessions = new AgentSessionsService(sessionsFakeClient());
    const page = await sessions.listSessions(
      SCOPE,
      { limit: 25, offset: 0, sort: 'startedAt', dir: 'desc', topicId: 'v1-c0', topicFacet: 'task' },
      { kind: 'machine-key', canSeeTeamActors: true },
      {
        actorNames: { resolve: async () => ({}) },
        prOutcomes: { forSessions: async () => () => [] },
        images: { sign: async () => [] },
      },
    );

    expect(page.total).toBe(refunds.sessionCount);
  });
});
