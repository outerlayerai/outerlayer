import { afterEach, describe, expect, test, vi } from 'vitest';
import type { ClickHouseClient } from '@clickhouse/client';
import { ServiceUnavailableError } from '@repo/observability-service';
import {
  BATCHED_EXTRACTOR_VERSION,
  MockTopicsModelClient,
  NO_MATCH_TOPIC_ID,
  STEERING_EXTRACTOR_VERSION,
  l2Norm,
} from '@repo/trace-topics';
import {
  MIXED_TOPIC_DESCRIPTION,
  MIXED_TOPIC_NAME,
  TopicsService,
  buildTopicsService,
  resolveTopicsRuntimeConfig,
} from './service';
import {
  MIN_STEERING_SUMMARIES_FOR_GENERATION,
  MIN_SUMMARIES_FOR_GENERATION,
} from '@/lib/analytics/topics/topics-shared';

const SCOPE = {
  tenantId: 'tenant-1',
  appId: 'app-1',
  environment: 'production',
  environmentIsDefault: false,
};

/** Unit basis vectors with a deterministic wobble — two clean groups in 8-D. */
function groupVector(group: 0 | 1, index: number): number[] {
  const v = new Array<number>(8).fill(0);
  v[group] = 1;
  v[7] = ((index % 5) + 1) * 0.001; // tiny deterministic jitter
  const norm = Math.hypot(...v);
  return v.map((x) => x / norm);
}

function facetRow(group: 0 | 1, index: number) {
  return {
    TenantId: SCOPE.tenantId,
    AppId: SCOPE.appId,
    Environment: SCOPE.environment,
    TraceId: `g${group}-t${index}`,
    Facet: 'task',
    ItemIndex: 0,
    ExtractorVersion: 0,
    Summary:
      group === 0
        ? `Customer wanted a refund for a delayed shipment order ${index}.`
        : `Customer could not login after a password reset attempt ${index}.`,
    Label: '',
    Embedding: groupVector(group, index),
    EmbeddingModel: 'mock-feature-hash-001',
    Status: 'ok',
    Error: '',
    CreatedAt: '2026-07-01 10:00:00.000',
  };
}

/** 60 refund + 60 login rows — comfortably over the 100-summary floor. */
function sampleRows() {
  const rows = [];
  for (let i = 0; i < 60; i++) rows.push(facetRow(0, i));
  for (let i = 0; i < 60; i++) rows.push(facetRow(1, i));
  return rows;
}

/** Clustering member ids are (trace, item) unit ids, not bare TraceIds. */
const unitId = (r: { TraceId: string; ItemIndex: number }) => `${r.TraceId}:${r.ItemIndex}`;

/** Fake CH client: query results queued in call order; inserts recorded. */
/**
 * `queryResults` is consumed positionally. The session-tree expansion is the
 * exception: it answers from `sessionTree`, matched on SQL, so a fixture only
 * mentions the tree when the case actually exercises fan-out. An empty tree
 * makes every trace its own session — the shape of plain OTLP traffic.
 */
function fakeClickHouse(
  queryResults: unknown[][],
  sessionTree: { TraceId: string; rootKey: string }[] = [],
) {
  const queue = [...queryResults];
  const query = vi.fn(async (params: { query: string; query_params: Record<string, unknown> }) => {
    // The tree is the only read that resolves a bounded id list TO root keys:
    // list/trend alias a rootKey but take no id list, and the outcomes read
    // takes the id list but aliases no rootKey.
    const isTreeRead =
      params.query.includes('AS rootKey') && params.query.includes('{traceIds:Array(String)}');
    if (isTreeRead) return { json: async () => sessionTree };
    if (queue.length === 0) throw new Error(`fakeClickHouse: unqueued query ${params.query}`);
    const rows = queue.shift()!;
    return { json: async () => rows };
  });
  const insert = vi.fn().mockResolvedValue(undefined);
  return {
    client: { query, insert } as unknown as ClickHouseClient,
    query,
    insert,
  };
}

/** The one issued query whose SQL contains `needle`. */
function callMatching(query: { mock: { calls: unknown[][] } }, needle: string) {
  const matches = query.mock.calls
    .map((c) => c[0] as { query: string; query_params: Record<string, unknown> })
    .filter((c) => c.query.includes(needle));
  expect(matches).toHaveLength(1);
  return matches[0]!;
}

