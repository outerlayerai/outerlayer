/**
 * Tests: buildPaginatedRankingQuery
 * Feature: 009-trace-search-filter
 *
 * Tests the paginated ranking query builder with various dimensions,
 * sort fields, and filter combos.
 */

import { buildPaginatedRankingQuery, SORT_FIELD_MAP } from '../queries';
import type { PaginatedRankingInput } from '../queries';

const baseInput: PaginatedRankingInput = {
  appId: 'app-123',
  tenantId: 'test-tenant',
  startDate: '2026-01-01',
  endDate: '2026-02-01',
  filterClause: '',
  retentionCutoff: '1970-01-01T00:00:00.000Z',
  limit: 25,
  offset: 0,
  groupByColumn: 'ModelId',
  sortAlias: 'total_requests',
  sortOrder: 'desc',
};

describe('buildPaginatedRankingQuery', () => {
  it('should generate data and count queries', () => {
    const { dataQuery, countQuery } = buildPaginatedRankingQuery(baseInput);

    expect(dataQuery.query).toContain('SELECT');
    expect(dataQuery.query).toContain('ModelId as dimension_value');
    expect(dataQuery.query).toContain('GROUP BY ModelId');
    expect(dataQuery.query).toContain('ORDER BY total_requests DESC');
    expect(dataQuery.query).toContain('LIMIT {limit:UInt32}');
    expect(dataQuery.query).toContain('OFFSET {offset:UInt32}');

    expect(countQuery.query).toContain('SELECT count() as total');
    expect(countQuery.query).toContain('GROUP BY ModelId');
  });

  it('should include correct params in data query', () => {
    const { dataQuery } = buildPaginatedRankingQuery(baseInput);

    expect(dataQuery.params).toEqual({
      appId: 'app-123',
      tenantId: 'test-tenant',
      startDate: '2026-01-01',
      endDate: '2026-02-01',
      retentionCutoff: '1970-01-01T00:00:00.000Z',
      limit: 25,
      offset: 0,
    });
  });

  it('should include correct params in count query (no limit/offset)', () => {
    const { countQuery } = buildPaginatedRankingQuery(baseInput);

    expect(countQuery.params).toEqual({
      appId: 'app-123',
      tenantId: 'test-tenant',
      startDate: '2026-01-01',
      endDate: '2026-02-01',
      retentionCutoff: '1970-01-01T00:00:00.000Z',
    });
  });

  it('should use ascending sort when specified', () => {
    const { dataQuery } = buildPaginatedRankingQuery({
      ...baseInput,
      sortOrder: 'asc',
    });

    expect(dataQuery.query).toContain('ORDER BY total_requests ASC');
  });

  it('should use cost sort alias', () => {
    const { dataQuery } = buildPaginatedRankingQuery({
      ...baseInput,
      sortAlias: 'cost',
    });

    expect(dataQuery.query).toContain('ORDER BY cost DESC');
  });

  it('should default sortAlias to total_requests', () => {
    const input = { ...baseInput };
    delete (input as any).sortAlias;

    const { dataQuery } = buildPaginatedRankingQuery(input);
    expect(dataQuery.query).toContain('ORDER BY total_requests DESC');
  });

  it('should handle custom offset', () => {
    const { dataQuery } = buildPaginatedRankingQuery({
      ...baseInput,
      offset: 50,
    });

    expect(dataQuery.params.offset).toBe(50);
  });

  it('should include filter clause in both queries', () => {
    const { dataQuery, countQuery } = buildPaginatedRankingQuery({
      ...baseInput,
      filterClause: "AND ModelId = {filter_model:String}",
    });

    expect(dataQuery.query).toContain("AND ModelId = {filter_model:String}");
    expect(countQuery.query).toContain("AND ModelId = {filter_model:String}");
  });

  it('should handle user_id dimension', () => {
    const { dataQuery } = buildPaginatedRankingQuery({
      ...baseInput,
      groupByColumn: 'UserId',
    });

    expect(dataQuery.query).toContain('UserId as dimension_value');
    expect(dataQuery.query).toContain('GROUP BY UserId');
  });

  it('should interpolate sortAlias directly (caller must validate)', () => {
    // This test documents the trust boundary: sortAlias is interpolated into SQL,
    // so the caller (service.ts) MUST validate it against SORT_FIELD_MAP before passing.
    const { dataQuery } = buildPaginatedRankingQuery({
      ...baseInput,
      sortAlias: 'total_requests; DROP TABLE --',
    });

    // The query builder trusts its input — validation is the caller's responsibility
    expect(dataQuery.query).toContain('ORDER BY total_requests; DROP TABLE -- DESC');
  });

  it('should exclude limit/offset from count query params when filter clause is present', () => {
    const { countQuery } = buildPaginatedRankingQuery({
      ...baseInput,
      filterClause: "AND Model = {filter_model:String}",
    });

    expect(countQuery.params).not.toHaveProperty('limit');
    expect(countQuery.params).not.toHaveProperty('offset');
  });

  it('should handle metadata dimension', () => {
    const { dataQuery } = buildPaginatedRankingQuery({
      ...baseInput,
      groupByColumn: "Metadata['environment']",
    });

    expect(dataQuery.query).toContain("Metadata['environment'] as dimension_value");
    expect(dataQuery.query).toContain("GROUP BY Metadata['environment']");
  });
});

describe('SORT_FIELD_MAP', () => {
  it('should map all expected frontend fields', () => {
    expect([...SORT_FIELD_MAP.entries()]).toEqual([
      ['requests', 'total_requests'],
      ['cost', 'cost'],
      ['tokens', 'tokens'],
      ['inputTokens', 'input_tokens'],
      ['outputTokens', 'output_tokens'],
      ['avgLatencyMs', 'avg_latency_ms'],
      ['successRate', 'success_rate'],
    ]);
  });

  // Sort aliases are interpolated into ORDER BY, so the lookup must not resolve
  // anything the map does not own. A plain-object map would answer these with
  // truthy prototype members (a function, or Object.prototype itself).
  it.each(['constructor', '__proto__', 'toString', 'hasOwnProperty', 'valueOf'])(
    'does not resolve the inherited member %s',
    inherited => {
      expect(SORT_FIELD_MAP.get(inherited)).toBeUndefined();
    },
  );
});
