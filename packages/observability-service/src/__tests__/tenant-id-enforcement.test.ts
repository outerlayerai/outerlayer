/**
 * TenantId Enforcement Guard
 *
 * The ClickHouse analogue of the API-tenancy ratchet: every read that touches a
 * tenant-carrying table MUST carry a TenantId predicate. This is defense line 2
 * — the boundary that still binds where CLICKHOUSE_READ_USER is unset and the
 * migration-29 row policies are inert. A query that omits it fails CI here
 * instead of leaking cross-tenant at runtime.
 *
 * Coverage: the static query constants, every SQL-emitting builder in
 * `queries.ts` and `queries-agent-fleet.ts` (invoked so a predicate composed
 * from `scopeWhere`/`baseWhere` at runtime is proven, not just the literal
 * template), and the inline SQL in `services/*.ts` (source-scanned).
 *
 * If this fails, a query was added or changed without tenant scoping. Fix by
 * adding `AND TenantId = {tenantId:String}` to its WHERE clause.
 */

import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import * as queries from '../queries';
import * as fleetQueries from '../queries-agent-fleet';

// ---------------------------------------------------------------------------
// Tenant tables + predicate matcher
// ---------------------------------------------------------------------------

// Every table whose rows carry a TenantId (the migration-29 policy set).
// Longer names first so the alternation matches `otel_traces_trace_id_ts`
// before the `otel_traces` prefix.
const TENANT_TABLES = [
  'otel_traces_trace_id_ts',
  'otel_traces',
  'scores',
  'agent_session_summary',
  'agent_blobs',
  'trace_facets',
  'trace_topic_maps',
] as const;

const TENANT_TABLE_PATTERN = new RegExp(
  `\\b(?:FROM|JOIN)\\s+(?:${TENANT_TABLES.join('|')})\\b`,
  'i',
);
// Require TenantId in PREDICATE position (`TenantId = …` / `TenantId IN …`),
// not merely as a projected/grouped column — a `SELECT TenantId FROM …` with no
// filter must not pass. Residual limit (present tense): this proves a tenant
// predicate is PRESENT in the query, not that it binds every tenant table a
// multi-table query joins; per-table binding is not cheaply expressible as a
// regex, so the row-policy client remains the by-construction backstop.
const TENANT_ID_PATTERN = /TenantId\s*(?:=|IN\b)/i;

// ---------------------------------------------------------------------------
// Queries exempt from TenantId enforcement (present-tense reason required)
// ---------------------------------------------------------------------------

const ALLOWLIST = new Set([
  // Health probe — `SELECT 1`, no table, no data access.
  'HEALTH_CHECK_QUERY',
  // Column/dimension maps — not query strings.
  'SORT_FIELD_MAP',
  // Delegates its WHERE entirely to `samplableRowsClause(scope, facet)`,
  // whose own template literal (scanned separately in this same file) opens
  // with a literal TenantId predicate — the interpolation just hides that
  // text from this source scan, not from ClickHouse.
  'topics.ts inline query #27',
]);

function assertTenantId(name: string, sql: string): void {
  if (ALLOWLIST.has(name)) return;
  if (!TENANT_TABLE_PATTERN.test(sql)) return; // doesn't query a tenant table

  expect(
    TENANT_ID_PATTERN.test(sql),
    `Query "${name}" references a tenant table but is missing a TenantId predicate.\n` +
      `Add: AND TenantId = {tenantId:String}\n` +
      `(or, if it is genuinely cross-tenant, add it to ALLOWLIST with a reason).`,
  ).toBe(true);
}

// ---------------------------------------------------------------------------
// Static query constants
// ---------------------------------------------------------------------------

describe('TenantId enforcement: static query constants', () => {
  const staticQueries = Object.entries(queries).filter(
    ([, value]) => typeof value === 'string' && value.length > 20,
  ) as [string, string][];

  it.each(staticQueries)(
    '%s carries a TenantId predicate when it queries a tenant table',
    (name, sql) => {
      assertTenantId(name, sql);
    },
  );
});

// ---------------------------------------------------------------------------
// Builder functions (queries.ts) — assert the EMITTED query, not the template
// ---------------------------------------------------------------------------

