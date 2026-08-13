/**
 * Topic clustering, end to end on the real ClickHouse read/write path.
 *
 * `TopicsService.generateTopics` is proven with fully mocked geometry in
 * `apps/tenant-dashboard/src/features/topics/service.test.ts` — a fake
 * ClickHouse client and a stubbed clustering fetch. This is the single
 * anchor that keeps those fakes honest: the SAME service class, the SAME
 * mock model client and clustering stub shape, run against a real
 * ClickHouse container — proving the query/insert wiring the unit suite
 * never touches (row-level types, ReplacingMergeTree upsert semantics,
 * FINAL reads) actually round-trips a named topic map back to storage.
 */

import { describe, it, afterAll, expect, vi } from 'vitest';
import { createClient, type ClickHouseClient } from '@clickhouse/client';
import { randomBytes } from 'node:crypto';
import { BATCHED_EXTRACTOR_VERSION, MockTopicsModelClient, NO_MATCH_TOPIC_ID } from '@repo/trace-topics';
import { TopicsService } from 'tenant-dashboard/src/features/topics/service';
import { CLICKHOUSE_TEST_HOST } from '../../../clickhouse/setup-clickhouse';

const RUN = randomBytes(4).toString('hex');
const SCOPE = { tenantId: `gen-tenant-${RUN}`, appId: `gen-app-${RUN}`, environment: 'production', environmentIsDefault: false };

/** Unit basis vectors with a deterministic wobble — two clean groups in 8-D,
 * the same shape service.test.ts's fake-ClickHouse suite clusters. */
function groupVector(group: 0 | 1, index: number): number[] {
  const v = new Array<number>(8).fill(0);
  v[group] = 1;
  v[7] = ((index % 5) + 1) * 0.001;
  const norm = Math.hypot(...v);
  return v.map((x) => x / norm);
}

function facetRow(group: 0 | 1, index: number) {
  const traceId = `g${group}-${RUN}-t${index}`;
  return {
    TenantId: SCOPE.tenantId,
    AppId: SCOPE.appId,
    Environment: SCOPE.environment,
    TraceId: traceId,
    Facet: 'task',
    ItemIndex: 0,
    ExtractorVersion: BATCHED_EXTRACTOR_VERSION,
    Summary:
      group === 0
        ? `Customer wanted a refund for a delayed shipment order ${index}.`
        : `Customer could not login after a password reset attempt ${index}.`,
    Label: '',
    Embedding: groupVector(group, index),
    EmbeddingModel: 'mock-feature-hash-001',
    TopicId: '',
    TopicDistance: 0,
    MapVersion: 0,
    Status: 'ok',
    Error: '',
    CreatedAt: new Date().toISOString().replace('T', ' ').replace('Z', ''),
  };
}

/** 60 refund + 60 login rows — clears the 100-summary floor with two clean
 * clusters, same population service.test.ts's `sampleRows()` builds. */
function sampleRows(): ReturnType<typeof facetRow>[] {
  const rows: ReturnType<typeof facetRow>[] = [];
  for (let i = 0; i < 60; i++) rows.push(facetRow(0, i));
  for (let i = 0; i < 60; i++) rows.push(facetRow(1, i));
  return rows;
}

const unitId = (r: { TraceId: string; ItemIndex: number }) => `${r.TraceId}:${r.ItemIndex}`;

/** Stubbed clustering fetch — same request/response shape TopicsService's
 * real `callClusteringService` posts and parses; only the network hop is
 * faked, matching how service.test.ts stubs the same seam. */
