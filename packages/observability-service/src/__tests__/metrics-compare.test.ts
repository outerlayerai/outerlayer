import { describe, expect, test } from 'vitest';
import { getTopicMixDeltas, COMPARE_QUERY_SETTINGS } from '../services/metrics-compare';
import type { IClickHouseQuery } from '../client';

const SCOPE = {
  tenantId: 'tenant-1',
  appId: 'app-1',
  environment: 'production',
  environmentIsDefault: false,
};

const WINDOW_A = { from: '2026-07-01', to: '2026-07-07' };
const WINDOW_B = { from: '2026-08-01', to: '2026-08-07' };

/** Records every query's SQL + params + settings; results are consumed
 * positionally in call order (mapRows, countsA, countsB). */
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

describe('getTopicMixDeltas', () => {
  test('returns [] without querying counts when the active map has no topics', async () => {
    const { client, calls } = capturingClient([[]]);
    const result = await getTopicMixDeltas(client, SCOPE, 'issues', WINDOW_A, WINDOW_B, 20);
    expect(result).toEqual([]);
    expect(calls).toHaveLength(1);
  });

  test('merges per-window counts onto the active map and drops all-zero topics', async () => {
    const { client } = capturingClient([
      [
        { TopicId: 'topic-1', Name: 'Auth issues' },
        { TopicId: 'topic-2', Name: 'Rate limits' },
      ],
      [{ TopicId: 'topic-1', c: '12' }],
      [{ TopicId: 'topic-1', c: '3' }],
    ]);

    const result = await getTopicMixDeltas(client, SCOPE, 'issues', WINDOW_A, WINDOW_B, 20);

    expect(result).toEqual([{ topicId: 'topic-1', name: 'Auth issues', countA: 12, countB: 3 }]);
  });

  test('sorts by combined count descending, ties broken by topicId', async () => {
    const { client } = capturingClient([
      [
        { TopicId: 'topic-b', Name: 'B' },
        { TopicId: 'topic-a', Name: 'A' },
      ],
      [
        { TopicId: 'topic-b', c: '5' },
        { TopicId: 'topic-a', c: '5' },
      ],
      [],
    ]);

    const result = await getTopicMixDeltas(client, SCOPE, 'issues', WINDOW_A, WINDOW_B, 20);

    expect(result.map((r) => r.topicId)).toEqual(['topic-a', 'topic-b']);
  });

  test('caps the topic-mix page at the caller limit', async () => {
    const { client } = capturingClient([
      [
        { TopicId: 'topic-1', Name: 'One' },
        { TopicId: 'topic-2', Name: 'Two' },
      ],
      [
        { TopicId: 'topic-1', c: '1' },
        { TopicId: 'topic-2', c: '2' },
      ],
      [],
    ]);

    const result = await getTopicMixDeltas(client, SCOPE, 'issues', WINDOW_A, WINDOW_B, 1);

    expect(result).toHaveLength(1);
  });

  test('the per-window queries filter on the caller-supplied date bounds', async () => {
    const { client, calls } = capturingClient([
      [{ TopicId: 'topic-1', Name: 'One' }],
      [{ TopicId: 'topic-1', c: '1' }],
      [{ TopicId: 'topic-1', c: '2' }],
    ]);

    await getTopicMixDeltas(client, SCOPE, 'issues', WINDOW_A, WINDOW_B, 20);

    expect(calls[1]!.query_params).toMatchObject({ start: WINDOW_A.from, end: WINDOW_A.to });
    expect(calls[2]!.query_params).toMatchObject({ start: WINDOW_B.from, end: WINDOW_B.to });
  });

  test('every emitted query carries the ClickHouse resource caps', async () => {
    const { client, calls } = capturingClient([
      [{ TopicId: 'topic-1', Name: 'One' }],
      [{ TopicId: 'topic-1', c: '1' }],
      [],
    ]);

    await getTopicMixDeltas(client, SCOPE, 'issues', WINDOW_A, WINDOW_B, 20);

    expect(calls).toHaveLength(3);
    for (const call of calls) {
      expect(call.clickhouse_settings).toMatchObject({
        max_memory_usage: COMPARE_QUERY_SETTINGS.max_memory_usage,
        max_rows_to_read: COMPARE_QUERY_SETTINGS.max_rows_to_read,
      });
    }
  });
});