describe('TenantId enforcement: queries.ts builders', () => {
  const DUMMY_INPUT = {
    appId: 'test-app',
    tenantId: 'test-tenant',
    startDate: '2026-01-01',
    endDate: '2026-01-31',
    retentionCutoff: '2025-01-01',
    retentionCutoffDate: '2025-01-01',
    name: 'test',
    source: undefined,
    limit: 10,
  };

  const DUMMY_COMPARISON_INPUT = { ...DUMMY_INPUT, nameA: 'score-a', nameB: 'score-b' };
  const DUMMY_FILTERED_INPUT = { ...DUMMY_INPUT, filterClause: '' };
  const DUMMY_RANKING_INPUT = { ...DUMMY_FILTERED_INPUT, groupByColumn: 'Model', limit: 10 };
  const DUMMY_PAGINATED_RANKING_INPUT = {
    ...DUMMY_RANKING_INPUT,
    offset: 0,
    sortAlias: 'total_requests',
    sortOrder: 'desc' as const,
  };
  const DUMMY_MODEL_STATS_INPUT = { ...DUMMY_FILTERED_INPUT, limit: 10 };
  const DUMMY_PERCENTILES_INPUT = {
    ...DUMMY_FILTERED_INPUT,
    startDateTime: '2026-01-01',
    endDateTime: '2026-01-31',
    metricColumn: 'Duration' as const,
  };

  // Inputs are cast to any — this guard validates SQL content, not input types.
  const builderTests: Array<{ name: string; getQueries: () => string[] }> = [
    { name: 'buildTraceIOPreviewQuery', getQueries: () => [queries.buildTraceIOPreviewQuery('')] },
    { name: 'buildScoreHistogramQuery', getQueries: () => [queries.buildScoreHistogramQuery({ ...DUMMY_INPUT, minScore: 0, maxScore: 1, bucketWidth: 0.1 } as any).query] },
    { name: 'buildScoreCategoryCountsQuery', getQueries: () => [queries.buildScoreCategoryCountsQuery(DUMMY_INPUT as any).query] },
    { name: 'buildScoreTrendQuery', getQueries: () => [queries.buildScoreTrendQuery(DUMMY_INPUT as any, 'toStartOfDay(CreatedAt)').query] },
    { name: 'buildScoreComparisonQuery', getQueries: () => [queries.buildScoreComparisonQuery(DUMMY_COMPARISON_INPUT as any).query] },
    { name: 'buildScoreMatchedCountQuery', getQueries: () => [queries.buildScoreMatchedCountQuery(DUMMY_COMPARISON_INPUT as any).query] },
    { name: 'buildScoreScatterQuery', getQueries: () => [queries.buildScoreScatterQuery(DUMMY_COMPARISON_INPUT as any).query] },
    { name: 'buildScoreAggregationsQuery', getQueries: () => [queries.buildScoreAggregationsQuery(DUMMY_INPUT as any).query] },
    // Force the filtered branch (the no-filter branch returns the constant,
    // which the static-constants block already covers).
    { name: 'buildScoresListQuery', getQueries: () => [queries.buildScoresListQuery({ filterClause: ' AND 1 = 1' })] },
    { name: 'buildScoresCountQuery', getQueries: () => [queries.buildScoresCountQuery({ filterClause: ' AND 1 = 1' })] },
    { name: 'buildFilteredMetricsSummaryQuery', getQueries: () => [queries.buildFilteredMetricsSummaryQuery(DUMMY_FILTERED_INPUT as any).query] },
    { name: 'buildFilteredHourlyTimeSeriesQuery', getQueries: () => [queries.buildFilteredHourlyTimeSeriesQuery(DUMMY_FILTERED_INPUT as any).query] },
    { name: 'buildFilteredDailyTimeSeriesQuery', getQueries: () => [queries.buildFilteredDailyTimeSeriesQuery(DUMMY_FILTERED_INPUT as any).query] },
    { name: 'buildRankingByDimensionQuery', getQueries: () => [queries.buildRankingByDimensionQuery(DUMMY_RANKING_INPUT as any).query] },
    {
      name: 'buildPaginatedRankingQuery',
      getQueries: () => {
        const result = queries.buildPaginatedRankingQuery(DUMMY_PAGINATED_RANKING_INPUT as any);
        return [result.dataQuery.query, result.countQuery.query];
      },
    },
    { name: 'buildFilteredModelStatsQuery', getQueries: () => [queries.buildFilteredModelStatsQuery(DUMMY_MODEL_STATS_INPUT as any).query] },
    { name: 'buildFilteredPercentilesQuery', getQueries: () => [queries.buildFilteredPercentilesQuery(DUMMY_PERCENTILES_INPUT as any).query] },
  ];

  it.each(builderTests)('$name emits a TenantId predicate', ({ name, getQueries }) => {
    for (const sql of getQueries()) assertTenantId(name, sql);
  });
});

// ---------------------------------------------------------------------------
// Agent-fleet builders — the WHERE prefix is composed by scopeWhere() at
// runtime, so these must be invoked (a source scan can't see the predicate).
// ---------------------------------------------------------------------------

