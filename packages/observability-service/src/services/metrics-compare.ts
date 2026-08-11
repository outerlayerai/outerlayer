/**
 * Windowed topic-mix counts for `GET /v1/metrics/compare` (and the
 * `compare_windows` MCP tool) — the one genuinely new query this package
 * gained for the comparison endpoint. Everything else `/v1/metrics/compare`
 * needs (the per-window fleet tiles) is `AgentFleetService.getAgentFleetOverview`
 * called twice, once per window.
 *
 * Deliberately reads `trace_facets`, never `trace_topic_maps`' metric
 * columns (`AvgLatencyMs`/`AvgCostUsd`/`ErrorRate`): those are snapshots
 * written once at generation time, so diffing them across two windows would
 * compare two arbitrary moments, not the windows the caller asked about.
 * `trace_facets.CreatedAt` (the row's own timestamp) is what makes the
 * comparison actually windowed.
 */

import type { TopicFacet } from '@repo/api-schemas';
import type { IClickHouseQuery } from '../client';
import { QUERY_TIMEOUT_SETTINGS } from '../shared';
import { facetsEnvClause } from './topics';
import type { TopicsScope } from './topics';

/** Same caps as the other lifted read services (topics.ts, agent-sessions.ts)
 * — see `scripts/ci/check-clickhouse-client-guardrails.mjs`, which asserts
 * every `query(` call site in this file sets both. */
export const COMPARE_QUERY_SETTINGS = {
  ...QUERY_TIMEOUT_SETTINGS,
  max_memory_usage: 1_000_000_000,
  max_rows_to_read: 10_000_000,
} as const;

/** A UTC calendar-date window (`toDate(CreatedAt)` inclusive on both ends —
 * matches `/v1/metrics/models`' `from`/`to` semantics). */
export interface CompareWindow {
  from: string;
  to: string;
}

export interface TopicMixDeltaRow {
  topicId: string;
  name: string;
  countA: number;
  countB: number;
}

async function runQuery<T>(
  client: IClickHouseQuery,
  sql: string,
  params: Record<string, unknown>,
): Promise<T[]> {
  const result = await client.query({
    query: sql,
    query_params: params,
    format: 'JSONEachRow',
    clickhouse_settings: COMPARE_QUERY_SETTINGS,
  });
  return result.json<T>();
}

function scopeParams(scope: TopicsScope, facet: TopicFacet): Record<string, string> {
  return { tenantId: scope.tenantId, appId: scope.appId, environment: scope.environment, facet };
}

/** `MapVersion = max(MapVersion)` for the scope's active map — the same
 * "active map" definition `/v1/topics` uses, so a caller comparing windows
 * sees the CURRENT topic set, not a version that has since been superseded. */
const ACTIVE_MAP_VERSION_SUBQUERY = `(
      SELECT max(MapVersion)
      FROM trace_topic_maps FINAL
      WHERE TenantId = {tenantId:String}
        AND AppId = {appId:String}
        AND Environment = {environment:String}
        AND Facet = {facet:String}
        AND IsDeleted = 0
    )`;

/**
 * Per-topic facet-row counts (raw, not root-session-deduplicated — see the
 * module header) in each of two explicit windows, for the app's active topic
 * map on one facet. Topics with zero rows in BOTH windows are omitted.
 *
 * Three bounded queries: the active map's (topicId, name) pairs, then one
 * grouped count per window. A single query joining both windows via `sumIf`
 * would halve the round trips, but at the cost of one more FINAL-table join
 * complexity for a read that already runs three cheap, independently
 * bounded queries — not worth it for an endpoint with no latency SLA.
 */
export async function getTopicMixDeltas(
  client: IClickHouseQuery,
  scope: TopicsScope,
  facet: TopicFacet,
  windowA: CompareWindow,
  windowB: CompareWindow,
  limit: number,
): Promise<TopicMixDeltaRow[]> {
  const mapRows = await runQuery<{ TopicId: string; Name: string }>(
    client,
    `
    SELECT TopicId, Name
    FROM trace_topic_maps FINAL
    WHERE TenantId = {tenantId:String}
      AND AppId = {appId:String}
      AND Environment = {environment:String}
      AND Facet = {facet:String}
      AND IsDeleted = 0
      AND MapVersion = ${ACTIVE_MAP_VERSION_SUBQUERY}
    `,
    scopeParams(scope, facet),
  );
  if (mapRows.length === 0) return [];

  const countsForWindow = (window: CompareWindow) =>
    runQuery<{ TopicId: string; c: string }>(
      client,
      `
      SELECT TopicId, toString(count()) AS c
      FROM trace_facets FINAL
      WHERE TenantId = {tenantId:String}
        AND AppId = {appId:String}
        AND ${facetsEnvClause(scope)}
        AND Facet = {facet:String}
        AND IsDeleted = 0
        AND MapVersion = ${ACTIVE_MAP_VERSION_SUBQUERY}
        AND toDate(CreatedAt) >= {start:Date}
        AND toDate(CreatedAt) <= {end:Date}
      GROUP BY TopicId
      `,
      { ...scopeParams(scope, facet), start: window.from, end: window.to },
    );

  const [countsA, countsB] = await Promise.all([
    countsForWindow(windowA),
    countsForWindow(windowB),
  ]);
  const aByTopic = new Map(countsA.map((r) => [r.TopicId, Number(r.c)]));
  const bByTopic = new Map(countsB.map((r) => [r.TopicId, Number(r.c)]));

  return mapRows
    .map((row) => ({
      topicId: row.TopicId,
      name: row.Name,
      countA: aByTopic.get(row.TopicId) ?? 0,
      countB: bByTopic.get(row.TopicId) ?? 0,
    }))
    .filter((row) => row.countA > 0 || row.countB > 0)
    .sort((a, b) => b.countA + b.countB - (a.countA + a.countB) || a.topicId.localeCompare(b.topicId))
    .slice(0, limit);
}
