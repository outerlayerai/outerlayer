import { describe, expect, test } from 'vitest';
import {
  TopicsService,
  TOPICS_QUERY_SETTINGS,
  MAX_MAP_TOPICS,
  buildTopicsService,
  facetsEnvClause,
  minExtractorVersionForFacet,
  samplableRowsClause,
  resolveGenerationFloor,
} from '../services/topics';
import { STEERING_EXTRACTOR_VERSION, BATCHED_EXTRACTOR_VERSION, NO_MATCH_TOPIC_ID } from '@repo/trace-topics';
import { MIN_SUMMARIES_FOR_GENERATION, MIN_STEERING_SUMMARIES_FOR_GENERATION } from '@repo/api-schemas';
import type { IClickHouseQuery } from '../client';

const SCOPE = {
  tenantId: 'tenant-1',
  appId: 'app-1',
  environment: 'production',
  environmentIsDefault: false,
};

const DAY_MS = 86_400_000;
/** Formats an offset in whole days from a fixed base as the axis's own
 * midnight-UTC bucket string, independent of the axis's internal fmt logic. */
const dayBucket = (n: number) =>
  `${new Date(Date.UTC(2026, 5, 1, 0, 0, 0) + n * DAY_MS).toISOString().slice(0, 10)} 00:00:00`;

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
  test('the map query fetches the safety cap, not the caller\'s limit — ranking happens after the fetch', async () => {
    const { client, calls } = capturingClient([[], [{ c: '0' }]]);
    await buildTopicsService(client, { modelEnv: {} }).listTopics(SCOPE, 'task');
    expect(calls[0]!.query).toContain('LIMIT {mapRowsCap:UInt32}');
    expect(calls[0]!.query_params!['mapRowsCap']).toBe(MAX_MAP_TOPICS);

    const { client: client2, calls: calls2 } = capturingClient([[], [{ c: '0' }]]);
    await buildTopicsService(client2, { modelEnv: {} }).listTopics(SCOPE, 'task', 5);
    // A tiny caller limit must not shrink the map fetch — session counts for
    // every topic have to be known before ranking picks the top 5.
    expect(calls2[0]!.query_params!['mapRowsCap']).toBe(MAX_MAP_TOPICS);
  });

  test('ranks all of a facet\'s topics by live session count before truncating to limit — TopicId order disagrees with count order here', async () => {
    const mapRows = ['v1-a', 'v1-b', 'v1-c'].map((topicId) => ({
      TopicId: topicId,
      Name: topicId,
      Description: '',
      MapVersion: 1,
      GeneratedAt: '2026-07-01 12:00:00.000',
      AvgLatencyMs: 0,
      AvgCostUsd: 0,
      ErrorRate: 0,
    }));
    // TopicId-ascending order (a, b, c) disagrees with session-count order
    // (c, b, a) — a `LIMIT 2` applied before counting would keep a+b and
    // drop c, the highest-traffic topic.
    const { client } = capturingClient([
      mapRows,
      [
        { TopicId: 'v1-a', c: '1' },
        { TopicId: 'v1-b', c: '2' },
        { TopicId: 'v1-c', c: '100' },
      ],
      [{ c: '103' }],
      [],
      [{ c: '0' }],
    ]);
    const list = await new TopicsService(client, { modelEnv: {} }).listTopics(SCOPE, 'task', 2);
    expect(list.topics).toHaveLength(2);
    expect(list.topics.map((t) => t.topicId)).toEqual(['v1-c', 'v1-b']);
    expect(list.topics.map((t) => t.sessionCount)).toEqual([100, 2]);
  });

  test('an absent limit returns every topic in the map, fully ranked, never truncating to a default page size', async () => {
    const TOPIC_COUNT = 30;
    const topicIds = Array.from({ length: TOPIC_COUNT }, (_, i) => `v1-${String(i).padStart(2, '0')}`);
    const mapRows = topicIds.map((topicId) => ({
      TopicId: topicId,
      Name: topicId,
      Description: '',
      MapVersion: 1,
      GeneratedAt: '2026-07-01 12:00:00.000',
      AvgLatencyMs: 0,
      AvgCostUsd: 0,
      ErrorRate: 0,
    }));
    // Session counts run opposite to the map's TopicId order (topic 0 is
    // lowest-traffic, topic 29 highest) — a correct "rank first, then return
    // everything" pass comes back in the REVERSE of mapRows order; a bug
    // that returned mapRows unsorted (or truncated to a default page size)
    // would fail either the length or the ordering assertion below.
    const countRows = topicIds.map((topicId, i) => ({ TopicId: topicId, c: String(i + 1) }));
    const { client } = capturingClient([mapRows, countRows, [{ c: '465' }], [], [{ c: '0' }]]);

    const list = await new TopicsService(client, { modelEnv: {} }).listTopics(SCOPE, 'task');

    expect(list.topics).toHaveLength(TOPIC_COUNT);
    expect(list.topics.map((t) => t.topicId)).toEqual([...topicIds].reverse());
    expect(list.topics[0]!.sessionCount).toBe(TOPIC_COUNT);
    expect(list.topics[TOPIC_COUNT - 1]!.sessionCount).toBe(1);
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

  test('when there is no active map, returns the exact cold-start shape', async () => {
    const { client } = capturingClient([[], [{ c: '7' }]]);
    const list = await buildTopicsService(client, { modelEnv: {} }).listTopics(SCOPE, 'task');

    expect(list).toEqual({
      facet: 'task',
      mapVersion: 0,
      generatedAt: null,
      topics: [],
      noMatchCount: 0,
      samplableCount: 7,
      required: MIN_SUMMARIES_FOR_GENERATION,
      trendDays: [],
      noMatchTrend: [],
      trendBucket: 'hour',
    });
  });

  test('an empty samplable-rows result reports zero, not NaN or undefined', async () => {
    const { client } = capturingClient([[], []]);
    const list = await buildTopicsService(client, { modelEnv: {} }).listTopics(SCOPE, 'task');
    expect(list.samplableCount).toBe(0);
  });

  test('empty trend rows produce the empty-hour cold shape even with an active map', async () => {
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
          ErrorRate: 0,
        },
      ],
      [{ TopicId: 'v1-c0', c: '5' }],
      [{ c: '5' }],
      [],
      [{ c: '0' }],
    ]);
    const list = await new TopicsService(client, { modelEnv: {} }).listTopics(SCOPE, 'task');

    expect(list.trendDays).toEqual([]);
    expect(list.noMatchTrend).toEqual([]);
    expect(list.trendBucket).toBe('hour');
    expect(list.topics[0]!.trend).toEqual([]);
  });

  test('a span exactly at the 48h hourly/daily boundary stays hourly; one minute past it switches to daily', async () => {
    const mapRows = [
      {
        TopicId: 'v1-c0',
        Name: 'Refunds',
        Description: '',
        MapVersion: 1,
        GeneratedAt: '2026-07-01 12:00:00.000',
        AvgLatencyMs: 0,
        AvgCostUsd: 0,
        ErrorRate: 0,
      },
    ];

    const { client: atBoundary } = capturingClient([
      mapRows,
      [{ TopicId: 'v1-c0', c: '5' }],
      [{ c: '5' }],
      [
        { TopicId: 'v1-c0', bucket: '2026-06-01 00:00:00', c: '2' },
        { TopicId: 'v1-c0', bucket: '2026-06-03 00:00:00', c: '3' },
      ],
      [{ c: '0' }],
    ]);
    const atList = await new TopicsService(atBoundary, { modelEnv: {} }).listTopics(SCOPE, 'task');
    expect(atList.trendBucket).toBe('hour');
    expect(atList.trendDays).toHaveLength(49);
    expect(atList.trendDays[0]).toBe('2026-06-01 00:00:00');
    expect(atList.trendDays[48]).toBe('2026-06-03 00:00:00');

    const { client: pastBoundary } = capturingClient([
      mapRows,
      [{ TopicId: 'v1-c0', c: '5' }],
      [{ c: '5' }],
      [
        { TopicId: 'v1-c0', bucket: '2026-06-01 00:00:00', c: '2' },
        { TopicId: 'v1-c0', bucket: '2026-06-03 00:01:00', c: '3' },
      ],
      [{ c: '0' }],
    ]);
    const pastList = await new TopicsService(pastBoundary, { modelEnv: {} }).listTopics(SCOPE, 'task');
    expect(pastList.trendBucket).toBe('day');
  });

  test('an axis of exactly 90 buckets is kept whole; 91 buckets drops the oldest and its rows', async () => {
    const mapRows = [
      {
        TopicId: 'v1-c0',
        Name: 'Refunds',
        Description: '',
        MapVersion: 1,
        GeneratedAt: '2026-07-01 12:00:00.000',
        AvgLatencyMs: 0,
        AvgCostUsd: 0,
        ErrorRate: 0,
      },
    ];

    const { client: exact90 } = capturingClient([
      mapRows,
      [{ TopicId: 'v1-c0', c: '5' }],
      [{ c: '5' }],
      [
        { TopicId: 'v1-c0', bucket: dayBucket(0), c: '1' },
        { TopicId: 'v1-c0', bucket: dayBucket(89), c: '2' },
      ],
      [{ c: '0' }],
    ]);
    const exactList = await new TopicsService(exact90, { modelEnv: {} }).listTopics(SCOPE, 'task');
    expect(exactList.trendDays).toHaveLength(90);
    expect(exactList.trendDays[0]).toBe(dayBucket(0));
    expect(exactList.trendDays[89]).toBe(dayBucket(89));

    const { client: sliced91 } = capturingClient([
      mapRows,
      [{ TopicId: 'v1-c0', c: '5' }],
      [{ c: '5' }],
      [
        { TopicId: 'v1-c0', bucket: dayBucket(0), c: '9' },
        { TopicId: 'v1-c0', bucket: dayBucket(1), c: '7' },
        { TopicId: 'v1-c0', bucket: dayBucket(90), c: '2' },
      ],
      [{ c: '0' }],
    ]);
    const slicedList = await new TopicsService(sliced91, { modelEnv: {} }).listTopics(SCOPE, 'task');
    expect(slicedList.trendDays).toHaveLength(90);
    expect(slicedList.trendDays[0]).toBe(dayBucket(1));
    expect(slicedList.trendDays[89]).toBe(dayBucket(90));
    // Day 0 fell off the sliced axis: its row is dropped, not folded into day 1.
    expect(slicedList.topics[0]!.trend[0]).toBe(7);
    expect(slicedList.topics[0]!.trend[89]).toBe(2);
  });

  test('a topic present on the map but absent from the trend data gets an exact all-zero series', async () => {
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
          ErrorRate: 0,
        },
        {
          TopicId: 'v1-c2',
          Name: 'No trend data',
          Description: '',
          MapVersion: 1,
          GeneratedAt: '2026-07-01 12:00:00.000',
          AvgLatencyMs: 0,
          AvgCostUsd: 0,
          ErrorRate: 0,
        },
      ],
      [{ TopicId: 'v1-c0', c: '5' }],
      [{ c: '5' }],
      [
        { TopicId: 'v1-c0', bucket: '2026-06-01 00:00:00', c: '2' },
        { TopicId: 'v1-c0', bucket: '2026-06-02 00:00:00', c: '3' },
      ],
      [{ c: '0' }],
    ]);
    const list = await new TopicsService(client, { modelEnv: {} }).listTopics(SCOPE, 'task');
    const noTrend = list.topics.find((t) => t.topicId === 'v1-c2')!;
    expect(noTrend.trend).toEqual(new Array(list.trendDays.length).fill(0));
    expect(noTrend.trend).toHaveLength(list.trendDays.length);
  });

  test('noMatchCount reads the NO_MATCH_TOPIC_ID row when present, and is exactly 0 when absent', async () => {
    const mapRows = [
      {
        TopicId: 'v1-c0',
        Name: 'Refunds',
        Description: '',
        MapVersion: 1,
        GeneratedAt: '2026-07-01 12:00:00.000',
        AvgLatencyMs: 0,
        AvgCostUsd: 0,
        ErrorRate: 0,
      },
    ];

    const { client: withNoMatch } = capturingClient([
      mapRows,
      [
        { TopicId: 'v1-c0', c: '3' },
        { TopicId: NO_MATCH_TOPIC_ID, c: '7' },
      ],
      [{ c: '10' }],
      [],
      [{ c: '0' }],
    ]);
    const withList = await new TopicsService(withNoMatch, { modelEnv: {} }).listTopics(SCOPE, 'task');
    expect(withList.noMatchCount).toBe(7);

    const { client: withoutNoMatch } = capturingClient([
      mapRows,
      [{ TopicId: 'v1-c0', c: '3' }],
      [{ c: '3' }],
      [],
      [{ c: '0' }],
    ]);
    const withoutList = await new TopicsService(withoutNoMatch, { modelEnv: {} }).listTopics(SCOPE, 'task');
    expect(withoutList.noMatchCount).toBe(0);
  });

  test('totalClassified falls back to 0 when the denominator query returns no row, and shares divide exactly', async () => {
    const mapRows = [
      {
        TopicId: 'v1-c0',
        Name: 'Refunds',
        Description: '',
        MapVersion: 1,
        GeneratedAt: '2026-07-01 12:00:00.000',
        AvgLatencyMs: 0,
        AvgCostUsd: 0,
        ErrorRate: 0,
      },
    ];

    const { client: noDenominatorRow } = capturingClient([
      mapRows,
      [{ TopicId: 'v1-c0', c: '3' }],
      [],
      [],
      [{ c: '0' }],
    ]);
    const noDenomList = await new TopicsService(noDenominatorRow, { modelEnv: {} }).listTopics(SCOPE, 'task');
    expect(noDenomList.topics[0]!.share).toBe(0);

    const { client: withDenominator } = capturingClient([
      mapRows,
      [{ TopicId: 'v1-c0', c: '3' }],
      [{ c: '12' }],
      [],
      [{ c: '0' }],
    ]);
    const withDenomList = await new TopicsService(withDenominator, { modelEnv: {} }).listTopics(SCOPE, 'task');
    expect(withDenomList.topics[0]!.share).toBe(0.25);
  });

  test('the active-facet-rows SQL includes the subagent/agent-origin exclusions for task but not for issues', async () => {
    const mapRows = [
      {
        TopicId: 'v1-c0',
        Name: 'Refunds',
        Description: '',
        MapVersion: 1,
        GeneratedAt: '2026-07-01 12:00:00.000',
        AvgLatencyMs: 0,
        AvgCostUsd: 0,
        ErrorRate: 0,
      },
    ];

    const { client: taskClient, calls: taskCalls } = capturingClient([
      mapRows,
      [{ TopicId: 'v1-c0', c: '1' }],
      [{ c: '1' }],
      [],
      [{ c: '0' }],
    ]);
    await new TopicsService(taskClient, { modelEnv: {} }).listTopics(SCOPE, 'task');
    expect(taskCalls[1]!.query).toContain("AND s.ParentSessionId = ''");
    expect(taskCalls[1]!.query).toContain("Origin = 'agent'");

    const { client: issuesClient, calls: issuesCalls } = capturingClient([
      mapRows,
      [{ TopicId: 'v1-c0', c: '1' }],
      [{ c: '1' }],
      [],
      [{ c: '0' }],
    ]);
    await new TopicsService(issuesClient, { modelEnv: {} }).listTopics(SCOPE, 'issues');
    expect(issuesCalls[1]!.query).not.toContain("AND s.ParentSessionId = ''");
    expect(issuesCalls[1]!.query).not.toContain("Origin = 'agent'");
  });
});

