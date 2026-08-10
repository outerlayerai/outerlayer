import { describe, expect, test } from 'vitest';
import { TopicsService, TOPICS_QUERY_SETTINGS, buildTopicsService } from '../services/topics';
import type { IClickHouseQuery } from '../client';

const SCOPE = {
  tenantId: 'tenant-1',
  appId: 'app-1',
  environment: 'production',
  environmentIsDefault: false,
};

/** Records every query's SQL + params so bounds can be asserted; results are
 * consumed positionally in call order. */
function capturingClient(results: unknown[][]) {
  const queue = [...results];
  const calls: { query: string; query_params: Record<string, unknown> | undefined; clickhouse_settings: Record<string, unknown> | undefined }[] = [];
  const client: IClickHouseQuery = {
    query: async (params) => {
      calls.push({
        query: params.query,
        query_params: params.query_params,
        clickhouse_settings: params.clickhouse_settings,
      });
      const rows = queue.shift() ?? [];
      return { json: async <T>() => rows as T[] };
    },
  };
  return { client, calls };
}

describe('TopicsService.listTopics', () => {
  test('defaults the map query to 20 rows and carries the caller\'s limit otherwise', async () => {
    const { client, calls } = capturingClient([[], [{ c: '0' }]]);
    await buildTopicsService(client, { modelEnv: {} }).listTopics(SCOPE, 'task');
    expect(calls[0]!.query).toContain('LIMIT {limit:UInt32}');
    expect(calls[0]!.query_params!['limit']).toBe(20);

    const { client: client2, calls: calls2 } = capturingClient([[], [{ c: '0' }]]);
    await buildTopicsService(client2, { modelEnv: {} }).listTopics(SCOPE, 'task', 5);
    expect(calls2[0]!.query_params!['limit']).toBe(5);
  });

  test('every emitted query carries the ClickHouse resource caps', async () => {
    const { client, calls } = capturingClient([[], [{ c: '0' }]]);
    await buildTopicsService(client, { modelEnv: {} }).listTopics(SCOPE, 'task');
    expect(calls).toHaveLength(2);
    for (const call of calls) {
      expect(call.clickhouse_settings).toMatchObject({
        max_memory_usage: TOPICS_QUERY_SETTINGS.max_memory_usage,
        max_rows_to_read: TOPICS_QUERY_SETTINGS.max_rows_to_read,
      });
    }
  });

  test('errorRate rides the map row through to the response', async () => {
    const { client } = capturingClient([
      [
        {
          TopicId: 'v1-c0',
          Name: 'Refunds',
          Description: '',
          MapVersion: 1,
          GeneratedAt: '2026-07-01 12:00:00.000',
          AvgLatencyMs: 0,
          AvgCostUsd: 0,
          ErrorRate: 0.42,
        },
      ],
      [{ TopicId: 'v1-c0', c: '3' }],
      [{ c: '3' }],
      [],
      [{ c: '0' }],
    ]);
    const list = await new TopicsService(client, { modelEnv: {} }).listTopics(SCOPE, 'task');
    expect(list.topics[0]!.errorRate).toBe(0.42);
  });

  test('an unconfigured model env still resolves a samplable-row dimension via the provider default', async () => {
    const { client, calls } = capturingClient([[], [{ c: '0' }]]);
    await new TopicsService(client, { modelEnv: {} }).listTopics(SCOPE, 'task');
    const countCall = calls[1]!;
    expect(countCall.query_params!['dimension']).toBe(1024);
  });

  test('minSummariesOverride flows into the reported floor', async () => {
    const { client } = capturingClient([[], [{ c: '0' }]]);
    const list = await new TopicsService(client, {
      modelEnv: {},
      minSummariesOverride: 15,
    }).listTopics(SCOPE, 'task');
    expect(list.required).toBe(15);
  });

  test('a multi-week span downsamples the trend to daily buckets and sorts topics by session count', async () => {
    const { client } = capturingClient([
      [
        {
          TopicId: 'v1-c0',
          Name: 'Refunds',
          Description: '',
          MapVersion: 1,
          GeneratedAt: '2026-06-23 12:00:00.000',
          AvgLatencyMs: 800,
          AvgCostUsd: 0.02,
          ErrorRate: 0.1,
        },
        {
          TopicId: 'v1-c1',
          Name: 'Logins',
          Description: '',
          MapVersion: 1,
          GeneratedAt: '2026-06-23 12:00:00.000',
          AvgLatencyMs: 600,
          AvgCostUsd: 0.01,
          ErrorRate: 0.05,
        },
      ],
      [
        { TopicId: 'v1-c0', c: '30' },
        { TopicId: 'v1-c1', c: '60' },
      ],
      [{ c: '90' }],
      [
        // Span Jun 12 09:00 → Jun 14 12:00 (51h > 48h) → daily buckets, two
        // Jun 12 rows fold into one bucket.
        { TopicId: 'v1-c0', bucket: '2026-06-12 09:00:00', c: '3' },
        { TopicId: 'v1-c0', bucket: '2026-06-12 15:00:00', c: '4' },
        { TopicId: 'v1-c0', bucket: '2026-06-14 12:00:00', c: '2' },
      ],
      [{ c: '5' }],
    ]);
    const list = await new TopicsService(client, { modelEnv: {} }).listTopics(SCOPE, 'task');

    expect(list.trendBucket).toBe('day');
    expect(list.trendDays).toEqual([
      '2026-06-12 00:00:00',
      '2026-06-13 00:00:00',
      '2026-06-14 00:00:00',
    ]);
    // Higher session count sorts first, even though it's listed second in mapRows.
    expect(list.topics.map((t) => t.topicId)).toEqual(['v1-c1', 'v1-c0']);
    const refunds = list.topics.find((t) => t.topicId === 'v1-c0')!;
    expect(refunds.trend).toEqual([7, 0, 2]);
    // No no_match rows in this fixture: the fallback trend is all zeros.
    expect(list.noMatchTrend).toEqual([0, 0, 0]);
  });
});