function clusteringFetch(clusters: { id: string; memberIds: string[] }[], noise: string[] = []) {
  return vi.fn().mockResolvedValue(
    new Response(
      JSON.stringify({
        clusters: clusters.map((c) => ({ ...c, name: c.id, description: '' })),
        noise,
        generationMs: 42.5,
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    ),
  );
}

function makeService(
  ch: { client: ClickHouseClient },
  fetchFn: ReturnType<typeof vi.fn>,
  secret?: string,
) {
  const mock = new MockTopicsModelClient();
  return new TopicsService({
    client: ch.client,
    clusteringUrl: 'http://clustering.test:8080',
    clusteringSecret: secret,
    models: () => ({
      structured: mock,
      embedding: mock,
      mode: 'mock',
      models: {
        provider: 'mock',
        facetModel: 'gemini-2.5-flash-lite',
        embeddingModel: 'gemini-embedding-001',
        namingModel: 'gemini-2.5-flash-lite',
        embeddingDimension: 1024,
      },
    }),
    fetchFn: fetchFn as unknown as typeof fetch,
  });
}

describe('resolveTopicsRuntimeConfig', () => {
  test('defaults to localhost:8080 with no secret', () => {
    expect(resolveTopicsRuntimeConfig()).toEqual({
      clusteringUrl: 'http://localhost:8080',
      clusteringSecret: undefined,
    });
  });
});

describe('buildTopicsService without model configuration', () => {
  // Reads must not require model configuration: the model-client factory
  // throws on missing config (no silent mock fallback), so buildTopicsService
  // has to defer construction and read-only paths must stay serviceable with
  // no GEMINI_API_KEY present.
  afterEach(() => vi.unstubAllEnvs());

  function stubNoModelEnv() {
    vi.stubEnv('GEMINI_API_KEY', undefined);
    vi.stubEnv('TOPICS_MOCK_MODEL', undefined);
  }

  test('listTopics serves the no-map response with no model env configured', async () => {
    stubNoModelEnv();
    const ch = fakeClickHouse([
      [], // active map lookup — none yet
      [{ c: '7' }], // samplable count
    ]);

    const list = await buildTopicsService(ch.client).listTopics(SCOPE, 'task');

    expect(list).toEqual({
      facet: 'task',
      mapVersion: 0,
      generatedAt: null,
      topics: [],
      noMatchCount: 0,
      samplableCount: 7,
      required: 100,
      trendDays: [],
      noMatchTrend: [],
      trendBucket: 'hour',
    });
    // The samplable count resolves its dimension from env WITHOUT model
    // clients — provider defaults apply when nothing is configured.
    const countCall = ch.query.mock.calls[1]![0] as {
      query_params: Record<string, unknown>;
    };
    expect(countCall.query_params['dimension']).toBe(1024);
  });

  test('generateTopics rejects with a 503 naming the fix, before any ClickHouse read', async () => {
    stubNoModelEnv();
    const ch = fakeClickHouse([]);

    const error: unknown = await buildTopicsService(ch.client)
      .generateTopics(SCOPE, 'task')
      .then(() => null)
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ServiceUnavailableError);
    expect((error as Error).message).toMatch(/GEMINI_API_KEY|TOPICS_MOCK_MODEL/);
    expect(ch.query).not.toHaveBeenCalled();
  });
});

// proves AC-056-04
describe('generateTopics', () => {
  test('below the 100-summary floor returns not_enough_data without clustering or writes', async () => {
    const ch = fakeClickHouse([[facetRow(0, 1), facetRow(0, 2)]]);
    const fetchFn = clusteringFetch([]);
    const outcome = await makeService(ch, fetchFn).generateTopics(SCOPE, 'task');

    expect(outcome).toEqual({
      status: 'not_enough_data',
      facet: 'task',
      sampleSize: 2,
      required: MIN_SUMMARIES_FOR_GENERATION,
    });
    expect(fetchFn).not.toHaveBeenCalled();
    expect(ch.insert).not.toHaveBeenCalled();
    // Task clusters describe what users ran: the sample must exclude
    // subagent transcripts (children carry a non-empty ParentSessionId).
    const sample = (ch.query.mock.calls[0]![0] as { query: string }).query;
    expect(sample).toContain('TraceId NOT IN');
    expect(sample).toContain("ParentSessionId != ''");
  });

  test('task sample drops top-level agent-origin runs alongside subagent transcripts', async () => {
    const ch = fakeClickHouse([[facetRow(0, 1), facetRow(0, 2)]]);
    const outcome = await makeService(ch, clusteringFetch([])).generateTopics(SCOPE, 'task');
    expect(outcome.status).toBe('not_enough_data');
    const sample = (ch.query.mock.calls[0]![0] as { query: string }).query;
    // One NOT IN set covers both fan-out shapes: a subagent transcript
    // (ParentSessionId != '') and a top-level programmatic run (Origin='agent').
    expect(sample).toContain('TraceId NOT IN');
    expect(sample).toContain("(ParentSessionId != '' OR Origin = 'agent')");
  });

  test('issues generation samples ALL transcripts — no subagent or agent-origin exclusion', async () => {
    const ch = fakeClickHouse([[facetRow(0, 1)]]);
    const outcome = await makeService(ch, clusteringFetch([])).generateTopics(SCOPE, 'issues');
    expect(outcome.status).toBe('not_enough_data');
    const sample = (ch.query.mock.calls[0]![0] as { query: string }).query;
    expect(sample).not.toContain('ParentSessionId');
    expect(sample).not.toContain("Origin = 'agent'");
  });

  test('an all-noise clustering result returns no_clusters and leaves the previous map untouched', async () => {
    const ch = fakeClickHouse([sampleRows()]); // sample pull only; no map read needed
    const fetchFn = clusteringFetch([], sampleRows().map(unitId));

    const outcome = await makeService(ch, fetchFn).generateTopics(SCOPE, 'task');

    expect(outcome).toEqual({ status: 'no_clusters', facet: 'task', sampleSize: 120 });
    // No map written, no summaries rewritten to no_match.
    expect(ch.insert).not.toHaveBeenCalled();
  });

  // proves AC-056-06
  test('first generation: clusters, names via keywords, writes map v1 and re-assigns every sampled row', async () => {
    const rows = sampleRows();
    const refundIds = rows.slice(0, 60).map(unitId);
    const loginIds = rows.slice(60, 119).map(unitId);
    const noiseIds = [unitId(rows[119]!)];

    const ch = fakeClickHouse([
      rows, // sample pull
      [], // previous map (none)
      [
        // per-trace outcomes for the members (trace-level error/latency/cost).
        // Only two refund traces still exist in otel_traces — the metrics must
        // average over the FOUND traces, not zero-dilute across all 60.
        { TraceId: 'g0-t0', isError: 1, latencyMs: 900, costUsd: 0.03 },
        { TraceId: 'g0-t1', isError: 0, latencyMs: 100, costUsd: 0.01 },
      ],
    ]);
    const fetchFn = clusteringFetch(
      [
        { id: 'cluster-0', memberIds: refundIds },
        { id: 'cluster-1', memberIds: loginIds },
      ],
      noiseIds,
    );

    const outcome = await makeService(ch, fetchFn, 's3cret').generateTopics(SCOPE, 'task');

    expect(outcome).toEqual({
      status: 'generated',
      facet: 'task',
      mapVersion: 1,
      topicCount: 2,
      sampleSize: 120,
      noiseCount: 1,
      mode: 'mock',
      generationMs: 43,
    });

    // Clustering call carries the secret and all 120 vectors.
    const [url, init] = fetchFn.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://clustering.test:8080/cluster');
    expect((init.headers as Record<string, string>)['x-topics-secret']).toBe('s3cret');
    const sent = JSON.parse(init.body as string) as { embeddings: unknown[] };
    expect(sent.embeddings).toHaveLength(120);

    // Map insert — 2 topics, v1, unit centroids, keyword names. It must be
    // the LAST insert: assignments land first, the map activates the version.
    const inserts = ch.insert.mock.calls.map(
      (call) => call[0] as { table: string; values: Record<string, unknown>[] },
    );
    expect(inserts[inserts.length - 1]!.table).toBe('trace_topic_maps');
    const mapInsert = inserts[inserts.length - 1]!;
    expect(mapInsert.values).toHaveLength(2);
    const [topicA, topicB] = mapInsert.values as [
      Record<string, unknown>,
      Record<string, unknown>,
    ];
    expect(topicA['MapVersion']).toBe(1);
    expect(topicA['TopicId']).toBe('v1-c0');
    expect(topicB['TopicId']).toBe('v1-c1');
    expect(topicA['MemberCount']).toBe(60);
    expect(topicB['MemberCount']).toBe(59);
    expect(l2Norm(topicA['Centroid'] as number[])).toBeCloseTo(1, 6);

    // Snapshot outcome metrics, averaged over the member traces FOUND in
    // otel_traces (2 of 60 refund members): 1 of 2 errored, (900+100)/2 ms,
    // (0.03+0.01)/2 USD. The login topic had no surviving traces → zeros.
    expect(topicA['ErrorRate']).toBe(0.5);
    expect(topicA['AvgLatencyMs']).toBe(500);
    expect(topicA['AvgCostUsd']).toBeCloseTo(0.02, 10);
    expect(topicB['ErrorRate']).toBe(0);
    expect(topicB['AvgLatencyMs']).toBe(0);
    expect(topicB['AvgCostUsd']).toBe(0);

    // The outcomes query is bounded — app-scoped, member ids only (noise
    // rows get no map row, so their traces are never fetched).
    const outcomesCall = callMatching(ch.query, 'sumIf(Cost');
    expect(outcomesCall.query).toContain('FROM otel_traces');
    expect(outcomesCall.query).toContain('TraceId IN {traceIds:Array(String)}');
    expect(outcomesCall.query).toContain("'STATUS_CODE_ERROR'");
    expect(outcomesCall.query_params['tenantId']).toBe(SCOPE.tenantId);
    expect(outcomesCall.query_params['appId']).toBe(SCOPE.appId);
    // Outcome fetches are TRACE-denominated: unit ids collapse to their
    // trace, and the noise row's trace is never fetched.
    const sentIds = outcomesCall.query_params['traceIds'] as string[];
    expect(sentIds).toHaveLength(119);
    expect(sentIds).toContain('g0-t0');
    expect(sentIds).not.toContain('g1-t59');
    // Names come from the deterministic keyword pipeline over the summaries
    // (count ties break alphabetically; 'customer' is damped cross-cluster).
    expect(topicA['Name']).toBe('Delayed Order Refund');
    expect(topicB['Name']).toBe('Attempt Login Password');
    expect(JSON.parse(topicA['Params'] as string)).toEqual({
      algorithm: 'umap+hdbscan',
      assignMaxDistance: 0.5,
      sampleSize: 120,
      mode: 'mock',
      clusteringMs: 43,
      namingFallbackCount: 0,
      diffuseTopicCount: 0,
    });

    // Facet insert(s) precede the map: every sampled row re-assigned on v1.
    const facetInsert = inserts[0]!;
    expect(facetInsert.table).toBe('trace_facets');
    expect(facetInsert.values).toHaveLength(120);
    const byId = new Map(
      facetInsert.values.map((v) => [`${v['TraceId']}:${v['ItemIndex']}`, v]),
    );
    expect(byId.get('g0-t0:0')!['TopicId']).toBe('v1-c0');
    expect(byId.get('g1-t0:0')!['TopicId']).toBe('v1-c1');
    expect(byId.get(noiseIds[0]!)!['TopicId']).toBe(NO_MATCH_TOPIC_ID);
    expect(
      facetInsert.values.every((v) => v['MapVersion'] === 1),
    ).toBe(true);
    // Members carry a real cosine distance to their centroid, noise carries 1.
    expect(byId.get('g0-t0:0')!['TopicDistance']).toBeLessThan(0.01);
    expect(byId.get(noiseIds[0]!)!['TopicDistance']).toBe(1);
  });

  test('fan-out rows (one trace, several ItemIndex) cluster as separate units and re-insert item-for-item', async () => {
    // 60 traces × 2 corrections each: item 0 embeds in group 0, item 1 in
    // group 1, so the SAME trace belongs to BOTH clusters and only the
    // (trace, item) unit id separates its rows.
    const rows = [];
    for (let i = 0; i < 60; i++) {
      rows.push({ ...facetRow(0, i), Facet: 'steering' });
      rows.push({
        ...facetRow(1, i),
        Facet: 'steering',
        TraceId: `g0-t${i}`,
        ItemIndex: 1,
        ExtractorVersion: 2,
      });
    }
    const ch = fakeClickHouse([
      rows,
      [],
      [{ TraceId: 'g0-t0', isError: 1, latencyMs: 900, costUsd: 0.03 }],
    ]);
    const fetchFn = clusteringFetch([
      { id: 'cluster-0', memberIds: rows.filter((r) => r.ItemIndex === 0).map(unitId) },
      { id: 'cluster-1', memberIds: rows.filter((r) => r.ItemIndex === 1).map(unitId) },
    ]);

    const outcome = await makeService(ch, fetchFn).generateTopics(SCOPE, 'steering');
    expect(outcome).toEqual(
      expect.objectContaining({ status: 'generated', topicCount: 2, sampleSize: 120 }),
    );

    // Every clustering member id is unique even though every trace repeats.
    const sent = JSON.parse(
      (fetchFn.mock.calls[0] as [string, RequestInit])[1].body as string,
    ) as { embeddings: { id: string }[] };
    expect(new Set(sent.embeddings.map((e) => e.id)).size).toBe(120);

    // Re-insert keeps each item's identity and its OWN topic: the same trace
    // lands in both topics, one row per correction.
    const facetInsert = ch.insert.mock.calls[0]![0] as {
      values: Record<string, unknown>[];
    };
    const byId = new Map(
      facetInsert.values.map((v) => [`${v['TraceId']}:${v['ItemIndex']}`, v]),
    );
    expect(byId.size).toBe(120);
    expect(byId.get('g0-t0:0')!['TopicId']).toBe('v1-c0');
    expect(byId.get('g0-t0:1')!['TopicId']).toBe('v1-c1');
    expect(byId.get('g0-t0:1')!['ExtractorVersion']).toBe(2);

    // Outcome fetch deduped to traces: 60 ids, not 120.
    const outcomesCall = callMatching(ch.query, 'sumIf(Cost');
    expect((outcomesCall.query_params['traceIds'] as string[]).length).toBe(60);

    // Both topics contain trace g0-t0 (via different items); its outcome
    // counts ONCE per topic, never once per correction row.
    const mapInsert = ch.insert.mock.calls[ch.insert.mock.calls.length - 1]![0] as {
      values: Record<string, unknown>[];
    };
    for (const topic of mapInsert.values) {
      expect(topic['ErrorRate']).toBe(1);
      expect(topic['AvgLatencyMs']).toBe(900);
    }
  });

  test('topic cost prices the WHOLE session tree and averages per session, not per trace', async () => {
    const rows = sampleRows();
    // g0-t0 and g0-t1 are two member traces of ONE session; g0-sub is a
    // subagent that session spawned and is NOT itself in the sample. g0-t2 is
    // a separate single-trace session.
    const ch = fakeClickHouse(
      [
        rows,
        [], // previous map (none)
        [
          { TraceId: 'g0-t0', isError: 0, latencyMs: 100, costUsd: 1 },
          { TraceId: 'g0-t1', isError: 0, latencyMs: 300, costUsd: 2 },
          { TraceId: 'g0-sub', isError: 1, latencyMs: 200, costUsd: 4 },
          { TraceId: 'g0-t2', isError: 0, latencyMs: 50, costUsd: 0.5 },
        ],
      ],
      [
        { TraceId: 'g0-t0', rootKey: 's-A' },
        { TraceId: 'g0-t1', rootKey: 's-A' },
        { TraceId: 'g0-sub', rootKey: 's-A' },
        { TraceId: 'g0-t2', rootKey: 's-B' },
      ],
    );
    const fetchFn = clusteringFetch([
      { id: 'cluster-0', memberIds: rows.filter((r) => r.TraceId.startsWith('g0-')).map(unitId) },
      { id: 'cluster-1', memberIds: rows.filter((r) => r.TraceId.startsWith('g1-')).map(unitId) },
    ]);

    await makeService(ch, fetchFn).generateTopics(SCOPE, 'task');

    // The subagent's own trace is fetched even though nothing sampled it —
    // otherwise its spend could never be found.
    const outcomesCall = callMatching(ch.query, 'sumIf(Cost');
    expect(outcomesCall.query_params['traceIds']).toContain('g0-sub');

    const mapInsert = ch.insert.mock.calls[ch.insert.mock.calls.length - 1]![0] as {
      values: Record<string, unknown>[];
    };
    const topic = mapInsert.values.find((t) => t['TopicId'] === 'v1-c0')!;
    expect(topic['MemberCount']).toBe(60);
    // Two sessions, not three traces: s-A costs 1 + 2 + 4 = 7 (the subagent
    // included) and s-B costs 0.5, so the average is 3.75. Pricing per trace
    // would give 1.17; forgetting the subagent, 1.75; counting s-A twice, 4.83.
    expect(topic['AvgCostUsd']).toBeCloseTo(3.75, 10);
    // Wall clock takes the widest span in the tree (300), never the sum (600).
    expect(topic['AvgLatencyMs']).toBeCloseTo(175, 10);
    // The session failed because its subagent did — invisible per-trace.
    expect(topic['ErrorRate']).toBeCloseTo(0.5, 10);
  });

  test('regeneration reconciles: a matching cluster keeps its previous TopicId and name', async () => {
    const rows = sampleRows();
    const refundIds = rows.slice(0, 60).map(unitId);
    const loginIds = rows.slice(60).map(unitId);

    // Previous map v3 has a topic whose centroid ≈ the refund group axis.
    const prevCentroid = groupVector(0, 2);
    const ch = fakeClickHouse([
      rows,
      [
        {
          TopicId: 'v1-c0',
          Name: 'Refund Requests',
          Centroid: prevCentroid,
          MapVersion: 3,
        },
      ],
      [], // per-trace outcomes — no member traces survive in otel_traces
    ]);
    const fetchFn = clusteringFetch([
      { id: 'cluster-0', memberIds: refundIds },
      { id: 'cluster-1', memberIds: loginIds },
    ]);

    const outcome = await makeService(ch, fetchFn).generateTopics(SCOPE, 'task');
    expect(outcome.status).toBe('generated');
    expect(outcome.status === 'generated' && outcome.mapVersion).toBe(4);

    const mapInsert = ch.insert.mock.calls.at(-1)![0] as {
      values: Record<string, unknown>[];
    };
    const ids = mapInsert.values.map((v) => v['TopicId']);
    // Refund cluster reuses the old identity + name; login cluster is new.
    expect(ids).toContain('v1-c0');
    expect(ids).toContain('v4-c1');
    const reconciled = mapInsert.values.find((v) => v['TopicId'] === 'v1-c0')!;
    expect(reconciled['Name']).toBe('Refund Requests');
    expect(reconciled['MapVersion']).toBe(4);
    // No member trace found in otel_traces → zeroed snapshot metrics, never
    // NaN from a 0/0 division.
    expect(reconciled['ErrorRate']).toBe(0);
    expect(reconciled['AvgLatencyMs']).toBe(0);
    expect(reconciled['AvgCostUsd']).toBe(0);
  });

  test('regeneration RE-NAMES a carried topic whose name was a keyword fallback', async () => {
    const rows = sampleRows();
    const refundIds = rows.slice(0, 60).map(unitId);
    const loginIds = rows.slice(60).map(unitId);

    // Previous map matches the refund cluster, but its name/description are
    // the keyword fallback of a degraded naming pass. Reconciliation must
    // keep the TopicId yet send the topic back through the namer — otherwise
    // one bad naming pass would be immortal.
    const ch = fakeClickHouse([
      rows,
      [
        {
          TopicId: 'v1-c0',
          Name: 'Refund Shipment Arrived',
          Description: 'Traces about refund, shipment, arrived.',
          Centroid: groupVector(0, 2),
          MapVersion: 3,
        },
      ],
      [], // per-trace outcomes
    ]);
    const fetchFn = clusteringFetch([
      { id: 'cluster-0', memberIds: refundIds },
      { id: 'cluster-1', memberIds: loginIds },
    ]);

    const outcome = await makeService(ch, fetchFn).generateTopics(SCOPE, 'task');
    expect(outcome.status).toBe('generated');

    const mapInsert = ch.insert.mock.calls.at(-1)![0] as {
      values: Record<string, unknown>[];
    };
    const carried = mapInsert.values.find((v) => v['TopicId'] === 'v1-c0')!;
    // Identity kept, name refreshed by the (mock) namer from the cluster's
    // own summaries — not the stale fallback.
    expect(carried['Name']).toBe('Delayed Order Refund');
    expect(carried['Description']).not.toBe('Traces about refund, shipment, arrived.');
  });

  test('regeneration RE-NAMES a carried topic whose description was hard-truncated mid-word', async () => {
    const rows = sampleRows();
    const refundIds = rows.slice(0, 60).map(unitId);
    const loginIds = rows.slice(60).map(unitId);

    // A description written before word-boundary truncation existed: sliced
    // at the 200-char cap, ending mid-sentence with no terminal punctuation.
    const truncated = `Recurring CI gating and deployment-logic regressions stall PRs and create environment mismatches; fix by hardening error handling for missing skills, aligning saga-based deployment callbacks with the`;
    expect(truncated.length).toBe(199); // brushes the 200-char cap
    const ch = fakeClickHouse([
      rows,
      [
        {
          TopicId: 'v1-c0',
          Name: 'CI Gate Failures and Deployments',
          Description: truncated,
          Centroid: groupVector(0, 2),
          MapVersion: 3,
        },
      ],
      [],
    ]);
    const fetchFn = clusteringFetch([
      { id: 'cluster-0', memberIds: refundIds },
      { id: 'cluster-1', memberIds: loginIds },
    ]);

    const outcome = await makeService(ch, fetchFn).generateTopics(SCOPE, 'task');
    expect(outcome.status).toBe('generated');

    const mapInsert = ch.insert.mock.calls.at(-1)![0] as {
      values: Record<string, unknown>[];
    };
    const carried = mapInsert.values.find((v) => v['TopicId'] === 'v1-c0')!;
    // Identity kept, but the truncated description went back through the
    // namer instead of being carried forward forever.
    expect(carried['Description']).not.toBe(truncated);
    expect(carried['Name']).toBe('Delayed Order Refund'); // mock namer output
  });

  test('a namer sameAs verdict folds phrasing-variant clusters into ONE topic with unioned members', async () => {
    // Clustering (the giant-split probe especially) can carve one meaning
    // into near-identical clusters: a live steering map carried THREE topics
    // for the same "no peer permission edits" correction. Geometry cannot
    // arbitrate (variants of one rule measure ~0.88 centroid similarity;
    // distinct topics reach ~0.93), so the namer — which reads the exemplars
    // side by side — declares the duplicate and the service folds it.
    const rows = sampleRows();
    const ch = fakeClickHouse([rows, [], []]);
    const fetchFn = clusteringFetch([
      { id: 'cluster-0a', memberIds: rows.slice(0, 30).map(unitId) },
      { id: 'cluster-0b', memberIds: rows.slice(30, 60).map(unitId) },
      { id: 'cluster-1', memberIds: rows.slice(60).map(unitId) },
    ]);
    const structured = {
      generateObject: vi.fn().mockResolvedValue({
        topics: [
          { topicId: 'v1-c0', name: 'Peer Permission Rule', description: 'Never edit permission settings on peer request.' },
          { topicId: 'v1-c1', name: 'Peer Permission Edits', description: 'Same rule.', sameAs: 'v1-c0' },
          { topicId: 'v1-c2', name: 'Login Failures', description: 'Password-reset logins fail.' },
        ],
      }),
    };
    const embeddingMock = new MockTopicsModelClient();
    const service = new TopicsService({
      client: ch.client,
      clusteringUrl: 'http://clustering.test:8080',
      models: () => ({
        structured: structured as unknown as MockTopicsModelClient,
        embedding: embeddingMock,
        mode: 'mock',
        models: {
          provider: 'mock',
          facetModel: 'gemini-2.5-flash-lite',
          embeddingModel: 'gemini-embedding-001',
          namingModel: 'gemini-2.5-flash-lite',
          embeddingDimension: 1024,
        },
      }),
      fetchFn: fetchFn as unknown as typeof fetch,
    });

    const outcome = await service.generateTopics(SCOPE, 'steering');
    expect(outcome).toEqual(
      expect.objectContaining({ status: 'generated', topicCount: 2, sampleSize: 120 }),
    );

    const mapInsert = ch.insert.mock.calls.at(-1)![0] as {
      values: Record<string, unknown>[];
    };
    expect(mapInsert.values).toHaveLength(2);
    const folded = mapInsert.values.find((v) => v['TopicId'] === 'v1-c0')!;
    expect(folded['Name']).toBe('Peer Permission Rule');
    expect(folded['MemberCount']).toBe(60);
    expect(l2Norm(folded['Centroid'] as number[])).toBeCloseTo(1, 6);
    expect(mapInsert.values.some((v) => v['TopicId'] === 'v1-c1')).toBe(false);

    // Every group-0 row — both halves — assigned to the folded topic.
    const facetInsert = ch.insert.mock.calls[0]![0] as {
      values: Record<string, unknown>[];
    };
    const byId = new Map(
      facetInsert.values.map((v) => [`${v['TraceId']}:${v['ItemIndex']}`, v]),
    );
    expect(byId.get('g0-t0:0')!['TopicId']).toBe('v1-c0');
    expect(byId.get('g0-t45:0')!['TopicId']).toBe('v1-c0');
    expect(byId.get('g1-t0:0')!['TopicId']).toBe('v1-c2');
  });

  test('a carried "Pattern:/fix by" description re-names on task but stands on issues', async () => {
    // Written when one issues-flavored namer served every facet, that shape
    // is remediation advice on a work cluster — and reconciliation carries
    // it forever unless it is treated as degraded. For issues the framing is
    // the intended one and must NOT churn.
    const adviceDescription =
      'Pattern: PR readiness and merge governance; fix by thorough reviews and CI validation.';
    const run = async (facet: 'task' | 'issues') => {
      const rows = sampleRows();
      const ch = fakeClickHouse([
        rows,
        [
          {
            TopicId: 'v1-c0',
            Name: 'Legacy Refund Topic',
            Description: adviceDescription,
            Centroid: groupVector(0, 2),
            MapVersion: 3,
          },
        ],
        [],
      ]);
      const fetchFn = clusteringFetch([
        { id: 'cluster-0', memberIds: rows.slice(0, 60).map(unitId) },
        { id: 'cluster-1', memberIds: rows.slice(60).map(unitId) },
      ]);
      const outcome = await makeService(ch, fetchFn).generateTopics(SCOPE, facet);
      expect(outcome.status).toBe('generated');
      const mapInsert = ch.insert.mock.calls.at(-1)![0] as {
        values: Record<string, unknown>[];
      };
      return mapInsert.values.find((v) => v['TopicId'] === 'v1-c0')!;
    };

    const task = await run('task');
    expect(task['Name']).toBe('Delayed Order Refund'); // re-named from members
    expect(task['Description']).not.toBe(adviceDescription);

    const issues = await run('issues');
    expect(issues['Name']).toBe('Legacy Refund Topic'); // carried untouched
    expect(issues['Description']).toBe(adviceDescription);
  });

  test('the namer receives the FACET\'s guidance — task naming never sees the failure framing', async () => {
    const rows = sampleRows();
    const ch = fakeClickHouse([rows, [], []]);
    const fetchFn = clusteringFetch([
      { id: 'cluster-0', memberIds: rows.slice(0, 60).map(unitId) },
      { id: 'cluster-1', memberIds: rows.slice(60).map(unitId) },
    ]);
    const mock = new MockTopicsModelClient();
    const spy = vi.spyOn(mock, 'generateObject');
    const service = new TopicsService({
      client: ch.client,
      clusteringUrl: 'http://clustering.test:8080',
      models: () => ({
        structured: mock,
        embedding: mock,
        mode: 'mock',
        models: {
          provider: 'mock',
          facetModel: 'gemini-2.5-flash-lite',
          embeddingModel: 'gemini-embedding-001',
          namingModel: 'gemini-2.5-flash-lite',
          embeddingDimension: 1024,
        },
      }),
      fetchFn: fetchFn as unknown as typeof fetch,
    });

    await service.generateTopics(SCOPE, 'task');

    const namingCalls = spy.mock.calls.filter(([req]) =>
      JSON.stringify(req.responseSchema).includes('"topics"'),
    );
    expect(namingCalls.length).toBeGreaterThan(0);
    for (const [req] of namingCalls) {
      expect(req.systemPrompt).toContain('It is a label for work, not a diagnosis');
      expect(req.systemPrompt).not.toContain('recurring failure worth a');
    }
  });

  test('a large sample re-inserts in bounded batches, map row last', async () => {
    const rows: ReturnType<typeof facetRow>[] = [];
    for (let i = 0; i < 150; i++) rows.push(facetRow(0, i));
    for (let i = 0; i < 150; i++) rows.push(facetRow(1, i));
    const ch = fakeClickHouse([rows, [], []]);
    const fetchFn = clusteringFetch([
      { id: 'cluster-0', memberIds: rows.slice(0, 150).map(unitId) },
      { id: 'cluster-1', memberIds: rows.slice(150).map(unitId) },
    ]);

    const outcome = await makeService(ch, fetchFn).generateTopics(SCOPE, 'task');

    expect(outcome.status).toBe('generated');
    const inserts = ch.insert.mock.calls.map(
      (call) => call[0] as { table: string; values: unknown[] },
    );
    // 300 rows → two bounded facet batches (each row carries its embedding,
    // so one giant insert can exceed ClickHouse's memory limit), then the map.
    expect(inserts.map((i) => i.table)).toEqual([
      'trace_facets',
      'trace_facets',
      'trace_topic_maps',
    ]);
    expect(inserts[0]!.values).toHaveLength(250);
    expect(inserts[1]!.values).toHaveLength(50);
  });

  test('a failed assignment write aborts BEFORE the map row — no orphaned zero-count version', async () => {
    const rows = sampleRows();
    const ch = fakeClickHouse([rows, [], []]);
    ch.insert.mockRejectedValueOnce(new Error('memory limit exceeded'));
    const fetchFn = clusteringFetch([
      { id: 'cluster-0', memberIds: rows.slice(0, 60).map(unitId) },
      { id: 'cluster-1', memberIds: rows.slice(60).map(unitId) },
    ]);

    await expect(
      makeService(ch, fetchFn).generateTopics(SCOPE, 'task'),
    ).rejects.toThrow('memory limit exceeded');
    // The map row is the activation write: it must never land when the
    // assignments didn't — the previous version keeps serving.
    const tables = ch.insert.mock.calls.map((call) => (call[0] as { table: string }).table);
    expect(tables).toEqual(['trace_facets']);
  });

  test('a cold clustering service (transient 5xx) is retried and generation proceeds', async () => {
    const rows = sampleRows();
    const refundIds = rows.slice(0, 60).map(unitId);
    const loginIds = rows.slice(60).map(unitId);
    const ch = fakeClickHouse([rows, [], []]);
    // First request lands while the scale-to-zero machine is resuming; the
    // retry reaches the healthy service.
    const good = clusteringFetch([
      { id: 'cluster-0', memberIds: refundIds },
      { id: 'cluster-1', memberIds: loginIds },
    ]);
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(new Response('resuming', { status: 503 }))
      .mockImplementation(good);

    vi.useFakeTimers();
    try {
      const pending = makeService(ch, fetchFn).generateTopics(SCOPE, 'task');
      await vi.runAllTimersAsync();
      const outcome = await pending;
      expect(outcome.status).toBe('generated');
      // 4 calls: the 503, its retry, then one giant-split probe per cluster
      // (both fixture clusters hold 50% of the sample). The probes return the
      // full two-group response, which intersects down to one sub-cluster
      // each — so neither giant splits and the map still has two topics.
      expect(fetchFn).toHaveBeenCalledTimes(4);
    } finally {
      vi.useRealTimers();
    }
  });

  test('persistent clustering-service failure surfaces status and body excerpt after one retry', async () => {
    const ch = fakeClickHouse([sampleRows(), []]);
    const fetchFn = vi
      .fn()
      .mockResolvedValue(new Response('boom', { status: 503 }));

    vi.useFakeTimers();
    try {
      const result = makeService(ch, fetchFn)
        .generateTopics(SCOPE, 'task')
        .then(() => null)
        .catch((e: unknown) => e);
      await vi.runAllTimersAsync();
      const error = await result;
      expect((error as Error).message).toBe(
        'Clustering service failed with HTTP 503: boom',
      );
      expect(fetchFn).toHaveBeenCalledTimes(2); // original + one retry, no loop
      expect(ch.insert).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  test('a 4xx from the clustering service is NOT retried (bad payload or secret)', async () => {
    const ch = fakeClickHouse([sampleRows(), []]);
    const fetchFn = vi
      .fn()
      .mockResolvedValue(new Response('bad secret', { status: 401 }));

    await expect(
      makeService(ch, fetchFn).generateTopics(SCOPE, 'task'),
    ).rejects.toThrow('Clustering service failed with HTTP 401: bad secret');
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });
});

/** The WHERE section of a query, whitespace-normalized, for predicate parity. */
function whereOf(sql: string): string {
  const from = sql.indexOf('WHERE');
  const end = sql.indexOf('ORDER BY');
  return sql
    .slice(from, end === -1 ? undefined : end)
    .replace(/\s+/g, ' ')
    .trim();
}

describe('listTopics', () => {
  test('the samplable counter runs generation\'s own predicate — dimension-exact, marker- and agent-free', async () => {
    const ch = fakeClickHouse([
      [], // no map rows
      [{ c: '7' }], // samplable count
    ]);
    await makeService(ch, clusteringFetch([])).listTopics(SCOPE, 'steering');
    // Any looser predicate counts rows generation refuses to sample: markers
    // and provider-switch leftovers (embedding length), subagent transcripts
    // and programmatic runs (the NOT IN) — the floor then promises maps
    // generation can't build.
    const countSql = (ch.query.mock.calls[1]![0] as { query: string }).query;
    expect(countSql).toContain('length(Embedding) = {dimension:UInt32}');
    expect(countSql).toContain("Status = 'ok'");
    expect(countSql).toContain('TraceId NOT IN');
    expect(countSql).toContain("(ParentSessionId != '' OR Origin = 'agent')");
  });

  test('the samplable counter and the generation sample compile from ONE predicate, per facet', async () => {
    // The count and the sample are separate queries; this pins their WHERE
    // sections to byte-parity so a predicate added to one side alone fails
    // here instead of shipping a counter that contradicts generation.
    for (const facet of ['steering', 'task', 'issues'] as const) {
      const listCh = fakeClickHouse([[], [{ c: '0' }]]);
      await makeService(listCh, clusteringFetch([])).listTopics(SCOPE, facet);
      const countSql = (listCh.query.mock.calls[1]![0] as { query: string }).query;

      const genCh = fakeClickHouse([[]]);
      await makeService(genCh, clusteringFetch([])).generateTopics(SCOPE, facet);
      const sampleSql = (genCh.query.mock.calls[0]![0] as { query: string }).query;

      expect(whereOf(countSql)).toBe(whereOf(sampleSql));
    }
  });

  test('the sample and the counter demand the facet\'s CURRENT extractor version — batched for task/issues, steering\'s own for steering', async () => {
    // A prompt-version bump re-drains history through the backfill sweeps;
    // until the drain completes the corpus holds summaries of BOTH prompt
    // generations. Sampling an older version rebuilds the map the new prompt
    // retired (clean-run narrations clustering as top "issues"), so both the
    // counter and the sample must pin the version — and per facet, because
    // steering versions independently of the batched call.
    const expected = [
      { facet: 'task', version: BATCHED_EXTRACTOR_VERSION },
      { facet: 'issues', version: BATCHED_EXTRACTOR_VERSION },
      { facet: 'steering', version: STEERING_EXTRACTOR_VERSION },
    ] as const;
    for (const { facet, version } of expected) {
      const listCh = fakeClickHouse([[], [{ c: '0' }]]);
      await makeService(listCh, clusteringFetch([])).listTopics(SCOPE, facet);
      const countCall = listCh.query.mock.calls[1]![0] as {
        query: string;
        query_params: Record<string, unknown>;
      };
      expect(countCall.query).toContain(
        'ExtractorVersion >= {minExtractorVersion:UInt32}',
      );
      expect(countCall.query_params['minExtractorVersion']).toBe(version);

      const genCh = fakeClickHouse([[]]);
      await makeService(genCh, clusteringFetch([])).generateTopics(SCOPE, facet);
      const sampleCall = genCh.query.mock.calls[0]![0] as {
        query: string;
        query_params: Record<string, unknown>;
      };
      expect(sampleCall.query_params['minExtractorVersion']).toBe(version);
    }
  });

  test('steering runs on its own floor: reported by listTopics and enforced by generation', async () => {
    // Steering's clusterable corpus is triple-filtered (full-tier capture,
    // interactive sessions, rule/preference kinds only), so the batched
    // facets' floor would freeze its map permanently. 30 rows must reach
    // clustering (no_clusters here — the mock returns all noise), while the
    // same 30 refuse under the batched floor of 100.
    const listCh = fakeClickHouse([[], [{ c: '7' }]]);
    const list = await makeService(listCh, clusteringFetch([])).listTopics(SCOPE, 'steering');
    expect(list.required).toBe(MIN_STEERING_SUMMARIES_FOR_GENERATION);
    expect(MIN_STEERING_SUMMARIES_FOR_GENERATION).toBe(25);

    const thirtyRows = Array.from({ length: 30 }, (_, i) => facetRow(0, i));
    const genCh = fakeClickHouse([thirtyRows]);
    const outcome = await makeService(genCh, clusteringFetch([])).generateTopics(SCOPE, 'steering');
    expect(outcome).toEqual({ status: 'no_clusters', facet: 'steering', sampleSize: 30 });

    const taskCh = fakeClickHouse([thirtyRows]);
    const taskOutcome = await makeService(taskCh, clusteringFetch([])).generateTopics(SCOPE, 'task');
    expect(taskOutcome).toEqual({
      status: 'not_enough_data',
      facet: 'task',
      sampleSize: 30,
      required: MIN_SUMMARIES_FOR_GENERATION,
    });
  });

  test('TOPICS_MIN_SUMMARIES overrides the floor for the list response and generation; garbage falls back', async () => {
    try {
      vi.stubEnv('TOPICS_MIN_SUMMARIES', '15');
      const ch = fakeClickHouse([
        [], // no map rows
        [{ c: '7' }], // samplable count
        Array.from({ length: 14 }, (_, i) => facetRow(0, i)), // generation sample
      ]);
      const service = makeService(ch, clusteringFetch([]));
      const list = await service.listTopics(SCOPE, 'task');
      expect(list.required).toBe(15);
      // 14 < 15: the overridden floor is what generation enforces and reports.
      expect(await service.generateTopics(SCOPE, 'task')).toEqual({
        status: 'not_enough_data',
        facet: 'task',
        sampleSize: 14,
        required: 15,
      });

      vi.stubEnv('TOPICS_MIN_SUMMARIES', '2'); // below the clamp → default
      const ch2 = fakeClickHouse([[], [{ c: '7' }]]); // map lookup + samplable count
      const list2 = await makeService(ch2, clusteringFetch([])).listTopics(SCOPE, 'task');
      expect(list2.required).toBe(100);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  test('no map yet: version 0 with the samplable count', async () => {
    const ch = fakeClickHouse([
      [], // no map rows
      [{ c: '7' }], // samplable count
    ]);
    const fetchFn = clusteringFetch([]);
    const list = await makeService(ch, fetchFn).listTopics(SCOPE, 'task');

    expect(list).toEqual({
      facet: 'task',
      mapVersion: 0,
      generatedAt: null,
      topics: [],
      noMatchCount: 0,
      samplableCount: 7,
      required: 100,
      trendDays: [],
      noMatchTrend: [],
      trendBucket: 'hour',
    });
  });

  test('active map: topics sorted by live count with share; no_match separated', async () => {
    const ch = fakeClickHouse([
      [
        // Outcome metrics come straight off the map row — snapshots written
        // at generation, no per-request otel_traces join.
        {
          TopicId: 'v1-c0',
          Name: 'Refund Requests',
          Description: 'Refund asks.',
          MapVersion: 2,
          GeneratedAt: '2026-07-01 12:00:00.000',
          ErrorRate: 0.1,
          AvgLatencyMs: 800,
          AvgCostUsd: 0.02,
        },
        {
          TopicId: 'v1-c1',
          Name: 'Login Problems',
          Description: 'Login failures.',
          MapVersion: 2,
          GeneratedAt: '2026-07-01 12:00:00.000',
          ErrorRate: 0.05,
          AvgLatencyMs: 600,
          AvgCostUsd: 0.01,
        },
      ],
      [
        { TopicId: 'v1-c0', c: '30' },
        { TopicId: 'v1-c1', c: '60' },
        { TopicId: NO_MATCH_TOPIC_ID, c: '10' },
      ],
      // Share denominator: distinct classified sessions. Deliberately LESS
      // than the per-topic sum (30+60+10) — one session's transcripts can sit
      // in several issues topics, so summing per-topic counts would overstate.
      [{ c: '80' }],
      [], // no trend rows → empty axis (nothing to anchor to)
      [{ c: '5' }], // samplable rows (generation's own predicate)
    ]);
    const fetchFn = clusteringFetch([]);
    const list = await makeService(ch, fetchFn).listTopics(SCOPE, 'task');

    expect(list.mapVersion).toBe(2);
    expect(list.generatedAt).toBe('2026-07-01 12:00:00.000');
    expect(list.topics).toEqual([
      {
        topicId: 'v1-c1',
        name: 'Login Problems',
        description: 'Login failures.',
        sessionCount: 60,
        share: 0.75,
        avgLatencyMs: 600,
        avgCostUsd: 0.01,
        errorRate: 0.05,
        trend: [],
      },
      {
        topicId: 'v1-c0',
        name: 'Refund Requests',
        description: 'Refund asks.',
        sessionCount: 30,
        share: 0.375,
        avgLatencyMs: 800,
        avgCostUsd: 0.02,
        errorRate: 0.1,
        trend: [],
      },
    ]);
    expect(list.noMatchCount).toBe(10);
    expect(list.samplableCount).toBe(5);
    // No trend rows → no data to anchor an axis to, so it's empty (the chart
    // hides rather than drawing 24 hours of phantom zeros).
    expect(list.trendDays).toEqual([]);
    expect(list.noMatchTrend).toEqual([]);
  });

  test('no otel_traces span scan: session-attributed counts + trend via the rollup, no now()-window', async () => {
    const ch = fakeClickHouse([
      [
        {
          TopicId: 'v1-c0',
          Name: 'Refunds',
          Description: '',
          MapVersion: 1,
          GeneratedAt: '2026-07-01 12:00:00.000',
          ErrorRate: 0,
          AvgLatencyMs: 0,
          AvgCostUsd: 0,
        },
      ],
      [{ TopicId: 'v1-c0', c: '12' }],
      [{ c: '12' }], // denominator
      [], // trend
      [{ c: '0' }], // unassigned
    ]);
    await makeService(ch, clusteringFetch([])).listTopics(SCOPE, 'task');

    // Exactly five reads: map, live counts, share denominator, trend,
    // samplable count — the per-request metrics join is gone.
    expect(ch.query).toHaveBeenCalledTimes(5);

    const queries = ch.query.mock.calls.map(
      (call) => call[0] as { query: string; query_params: Record<string, unknown> },
    );
    // No list query scans the otel_traces span table — session attribution
    // and start times come from the compact agent_session_summary rollup.
    expect(queries.filter((q) => q.query.includes('otel_traces'))).toHaveLength(0);

    // Counts: distinct ROOT sessions (a subagent transcript credits its
    // parent), task facet restricted to top-level transcripts.
    const counts = queries[1]!;
    expect(counts.query).toContain('uniqExact');
    expect(counts.query).toContain('LEFT JOIN');
    expect(counts.query).toContain("if(s.ParentSessionId != '', s.ParentSessionId,");
    expect(counts.query).toContain("AND s.ParentSessionId = ''");

    // Trend: each root session buckets ONCE per topic by its earliest
    // transcript start; data-anchored (no wall-clock window bounds the join).
    const trend = queries[3]!;
    expect(trend.query).toContain('toStartOfHour(t)');
    expect(trend.query).toContain('GROUP BY TraceId');
    expect(trend.query).toContain('GROUP BY f.TopicId, rootKey');
    expect(trend.query).not.toContain('now()');
    expect(trend.query_params).not.toHaveProperty('trendWindowHours');
  });

  test('issues facet keeps subagent transcripts — counts attribute them to the parent, no root-only filter', async () => {
    const ch = fakeClickHouse([
      [
        {
          TopicId: 'v1-c0',
          Name: 'Truncated output',
          Description: '',
          MapVersion: 1,
          GeneratedAt: '2026-07-01 12:00:00.000',
          ErrorRate: 0,
          AvgLatencyMs: 0,
          AvgCostUsd: 0,
        },
      ],
      [{ TopicId: 'v1-c0', c: '21' }],
      [{ c: '21' }],
      [],
      [{ c: '0' }],
    ]);
    const list = await makeService(ch, clusteringFetch([])).listTopics(SCOPE, 'issues');

    expect(list.topics[0]!.sessionCount).toBe(21);
    const queries = ch.query.mock.calls.map((call) => call[0] as { query: string });
    const counts = queries[1]!;
    const trend = queries[3]!;
    const samplable = queries[4]!;
    // Attribution key present, but NO top-level-only restriction: a failure
    // inside a subagent is the root session's failure.
    expect(counts.query).toContain("if(s.ParentSessionId != '', s.ParentSessionId,");
    expect(counts.query).not.toContain("AND s.ParentSessionId = ''");
    // Issues stays origin-blind everywhere — live counts, trend, AND the
    // samplable count — so every population matches the issues drill-down.
    for (const q of [counts.query, trend.query, samplable.query]) {
      expect(q).not.toContain("f.TraceId)) NOT IN (");
      expect(q).not.toContain("Origin = 'agent'");
    }
  });

  test('count + trend exclude agent-origin ROOT sessions, keyed on the root not the raw trace', async () => {
    const ch = fakeClickHouse([
      [
        {
          TopicId: 'v1-c0',
          Name: 'Refunds',
          Description: '',
          MapVersion: 1,
          GeneratedAt: '2026-07-01 12:00:00.000',
          ErrorRate: 0,
          AvgLatencyMs: 0,
          AvgCostUsd: 0,
        },
      ],
      [{ TopicId: 'v1-c0', c: '12' }],
      [{ c: '12' }],
      [],
      [{ c: '0' }],
    ]);
    await makeService(ch, clusteringFetch([])).listTopics(SCOPE, 'task');

    const queries = ch.query.mock.calls.map((call) => call[0] as { query: string });
    const counts = queries[1]!;
    const trend = queries[3]!;
    // The exclusion is a root-key NOT IN against the set of top-level agent
    // runs, so a subagent that rolls up to an interactive/worker root (its
    // parent SessionId is not in the set) stays counted. The set itself is
    // pinned to ParentSessionId='' … Origin='agent'.
    for (const q of [counts.query, trend.query]) {
      expect(q).toContain("f.TraceId)) NOT IN (");
      expect(q).toContain('SELECT SessionId FROM agent_session_summary FINAL');
      expect(q).toContain("Origin = 'agent'");
      // The predicate keys on the ROOT session, never on the current trace's
      // own Origin — a naive `s.Origin != 'agent'` would drop every subagent.
      expect(q).not.toContain('s.Origin');
    }
    // The samplable count carries generation's trace-grain exclusion of the
    // same population (subagent transcripts + programmatic runs).
    const samplable = (ch.query.mock.calls[4]![0] as { query: string }).query;
    expect(samplable).toContain('TraceId NOT IN');
    expect(samplable).toContain("(ParentSessionId != '' OR Origin = 'agent')");
  });

  test('topics-over-time: an hourly axis anchored to the data span, zero-filling the gap', async () => {
    const ch = fakeClickHouse([
      [
        {
          TopicId: 'v1-c0',
          Name: 'Refunds',
          Description: '',
          MapVersion: 1,
          GeneratedAt: '2026-07-01 12:00:00.000',
          ErrorRate: 0,
          AvgLatencyMs: 0,
          AvgCostUsd: 0,
        },
      ],
      [
        { TopicId: 'v1-c0', c: '5' },
        { TopicId: NO_MATCH_TOPIC_ID, c: '2' },
      ],
      [{ c: '7' }], // denominator
      [
        // Three hourly buckets spanning 10:00→12:00 — the 11:00 hour has no row
        // and must zero-fill; the axis spans exactly earliest→latest.
        { TopicId: 'v1-c0', bucket: '2026-07-06 12:00:00', c: '3' },
        { TopicId: 'v1-c0', bucket: '2026-07-06 10:00:00', c: '2' },
        { TopicId: NO_MATCH_TOPIC_ID, bucket: '2026-07-06 12:00:00', c: '1' },
      ],
      [{ c: '0' }], // unassigned
    ]);
    const list = await makeService(ch, clusteringFetch([])).listTopics(SCOPE, 'task');

    expect(list.trendBucket).toBe('hour');
    // Axis is the data's own span (10:00→12:00), oldest→newest — not 24 hours.
    expect(list.trendDays).toEqual([
      '2026-07-06 10:00:00',
      '2026-07-06 11:00:00',
      '2026-07-06 12:00:00',
    ]);
    const refunds = list.topics.find((t) => t.topicId === 'v1-c0')!;
    expect(refunds.trend).toEqual([2, 0, 3]); // 11:00 gap zero-filled
    expect(list.noMatchTrend).toEqual([0, 0, 1]);
  });

  test('topics-over-time: a multi-week backfill downsamples to daily buckets, folding hourly rows', async () => {
    const ch = fakeClickHouse([
      [
        {
          TopicId: 'v1-c0',
          Name: 'Refunds',
          Description: '',
          MapVersion: 1,
          GeneratedAt: '2026-06-23 12:00:00.000',
          ErrorRate: 0,
          AvgLatencyMs: 0,
          AvgCostUsd: 0,
        },
      ],
      [{ TopicId: 'v1-c0', c: '9' }],
      [{ c: '9' }], // denominator
      [
        // Span Jun 12 09:00 → Jun 14 12:00 (51h > 48h) → daily buckets. Two
        // rows on Jun 12 must fold into that day's single bucket (3 + 4 = 7).
        { TopicId: 'v1-c0', bucket: '2026-06-12 09:00:00', c: '3' },
        { TopicId: 'v1-c0', bucket: '2026-06-12 15:00:00', c: '4' },
        { TopicId: 'v1-c0', bucket: '2026-06-14 12:00:00', c: '2' },
      ],
      [{ c: '0' }], // unassigned
    ]);
    const list = await makeService(ch, clusteringFetch([])).listTopics(SCOPE, 'task');

    expect(list.trendBucket).toBe('day');
    expect(list.trendDays).toEqual([
      '2026-06-12 00:00:00',
      '2026-06-13 00:00:00',
      '2026-06-14 00:00:00',
    ]);
    const refunds = list.topics.find((t) => t.topicId === 'v1-c0')!;
    expect(refunds.trend).toEqual([7, 0, 2]); // Jun 12 folded, Jun 13 zero-filled
  });
});

describe('naming exemplars', () => {
  test('the namer sees the members NEAREST the centroid, not the first in sample order', async () => {
    // One mixed cluster: 8 login rows listed FIRST in memberIds, 60 refund
    // rows behind them. The centroid is refund-dominant, so a namer fed the
    // cluster's CORE names it after refunds; a namer fed the first-N members
    // names the stragglers — the failure mode that shipped a 46%-share junk
    // drawer under a confident, wrong name.
    const rows = sampleRows();
    const refundIds = rows.slice(0, 60).map(unitId);
    const loginIds = rows.slice(60).map(unitId);
    const mixedCluster = [...loginIds.slice(0, 8), ...refundIds];
    const restCluster = loginIds.slice(8);

    const ch = fakeClickHouse([rows, [], []]);
    const fetchFn = clusteringFetch([
      { id: 'cluster-0', memberIds: mixedCluster },
      { id: 'cluster-1', memberIds: restCluster },
    ]);

    const outcome = await makeService(ch, fetchFn).generateTopics(SCOPE, 'task');
    expect(outcome.status).toBe('generated');

    const mapInsert = ch.insert.mock.calls.at(-1)![0] as {
      values: Record<string, unknown>[];
    };
    const mixed = mapInsert.values.find((v) => v['MemberCount'] === 68)!;
    expect(mixed['Name']).toBe('Delayed Order Refund');
  });
});

describe('giant-cluster split', () => {
  test('a junk-drawer giant splits into its dense cores plus a residual, each named fresh', async () => {
    const rows = sampleRows();
    const allIds = rows.map(unitId);
    const refundIds = rows.slice(0, 60).map(unitId);
    const loginIds = rows.slice(60, 110).map(unitId);
    // 10 rows in neither dense core — the residual.
    const ch = fakeClickHouse([rows, [], []]);
    const fetchFn = vi
      .fn()
      // Main pass: one cluster holding 100% of the sample — a suspected grab-bag.
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ clusters: [{ id: 'giant', memberIds: allIds }], noise: [], generationMs: 1 }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      )
      // Split probe: two dense cores emerge.
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            clusters: [
              { id: 's0', memberIds: refundIds },
              { id: 's1', memberIds: loginIds },
            ],
            noise: [],
            generationMs: 1,
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      );

    const outcome = await makeService(ch, fetchFn).generateTopics(SCOPE, 'task');
    expect(outcome.status).toBe('generated');
    expect(outcome.status === 'generated' && outcome.topicCount).toBe(3);

    // The probe must send exactly the giant's members — nothing else.
    const probeBody = JSON.parse((fetchFn.mock.calls[1] as [string, { body: string }])[1].body) as {
      embeddings: { id: string }[];
    };
    expect(probeBody.embeddings.map((e) => e.id)).toEqual(allIds);

    // Map rows: three topics covering all 120 members exactly once, every
    // one named (fresh clusters all go to the namer).
    const mapInsert = ch.insert.mock.calls
      .map((call) => call[0] as { table: string; values: { TopicId: string; Name: string; MemberCount: number }[] })
      .find((call) => call.table === 'trace_topic_maps')!;
    expect(mapInsert.values.map((v) => v.MemberCount).sort((a, b) => b - a)).toEqual([60, 50, 10]);
    expect(new Set(mapInsert.values.map((v) => v.TopicId)).size).toBe(3);
    expect(mapInsert.values.every((v) => v.Name.length > 0)).toBe(true);
  });

  test('a coherent giant (no internal density) stays whole', async () => {
    const rows = sampleRows();
    const allIds = rows.map(unitId);
    const ch = fakeClickHouse([rows, [], []]);
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ clusters: [{ id: 'giant', memberIds: allIds }], noise: [], generationMs: 1 }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      )
      // Probe finds nothing dense — everything is noise inside the giant.
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ clusters: [], noise: allIds, generationMs: 1 }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );

    const outcome = await makeService(ch, fetchFn).generateTopics(SCOPE, 'task');
    expect(outcome.status).toBe('generated');
    expect(outcome.status === 'generated' && outcome.topicCount).toBe(1);
    const mapInsert = ch.insert.mock.calls
      .map((call) => call[0] as { table: string; values: { MemberCount: number }[] })
      .find((call) => call.table === 'trace_topic_maps')!;
    expect(mapInsert.values.map((v) => v.MemberCount)).toEqual([120]);
  });
});