function stubbedClusteringFetch(rows: ReturnType<typeof facetRow>[]) {
  const refundIds = rows.slice(0, 60).map(unitId);
  const loginIds = rows.slice(60, 120).map(unitId);
  return vi.fn().mockResolvedValue(
    new Response(
      JSON.stringify({
        clusters: [
          { id: 'cluster-0', name: 'cluster-0', description: '', memberIds: refundIds },
          { id: 'cluster-1', name: 'cluster-1', description: '', memberIds: loginIds },
        ],
        noise: [],
        generationMs: 42.5,
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    ),
  );
}

describe('topic clustering writes a named map back to real ClickHouse', () => {
  const client: ClickHouseClient = createClient({ url: CLICKHOUSE_TEST_HOST, database: 'default' });

  afterAll(async () => {
    await client.command({
      query: `ALTER TABLE trace_facets DELETE WHERE TenantId = {tenantId:String}`,
      query_params: { tenantId: SCOPE.tenantId },
    });
    await client.command({
      query: `ALTER TABLE trace_topic_maps DELETE WHERE TenantId = {tenantId:String}`,
      query_params: { tenantId: SCOPE.tenantId },
    });
    await client.close();
  });

  // proves AC-056-04
  it('generates named topics from >=100 seeded summaries and writes them back — map row and member facet rows both readable from ClickHouse', async () => {
    const rows = sampleRows();
    await client.insert({ table: 'trace_facets', values: rows, format: 'JSONEachRow' });

    const mock = new MockTopicsModelClient();
    const fetchFn = stubbedClusteringFetch(rows);
    const service = new TopicsService({
      client,
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
          embeddingDimension: 8,
        },
      }),
      fetchFn: fetchFn as unknown as typeof fetch,
    });

    const outcome = await service.generateTopics(SCOPE, 'task');
    expect(outcome.status).toBe('generated');
    if (outcome.status !== 'generated') throw new Error('not generated');
    expect(outcome.topicCount).toBe(2);
    expect(outcome.mapVersion).toBe(1);

    // Read the map back from ClickHouse directly — not the in-memory return
    // value — the anchor this test exists for.
    const mapRows = await client
      .query({
        query: `SELECT TopicId, Name, MemberCount FROM trace_topic_maps FINAL
                 WHERE TenantId = {tenantId:String} AND AppId = {appId:String}
                   AND Facet = 'task' AND MapVersion = 1
                 ORDER BY TopicId`,
        query_params: { tenantId: SCOPE.tenantId, appId: SCOPE.appId },
        format: 'JSONEachRow',
      })
      .then((r) => r.json<{ TopicId: string; Name: string; MemberCount: number }>());

    expect(mapRows).toHaveLength(2);
    // Exact names from the deterministic keyword namer over each cluster's OWN
    // summaries — a shape check alone would pass a raw cluster id or a name
    // written onto the wrong topic row.
    expect(mapRows.map((r) => r.Name).sort()).toEqual([
      'Attempt Login Password',
      'Delayed Order Refund',
    ]);
    const memberCounts = mapRows.map((r) => Number(r.MemberCount)).sort((a, b) => a - b);
    expect(memberCounts).toEqual([60, 60]);

    // Member facet rows carry the new TopicId/MapVersion; the raw refund
    // trace this run seeded first must show up reassigned.
    const memberRows = await client
      .query({
        query: `SELECT TraceId, TopicId, MapVersion, TopicDistance FROM trace_facets FINAL
                 WHERE TenantId = {tenantId:String} AND AppId = {appId:String} AND Facet = 'task'`,
        query_params: { tenantId: SCOPE.tenantId, appId: SCOPE.appId },
        format: 'JSONEachRow',
      })
      .then((r) => r.json<{ TraceId: string; TopicId: string; MapVersion: number; TopicDistance: number }>());

    expect(memberRows).toHaveLength(120);
    expect(memberRows.every((r) => r.MapVersion === 1)).toBe(true);
    expect(memberRows.every((r) => r.TopicId !== NO_MATCH_TOPIC_ID)).toBe(true);
    // Name→cluster ownership: the refund trace must sit in the refund-named
    // topic and the login trace in the login-named one — swapped names between
    // map rows would pass every count assertion above.
    const byTrace = new Map(memberRows.map((r) => [r.TraceId, r]));
    const refundTopic = mapRows.find((m) => m.Name === 'Delayed Order Refund')!;
    const loginTopic = mapRows.find((m) => m.Name === 'Attempt Login Password')!;
    expect(byTrace.get(rows[0]!.TraceId)!.TopicId).toBe(refundTopic.TopicId);
    expect(byTrace.get(rows.at(-1)!.TraceId)!.TopicId).toBe(loginTopic.TopicId);
  });
});
