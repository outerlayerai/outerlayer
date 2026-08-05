/**
 * Filter performance characteristics tests.
 *
 * Verifies query builder correctness, retention cutoff presence,
 * and query timeout settings for filtered analytics queries.
 *
 */

import { buildFilterWhereClause, QUERY_TIMEOUT_SETTINGS } from '@repo/observability-service';
import { buildPaginatedRankingQuery } from '@repo/observability-service';
import { MIN_TEXT_SEARCH_LENGTH } from '../validation';

describe('Filter Performance Characteristics', () => {
  // ── QUERY_TIMEOUT_SETTINGS ──────────────────────────────────────────

  describe('QUERY_TIMEOUT_SETTINGS', () => {
    it('should export QUERY_TIMEOUT_SETTINGS with max_execution_time of 30', () => {
      expect(QUERY_TIMEOUT_SETTINGS.max_execution_time).toBe(30);
    });
  });

  // ── MIN_TEXT_SEARCH_LENGTH ──────────────────────────────────────────

  describe('MIN_TEXT_SEARCH_LENGTH', () => {
    it('should export MIN_TEXT_SEARCH_LENGTH as 2', () => {
      expect(MIN_TEXT_SEARCH_LENGTH).toBe(2);
    });
  });

  // ── Retention cutoff in paginated ranking ───────────────────────────

  describe('buildPaginatedRankingQuery retention cutoff', () => {
    it('should include retentionCutoff in the data query SQL', () => {
      const { dataQuery } = buildPaginatedRankingQuery({
        appId: 'app-1',
        tenantId: 'tenant-1',
        startDate: '2024-01-01',
        endDate: '2024-01-31',
        filterClause: '',
        limit: 10,
        offset: 0,
        groupByColumn: 'Model',
        retentionCutoff: '2023-10-01 00:00:00.000',
      });
      expect(dataQuery.query).toContain('retentionCutoff:DateTime64(3)');
      expect(dataQuery.params.retentionCutoff).toBe('2023-10-01 00:00:00.000');
    });

    it('should include retentionCutoff in the count query SQL', () => {
      const { countQuery } = buildPaginatedRankingQuery({
        appId: 'app-1',
        tenantId: 'tenant-1',
        startDate: '2024-01-01',
        endDate: '2024-01-31',
        filterClause: '',
        limit: 10,
        offset: 0,
        groupByColumn: 'Model',
        retentionCutoff: '2023-10-01 00:00:00.000',
      });
      expect(countQuery.query).toContain('retentionCutoff:DateTime64(3)');
      expect(countQuery.params.retentionCutoff).toBe('2023-10-01 00:00:00.000');
    });
  });

  // ── Parameterized query correctness ──────────────────────────────────

  describe('parameterized query correctness', () => {
    it('should produce parameterized values for all string operators', () => {
      const operators = ['equals', 'notEquals', 'contains', 'startsWith', 'endsWith', 'notContains'];
      for (const op of operators) {
        const result = buildFilterWhereClause([
          { field: 'model', operator: op, value: 'test-value' },
        ]);
        // Every operator should produce a parameterized clause, not inline the value
        expect(result.clause).toContain('filter_0');
        expect(result.clause).not.toContain('test-value');
      }
    });

    it('should produce parameterized values for all numeric operators', () => {
      const operators = ['gt', 'gte', 'lt', 'lte', 'equals', 'notEquals'];
      for (const op of operators) {
        const result = buildFilterWhereClause([
          { field: 'cost', operator: op, value: '42.5' },
        ]);
        expect(result.clause).toContain('filter_0');
        expect(result.clause).not.toContain('42.5');
      }
    });

    it('should produce parameterized values for metadata fields', () => {
      const result = buildFilterWhereClause([
        { field: 'metadata.env', operator: 'equals', value: 'production' },
      ]);
      // Both key and value should be parameterized
      expect(result.clause).toContain('filter_key_1');
      expect(result.clause).toContain('filter_0');
      expect(result.clause).not.toContain('production');
      expect(result.clause).not.toContain("'env'");
    });
  });

  // ── Clause ordering ──────────────────────────────────────────────────

  describe('clause ordering', () => {
    it('should produce AND-separated clauses for multiple filters', () => {
      const result = buildFilterWhereClause([
        { field: 'model', operator: 'equals', value: 'gpt-4' },
        { field: 'cost', operator: 'gt', value: '0.01' },
        { field: 'input', operator: 'contains', value: 'hello' },
      ]);
      const andCount = (result.clause.match(/AND/g) || []).length;
      expect(andCount).toBeGreaterThanOrEqual(3); // Each filter starts with AND
    });

    it('should use sequential parameter names', () => {
      const result = buildFilterWhereClause([
        { field: 'model', operator: 'equals', value: 'a' },
        { field: 'cost', operator: 'gt', value: '1' },
        { field: 'user_id', operator: 'equals', value: 'b' },
      ]);
      expect(result.params).toHaveProperty('filter_0');
      expect(result.params).toHaveProperty('filter_1');
      expect(result.params).toHaveProperty('filter_2');
    });
  });
});