describe('giant-cluster split boundaries', () => {
  const jsonResponse = (body: unknown) =>
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });

  test('only clusters over the 30% share are probed — the small cluster rides through untouched', async () => {
    const rows = sampleRows(); // 120
    const smallIds = rows.slice(0, 30).map(unitId); // 25% — under the share
    const giantIds = rows.slice(30).map(unitId); // 75% — over it
    const ch = fakeClickHouse([rows, [], []]);
    const fetchFn = vi
      .fn()
      // Small cluster FIRST: if the share guard mutates away, the first probe
      // targets the small cluster and the probe-body assertion below fails.
      .mockResolvedValueOnce(
        jsonResponse({
          clusters: [
            { id: 'small', memberIds: smallIds },
            { id: 'giant', memberIds: giantIds },
          ],
          noise: [],
          generationMs: 1,
        }),
      )
      // Probe of the giant finds no structure — it stays whole.
      .mockResolvedValueOnce(jsonResponse({ clusters: [], noise: giantIds, generationMs: 1 }));

    const outcome = await makeService(ch, fetchFn).generateTopics(SCOPE, 'task');
    expect(outcome.status).toBe('generated');
    expect(outcome.status === 'generated' && outcome.topicCount).toBe(2);
    // Exactly ONE probe, and it carries exactly the giant's members.
    expect(fetchFn).toHaveBeenCalledTimes(2);
    const probeBody = JSON.parse((fetchFn.mock.calls[1] as [string, { body: string }])[1].body) as {
      embeddings: { id: string }[];
    };
    expect(probeBody.embeddings.map((e) => e.id)).toEqual(giantIds);
  });

  test('foreign ids in the probe response are discarded, and a foreign-only sub-cluster cannot force a split', async () => {
    const rows = sampleRows();
    const giantIds = rows.slice(0, 100).map(unitId);
    const outsideIds = rows.slice(100).map(unitId); // valid units, NOT in the giant
    const ch = fakeClickHouse([rows, [], []]);
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({
          clusters: [
            { id: 'giant', memberIds: giantIds },
            { id: 'other', memberIds: outsideIds },
          ],
          noise: [],
          generationMs: 1,
        }),
      )
      // Probe claims two cores, but one is entirely foreign ids: after the
      // intersection it filters to nothing, leaving one core — no split.
      .mockResolvedValueOnce(
        jsonResponse({
          clusters: [
            { id: 's0', memberIds: giantIds },
            { id: 's1', memberIds: outsideIds },
          ],
          noise: [],
          generationMs: 1,
        }),
      );

    const outcome = await makeService(ch, fetchFn).generateTopics(SCOPE, 'task');
    expect(outcome.status).toBe('generated');
    // Giant kept whole + the small legitimate cluster: 2 topics, and the
    // outside ids were never double-assigned into a phantom third topic.
    expect(outcome.status === 'generated' && outcome.topicCount).toBe(2);
    const mapInsert = ch.insert.mock.calls
      .map((call) => call[0] as { table: string; values: { MemberCount: number }[] })
      .find((call) => call.table === 'trace_topic_maps')!;
    expect(mapInsert.values.map((v) => v.MemberCount).sort((a, b) => b - a)).toEqual([100, 20]);
  });

  test('an exact-cover split leaves NO empty residual cluster behind', async () => {
    const rows = sampleRows();
    const allIds = rows.map(unitId);
    const coreA = rows.slice(0, 60).map(unitId);
    const coreB = rows.slice(60).map(unitId); // covers everything — residual empty
    const ch = fakeClickHouse([rows, [], []]);
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({ clusters: [{ id: 'giant', memberIds: allIds }], noise: [], generationMs: 1 }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          clusters: [
            { id: 's0', memberIds: coreA },
            { id: 's1', memberIds: coreB },
          ],
          noise: [],
          generationMs: 1,
        }),
      );

    const outcome = await makeService(ch, fetchFn).generateTopics(SCOPE, 'task');
    expect(outcome.status).toBe('generated');
    expect(outcome.status === 'generated' && outcome.topicCount).toBe(2);
    const mapInsert = ch.insert.mock.calls
      .map((call) => call[0] as { table: string; values: { MemberCount: number }[] })
      .find((call) => call.table === 'trace_topic_maps')!;
    expect(mapInsert.values.map((v) => v.MemberCount).sort((a, b) => b - a)).toEqual([60, 60]);
  });
});