describe('TenantId enforcement: queries-agent-fleet.ts builders', () => {
  const SCOPE = { appId: 'app-1', tenantId: 'tenant-1', repo: 'owner/repo' };
  const RANGE = { startDate: '2026-01-01', endDate: '2026-01-31' };

  const fleetBuilders: Array<{ name: string; getQuery: () => string }> = [
    { name: 'buildAgentFleetDominantRepoQuery', getQuery: () => fleetQueries.buildAgentFleetDominantRepoQuery({ appId: 'app-1', tenantId: 'tenant-1' }).query },
    { name: 'buildAgentFleetTilesQuery', getQuery: () => fleetQueries.buildAgentFleetTilesQuery({ ...SCOPE, ...RANGE, priorStart: '2025-12-01' }).query },
    { name: 'buildAgentFleetModelMixQuery', getQuery: () => fleetQueries.buildAgentFleetModelMixQuery({ ...SCOPE, ...RANGE, limit: 10 }).query },
    { name: 'buildAgentFleetDimensionQuery', getQuery: () => fleetQueries.buildAgentFleetDimensionQuery({ ...SCOPE, ...RANGE, dimension: 'branch', limit: 10 }).query },
    { name: 'buildAgentFleetPercentileTrendQuery', getQuery: () => fleetQueries.buildAgentFleetPercentileTrendQuery({ ...SCOPE, ...RANGE }).query },
    { name: 'buildAgentFleetAutonomyMixTrendQuery', getQuery: () => fleetQueries.buildAgentFleetAutonomyMixTrendQuery({ ...SCOPE, ...RANGE }).query },
    { name: 'buildAgentFleetActiveActorTrendQuery', getQuery: () => fleetQueries.buildAgentFleetActiveActorTrendQuery({ ...SCOPE, ...RANGE }).query },
    { name: 'buildAgentFleetCostAnomalyQuery', getQuery: () => fleetQueries.buildAgentFleetCostAnomalyQuery({ ...SCOPE, startDate: '2026-01-01', latestDate: '2026-01-31', minDeltaUsd: 5, limit: 10 }).query },
    { name: 'buildAgentPrAttributionQuery', getQuery: () => fleetQueries.buildAgentPrAttributionQuery(SCOPE).query },
    { name: 'buildAgentPrCostAttributionQuery', getQuery: () => fleetQueries.buildAgentPrCostAttributionQuery(SCOPE).query },
    { name: 'buildAutonomyLadderAttributionQuery', getQuery: () => fleetQueries.buildAutonomyLadderAttributionQuery(SCOPE).query },
  ];

  it.each(fleetBuilders)('$name emits a TenantId predicate', ({ name, getQuery }) => {
    assertTenantId(name, getQuery());
  });

  it('org scope still binds TenantId (the widest sweep must not drop the tenant)', () => {
    const sql = fleetQueries.buildAgentFleetTilesQuery({
      ...SCOPE,
      ...RANGE,
      priorStart: '2025-12-01',
      scope: 'org',
    }).query;
    expect(TENANT_ID_PATTERN.test(sql)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Inline SQL in services/*.ts — source-scanned (the predicate is literal there)
// ---------------------------------------------------------------------------

describe('TenantId enforcement: services inline SQL', () => {
  // Discover every service file by scanning the directory — a new service
  // file cannot silently escape the guard by not being added to a list.
  const SERVICES_DIR = new URL('../services/', import.meta.url);
  const SERVICE_FILES = readdirSync(SERVICES_DIR)
    .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts') && !f.endsWith('.d.ts'));

  // Backtick-delimited template literals are the odd-indexed segments after a
  // split on the backtick; SQL lives only in these, so comments that mention a
  // table name are not scanned.
  function templateLiterals(source: string): string[] {
    return source.split('`').filter((_, i) => i % 2 === 1);
  }

  const cases = SERVICE_FILES.flatMap((file) => {
    const source = readFileSync(new URL(file, SERVICES_DIR), 'utf8');
    return templateLiterals(source)
      .map((sql, index) => ({ file, index, sql }))
      .filter(({ sql }) => TENANT_TABLE_PATTERN.test(sql));
  });

  it('at least one inline service query is scanned (guard is wired to real SQL)', () => {
    expect(cases.length).toBeGreaterThan(0);
  });

  it.each(cases)('$file inline query #$index carries a TenantId predicate', ({ file, index, sql }) => {
    assertTenantId(`${file} inline query #${index}`, sql);
  });
});

// ---------------------------------------------------------------------------
// The guard itself must fail red on an unscoped tenant query
// ---------------------------------------------------------------------------

describe('the guard rejects an unscoped tenant query', () => {
  it('throws, naming the query, for a tenant-table query with no TenantId predicate', () => {
    const unscoped = 'SELECT count() FROM otel_traces WHERE AppId = {appId:String}';
    expect(TENANT_TABLE_PATTERN.test(unscoped)).toBe(true);
    expect(TENANT_ID_PATTERN.test(unscoped)).toBe(false);
    // The failure names the offending query so a red CI run points at it.
    expect(() => assertTenantId('unscoped_fixture', unscoped)).toThrow(/unscoped_fixture/);
  });

  it('does not flag a query that touches no tenant table (the matcher skips it)', () => {
    expect(TENANT_TABLE_PATTERN.test('SELECT 1 FROM system.numbers')).toBe(false);
  });

  it('accepts a tenant-table query that carries the predicate', () => {
    const scoped = 'SELECT count() FROM otel_traces WHERE TenantId = {tenantId:String}';
    expect(TENANT_TABLE_PATTERN.test(scoped)).toBe(true);
    expect(TENANT_ID_PATTERN.test(scoped)).toBe(true);
  });
});