describe('facetsEnvClause', () => {
  test('sweeps in legacy empty-Environment rows only when scoped to the default environment', () => {
    expect(facetsEnvClause({ ...SCOPE, environmentIsDefault: true })).toBe(
      "(Environment = {environment:String} OR Environment = '')",
    );
    expect(facetsEnvClause({ ...SCOPE, environmentIsDefault: false })).toBe(
      'Environment = {environment:String}',
    );
  });
});

describe('minExtractorVersionForFacet', () => {
  test('steering requires its own extractor version; task and issues require the shared batched version', () => {
    expect(minExtractorVersionForFacet('steering')).toBe(STEERING_EXTRACTOR_VERSION);
    expect(minExtractorVersionForFacet('task')).toBe(BATCHED_EXTRACTOR_VERSION);
    expect(minExtractorVersionForFacet('issues')).toBe(BATCHED_EXTRACTOR_VERSION);
  });
});

describe('samplableRowsClause', () => {
  test('excludes subagent/agent-origin traces for task and steering but not for issues', () => {
    const taskClause = samplableRowsClause(SCOPE, 'task');
    const issuesClause = samplableRowsClause(SCOPE, 'issues');
    const steeringClause = samplableRowsClause(SCOPE, 'steering');

    expect(taskClause).toContain("AND TraceId NOT IN (");
    expect(taskClause).toContain("ParentSessionId != '' OR Origin = 'agent'");
    expect(steeringClause).toContain("AND TraceId NOT IN (");
    expect(issuesClause).not.toContain('TraceId NOT IN');
  });
});

describe('resolveGenerationFloor', () => {
  test('an override below 5 is ignored and falls back to the facet default', () => {
    expect(resolveGenerationFloor('task', 4)).toBe(MIN_SUMMARIES_FOR_GENERATION);
  });

  test('an override at exactly 5 is used', () => {
    expect(resolveGenerationFloor('task', 5)).toBe(5);
  });

  test('no override falls back to the facet default', () => {
    expect(resolveGenerationFloor('task', undefined)).toBe(MIN_SUMMARIES_FOR_GENERATION);
    expect(resolveGenerationFloor('steering', undefined)).toBe(MIN_STEERING_SUMMARIES_FOR_GENERATION);
  });
});