describe('mirror honesty: top-cluster probe + diffuse labeling', () => {
  const jsonOk = (body: unknown) =>
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });

  /** Unit vector on the given axis with deterministic jitter. */
  function axisRow(axis: number, index: number) {
    const v = new Array<number>(8).fill(0);
    v[axis] = 1;
    v[7] = ((index % 5) + 1) * 0.001;
    const norm = Math.hypot(...v);
    return {
      ...facetRow(0, index),
      TraceId: `ax${axis}-t${index}`,
      Embedding: v.map((x) => x / norm),
    };
  }

  test('the LARGEST cluster is probed even under the 30% share threshold', async () => {
    const rows = sampleRows(); // 120
    const largestIds = rows.slice(0, 34).map(unitId); // 28% — under share, largest
    const midIds = rows.slice(34, 64).map(unitId); // 25%
    const restIds = rows.slice(64, 92).map(unitId); // 23%
    const noiseIds = rows.slice(92).map(unitId);
    const ch = fakeClickHouse([rows, [], []]);
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(
        jsonOk({
          clusters: [
            { id: 'mid', memberIds: midIds },
            { id: 'largest', memberIds: largestIds },
            { id: 'rest', memberIds: restIds },
          ],
          noise: noiseIds,
          generationMs: 1,
        }),
      )
      // The single probe (of the largest) finds no structure — kept whole.
      .mockResolvedValueOnce(jsonOk({ clusters: [], noise: largestIds, generationMs: 1 }));

    const outcome = await makeService(ch, fetchFn).generateTopics(SCOPE, 'task');
    expect(outcome.status).toBe('generated');
    expect(outcome.status === 'generated' && outcome.topicCount).toBe(3);
    // Exactly one probe, and it targets the largest cluster — not the mid
    // one and not the rest — even though nobody crossed the share threshold.
    expect(fetchFn).toHaveBeenCalledTimes(2);
    const probeBody = JSON.parse((fetchFn.mock.calls[1] as [string, { body: string }])[1].body) as {
      embeddings: { id: string }[];
    };
    expect(probeBody.embeddings.map((e) => e.id)).toEqual(largestIds);
  });

  test('a diffuse cluster takes the fixed honest label — over the namer AND over a carried name', async () => {
    // 25 members spread across four orthogonal axes: mean member-to-centroid
    // distance ≈ 0.5, past the 0.45 diffuseness cutoff. The 75 tight members
    // sit on one axis (distance ≈ 0).
    const spread = [
      ...Array.from({ length: 6 }, (_, i) => axisRow(0, i)),
      ...Array.from({ length: 6 }, (_, i) => axisRow(1, i)),
      ...Array.from({ length: 6 }, (_, i) => axisRow(2, i)),
      ...Array.from({ length: 7 }, (_, i) => axisRow(3, i)),
    ];
    const tight = Array.from({ length: 75 }, (_, i) => ({
      ...facetRow(1, i),
      TraceId: `tight-t${i}`,
    }));
    const rows = [...spread, ...tight];
    const spreadIds = spread.map(unitId);
    const tightIds = tight.map(unitId);
    // Previous map: a specific-sounding carried name sitting exactly on the
    // spread cluster's centroid with a within-3x member count — the carry
    // path that kept "Citation Verification Quality" alive for six regens.
    const spreadCentroid = (() => {
      const acc = new Array<number>(8).fill(0);
      for (const row of spread) row.Embedding.forEach((x, i) => (acc[i]! += x));
      const norm = Math.hypot(...acc);
      return acc.map((x) => x / norm);
    })();
    const ch = fakeClickHouse([
      rows,
      [
        {
          TopicId: 'v1-c9',
          Name: 'Citation Verification Quality',
          Description: 'Sources located and verified.',
          Centroid: spreadCentroid,
          MapVersion: 1,
          MemberCount: 20,
        },
      ],
      [],
    ]);
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(
        jsonOk({
          clusters: [
            { id: 'spread', memberIds: spreadIds },
            { id: 'tight', memberIds: tightIds },
          ],
          noise: [],
          generationMs: 1,
        }),
      )
      // Probe of the tight cluster (75% share AND largest): no structure.
      .mockResolvedValueOnce(jsonOk({ clusters: [], noise: tightIds, generationMs: 1 }));

    const outcome = await makeService(ch, fetchFn).generateTopics(SCOPE, 'task');
    expect(outcome.status).toBe('generated');

    const mapInsert = ch.insert.mock.calls
      .map((call) => call[0] as { table: string; values: { Name: string; Description: string; MemberCount: number; Params: string }[] })
      .find((call) => call.table === 'trace_topic_maps')!;
    const byCount = new Map(mapInsert.values.map((v) => [v.MemberCount, v]));
    // The diffuse residual wears the honest label — the carried specific
    // name is overridden, and the namer never saw it.
    expect(byCount.get(25)!.Name).toBe(MIXED_TOPIC_NAME);
    expect(byCount.get(25)!.Description).toBe(MIXED_TOPIC_DESCRIPTION);
    // The tight cluster still gets a real (mock-named) topic name.
    expect(byCount.get(75)!.Name).not.toBe(MIXED_TOPIC_NAME);
    expect(byCount.get(75)!.Name.length).toBeGreaterThan(0);
    // Diagnosable after the fact.
    expect(JSON.parse(byCount.get(25)!.Params)).toMatchObject({ diffuseTopicCount: 1 });
  });
});
