/**
 * Analytics Service Filter Tests
 * Feature: 007-analytics-architecture-evaluation
 *
 * Tests for buildFilterWhereClause function in the analytics service.
 * This function builds parameterized SQL WHERE clauses from filter objects.
 */

import { buildFilterWhereClause } from '../service';
import type { AnalyticsFilter } from '../types';

describe('buildFilterWhereClause', () => {
  describe('empty/undefined input', () => {
    it('should return empty clause and params when filters is undefined', () => {
      const result = buildFilterWhereClause(undefined);
      expect(result.clause).toBe('');
      expect(result.params).toEqual({});
    });

    it('should return empty clause and params when filters is empty array', () => {
      const result = buildFilterWhereClause([]);
      expect(result.clause).toBe('');
      expect(result.params).toEqual({});
    });
  });

  describe('field mapping', () => {
    it('should map model field to Model column', () => {
      const filters: AnalyticsFilter[] = [
        { field: 'model', operator: 'equals', value: 'gpt-4' },
      ];
      const result = buildFilterWhereClause(filters);
      expect(result.clause).toContain('Model =');
    });

    it('should map model_used field to Model column', () => {
      const filters: AnalyticsFilter[] = [
        { field: 'model_used', operator: 'equals', value: 'gpt-4' },
      ];
      const result = buildFilterWhereClause(filters);
      expect(result.clause).toContain('Model =');
    });

    it('should map user_id field to UserId column', () => {
      const filters: AnalyticsFilter[] = [
        { field: 'user_id', operator: 'equals', value: 'user-123' },
      ];
      const result = buildFilterWhereClause(filters);
      expect(result.clause).toContain('UserId =');
    });

    it('should map input field to Input column', () => {
      const filters: AnalyticsFilter[] = [
        { field: 'input', operator: 'contains', value: 'test' },
      ];
      const result = buildFilterWhereClause(filters);
      expect(result.clause).toContain('Input ILIKE');
    });

    it('should map output field to Output column', () => {
      const filters: AnalyticsFilter[] = [
        { field: 'output', operator: 'contains', value: 'test' },
      ];
      const result = buildFilterWhereClause(filters);
      expect(result.clause).toContain('Output ILIKE');
    });

    it('should map trace_id field to TraceId column', () => {
      const filters: AnalyticsFilter[] = [
        { field: 'trace_id', operator: 'equals', value: 'abc123' },
      ];
      const result = buildFilterWhereClause(filters);
      expect(result.clause).toContain('TraceId =');
    });

    it('should map latency field to Duration column', () => {
      const filters: AnalyticsFilter[] = [
        { field: 'latency', operator: 'gt', value: '1000' },
      ];
      const result = buildFilterWhereClause(filters);
      expect(result.clause).toContain('Duration >');
    });

    it('should map cost field to Cost column', () => {
      const filters: AnalyticsFilter[] = [
        { field: 'cost', operator: 'gt', value: '0.01' },
      ];
      const result = buildFilterWhereClause(filters);
      expect(result.clause).toContain('Cost >');
    });

    it('should map prompt_tokens field to InputTokens column', () => {
      const filters: AnalyticsFilter[] = [
        { field: 'prompt_tokens', operator: 'gt', value: '100' },
      ];
      const result = buildFilterWhereClause(filters);
      expect(result.clause).toContain('InputTokens >');
    });

    it('should map completion_tokens field to OutputTokens column', () => {
      const filters: AnalyticsFilter[] = [
        { field: 'completion_tokens', operator: 'gt', value: '50' },
      ];
      const result = buildFilterWhereClause(filters);
      expect(result.clause).toContain('OutputTokens >');
    });

    it('should skip unknown fields silently', () => {
      const filters: AnalyticsFilter[] = [
        { field: 'unknown_field', operator: 'equals', value: 'test' },
      ];
      const result = buildFilterWhereClause(filters);
      expect(result.clause).toBe('');
      expect(result.params).toEqual({});
    });

    it('should handle case-insensitive field names', () => {
      const filters: AnalyticsFilter[] = [
        { field: 'OUTPUT', operator: 'contains', value: 'test' },
      ];
      const result = buildFilterWhereClause(filters);
      expect(result.clause).toContain('Output ILIKE');
    });
  });

  describe('string operators', () => {
    it('should handle equals operator', () => {
      const filters: AnalyticsFilter[] = [
        { field: 'output', operator: 'equals', value: 'exact' },
      ];
      const result = buildFilterWhereClause(filters);
      expect(result.clause).toContain('Output = {filter_0:String}');
      expect(result.params.filter_0).toBe('exact');
    });

    it('should handle = operator as equals', () => {
      const filters: AnalyticsFilter[] = [
        { field: 'output', operator: '=', value: 'exact' },
      ];
      const result = buildFilterWhereClause(filters);
      expect(result.clause).toContain('Output = {filter_0:String}');
    });

    it('should handle notEquals operator', () => {
      const filters: AnalyticsFilter[] = [
        { field: 'output', operator: 'notEquals', value: 'exclude' },
      ];
      const result = buildFilterWhereClause(filters);
      expect(result.clause).toContain('Output != {filter_0:String}');
    });

    it('should handle contains operator with wildcards', () => {
      const filters: AnalyticsFilter[] = [
        { field: 'output', operator: 'contains', value: 'search' },
      ];
      const result = buildFilterWhereClause(filters);
      expect(result.clause).toContain('Output ILIKE {filter_0:String}');
      expect(result.params.filter_0).toBe('%search%');
    });

    it('should handle startsWith operator', () => {
      const filters: AnalyticsFilter[] = [
        { field: 'output', operator: 'startsWith', value: 'Hello' },
      ];
      const result = buildFilterWhereClause(filters);
      expect(result.clause).toContain('Output ILIKE {filter_0:String}');
      expect(result.params.filter_0).toBe('Hello%');
    });

    it('should handle endsWith operator', () => {
      const filters: AnalyticsFilter[] = [
        { field: 'output', operator: 'endsWith', value: 'world' },
      ];
      const result = buildFilterWhereClause(filters);
      expect(result.clause).toContain('Output ILIKE {filter_0:String}');
      expect(result.params.filter_0).toBe('%world');
    });

    it('should handle notContains operator', () => {
      const filters: AnalyticsFilter[] = [
        { field: 'output', operator: 'notContains', value: 'exclude' },
      ];
      const result = buildFilterWhereClause(filters);
      expect(result.clause).toContain('Output NOT ILIKE {filter_0:String}');
      expect(result.params.filter_0).toBe('%exclude%');
    });
  });

  describe('numeric operators', () => {
    it('should handle numeric equals operator', () => {
      const filters: AnalyticsFilter[] = [
        { field: 'latency', operator: 'equals', value: '1000' },
      ];
      const result = buildFilterWhereClause(filters);
      expect(result.clause).toContain('Duration = {filter_0:Float64}');
      expect(result.params.filter_0).toBe(1000);
    });

    it('should handle numeric gt operator', () => {
      const filters: AnalyticsFilter[] = [
        { field: 'latency', operator: 'gt', value: '500' },
      ];
      const result = buildFilterWhereClause(filters);
      expect(result.clause).toContain('Duration > {filter_0:Float64}');
      expect(result.params.filter_0).toBe(500);
    });

    it('should handle numeric gte operator', () => {
      const filters: AnalyticsFilter[] = [
        { field: 'cost', operator: 'gte', value: '0.01' },
      ];
      const result = buildFilterWhereClause(filters);
      expect(result.clause).toContain('Cost >= {filter_0:Float64}');
      expect(result.params.filter_0).toBe(0.01);
    });

    it('should handle numeric lt operator', () => {
      const filters: AnalyticsFilter[] = [
        { field: 'latency', operator: 'lt', value: '2000' },
      ];
      const result = buildFilterWhereClause(filters);
      expect(result.clause).toContain('Duration < {filter_0:Float64}');
      expect(result.params.filter_0).toBe(2000);
    });

    it('should handle numeric lte operator', () => {
      const filters: AnalyticsFilter[] = [
        { field: 'prompt_tokens', operator: 'lte', value: '100' },
      ];
      const result = buildFilterWhereClause(filters);
      expect(result.clause).toContain('InputTokens <= {filter_0:Float64}');
      expect(result.params.filter_0).toBe(100);
    });

    it('should parse numeric value from string', () => {
      const filters: AnalyticsFilter[] = [
        { field: 'cost', operator: 'gt', value: '0.005' },
      ];
      const result = buildFilterWhereClause(filters);
      expect(result.params.filter_0).toBe(0.005);
    });

    it('should default to 0 for invalid numeric values', () => {
      const filters: AnalyticsFilter[] = [
        { field: 'cost', operator: 'gt', value: 'not-a-number' },
      ];
      const result = buildFilterWhereClause(filters);
      expect(result.params.filter_0).toBe(0);
    });
  });

  describe('status field special handling', () => {
    it('should map OK status to a TraceId NOT IN (error trace IDs) subquery', () => {
      const filters: AnalyticsFilter[] = [
        { field: 'status', operator: 'equals', value: 'OK' },
      ];
      const result = buildFilterWhereClause(filters);
      expect(result.clause).toContain('TraceId NOT IN (SELECT DISTINCT TraceId FROM otel_traces');
      expect(result.clause).toContain("StatusCode IN ('2', 'STATUS_CODE_ERROR', 'Error')");
    });

    it('should map SUCCESS status to a TraceId NOT IN (error trace IDs) subquery', () => {
      const filters: AnalyticsFilter[] = [
        { field: 'status', operator: 'equals', value: 'SUCCESS' },
      ];
      const result = buildFilterWhereClause(filters);
      expect(result.clause).toContain('TraceId NOT IN (SELECT DISTINCT TraceId FROM otel_traces');
      expect(result.clause).toContain("StatusCode IN ('2', 'STATUS_CODE_ERROR', 'Error')");
    });

    it('should map ERROR status to StatusCode IN error set', () => {
      const filters: AnalyticsFilter[] = [
        { field: 'status', operator: 'equals', value: 'ERROR' },
      ];
      const result = buildFilterWhereClause(filters);
      expect(result.clause).toContain("StatusCode IN ('2', 'STATUS_CODE_ERROR', 'Error')");
    });

    it('should map FAIL status to StatusCode IN error set', () => {
      const filters: AnalyticsFilter[] = [
        { field: 'status', operator: 'equals', value: 'FAIL' },
      ];
      const result = buildFilterWhereClause(filters);
      expect(result.clause).toContain("StatusCode IN ('2', 'STATUS_CODE_ERROR', 'Error')");
    });

    it('should handle case-insensitive status values', () => {
      const filters: AnalyticsFilter[] = [
        { field: 'status', operator: 'equals', value: 'ok' },
      ];
      const result = buildFilterWhereClause(filters);
      expect(result.clause).toContain('TraceId NOT IN (SELECT DISTINCT TraceId FROM otel_traces');
    });
  });

  describe('multiple filters', () => {
    it('should combine multiple filters with AND', () => {
      const filters: AnalyticsFilter[] = [
        { field: 'output', operator: 'contains', value: 'hello' },
        { field: 'model', operator: 'equals', value: 'gpt-4' },
      ];
      const result = buildFilterWhereClause(filters);
      expect(result.clause).toContain('Output ILIKE');
      expect(result.clause).toContain('Model =');
      expect(result.clause).toContain(' AND ');
    });

    it('should generate unique parameter names for each filter', () => {
      const filters: AnalyticsFilter[] = [
        { field: 'output', operator: 'contains', value: 'hello' },
        { field: 'input', operator: 'contains', value: 'world' },
      ];
      const result = buildFilterWhereClause(filters);
      expect(result.params).toHaveProperty('filter_0');
      expect(result.params).toHaveProperty('filter_1');
      expect(result.params.filter_0).toBe('%hello%');
      expect(result.params.filter_1).toBe('%world%');
    });

    it('should prefix clause with AND', () => {
      const filters: AnalyticsFilter[] = [
        { field: 'output', operator: 'contains', value: 'test' },
      ];
      const result = buildFilterWhereClause(filters);
      expect(result.clause.startsWith('AND ')).toBe(true);
    });
  });

  describe('parameterized query safety', () => {
    it('should use parameterized values for string filters', () => {
      const filters: AnalyticsFilter[] = [
        { field: 'output', operator: 'contains', value: "test'; DROP TABLE--" },
      ];
      const result = buildFilterWhereClause(filters);
      // Value should be in params, not directly in the clause
      expect(result.clause).not.toContain("test'; DROP TABLE--");
      expect(result.params.filter_0).toContain("test'; DROP TABLE--");
    });

    it('should use parameterized values for numeric filters', () => {
      const filters: AnalyticsFilter[] = [
        { field: 'cost', operator: 'gt', value: '0.01; DELETE FROM--' },
      ];
      const result = buildFilterWhereClause(filters);
      // parseFloat extracts the leading numeric portion (0.01), ignoring the injection attempt
      // The malicious SQL is safely ignored - only the number goes into params
      expect(result.params.filter_0).toBe(0.01);
    });
  });

  describe('metadata field operators', () => {
    it('should handle metadata equals operator', () => {
      const filters: AnalyticsFilter[] = [
        { field: 'metadata.feature', operator: 'equals', value: 'chat' },
      ];
      const result = buildFilterWhereClause(filters);
      expect(result.clause).toContain("Metadata[{filter_key_1:String}] = {filter_0:String}");
      expect(result.params.filter_key_1).toBe('feature');
      expect(result.params.filter_0).toBe('chat');
    });

    it('should handle metadata notEquals operator', () => {
      const filters: AnalyticsFilter[] = [
        { field: 'metadata.env', operator: 'notequals', value: 'staging' },
      ];
      const result = buildFilterWhereClause(filters);
      expect(result.clause).toContain("Metadata[{filter_key_1:String}] != {filter_0:String}");
      expect(result.params.filter_0).toBe('staging');
    });

    it('should handle metadata contains operator', () => {
      const filters: AnalyticsFilter[] = [
        { field: 'metadata.feature', operator: 'contains', value: 'chat' },
      ];
      const result = buildFilterWhereClause(filters);
      expect(result.clause).toContain("Metadata[{filter_key_1:String}] LIKE {filter_0:String}");
      expect(result.params.filter_0).toBe('%chat%');
    });

    it('should handle metadata notContains operator', () => {
      const filters: AnalyticsFilter[] = [
        { field: 'metadata.feature', operator: 'notContains', value: 'test' },
      ];
      const result = buildFilterWhereClause(filters);
      expect(result.clause).toContain("Metadata[{filter_key_1:String}] NOT LIKE {filter_0:String}");
      expect(result.params.filter_0).toBe('%test%');
    });

    it('should handle metadata startsWith operator', () => {
      const filters: AnalyticsFilter[] = [
        { field: 'metadata.env', operator: 'startsWith', value: 'prod' },
      ];
      const result = buildFilterWhereClause(filters);
      expect(result.clause).toContain("Metadata[{filter_key_1:String}] LIKE {filter_0:String}");
      expect(result.params.filter_0).toBe('prod%');
    });

    it('should handle metadata endsWith operator', () => {
      const filters: AnalyticsFilter[] = [
        { field: 'metadata.env', operator: 'endsWith', value: '-us' },
      ];
      const result = buildFilterWhereClause(filters);
      expect(result.clause).toContain("Metadata[{filter_key_1:String}] LIKE {filter_0:String}");
      expect(result.params.filter_0).toBe('%-us');
    });

    it('should handle metadata exists operator (key has any value)', () => {
      const filters: AnalyticsFilter[] = [
        { field: 'metadata.feature', operator: 'exists', value: '' },
      ];
      const result = buildFilterWhereClause(filters);
      expect(result.clause).toContain("Metadata[{filter_key_1:String}] != ''");
      // exists doesn't use a value param — only the key param
      expect(result.params.filter_key_1).toBe('feature');
    });

    it('should handle metadata doesNotExist operator (key is absent)', () => {
      const filters: AnalyticsFilter[] = [
        { field: 'metadata.feature', operator: 'doesNotExist', value: '' },
      ];
      const result = buildFilterWhereClause(filters);
      expect(result.clause).toContain("Metadata[{filter_key_1:String}] = ''");
      expect(result.params.filter_key_1).toBe('feature');
    });

    it('should skip metadata fields with invalid key names', () => {
      const filters: AnalyticsFilter[] = [
        { field: "metadata.'; DROP TABLE--", operator: 'equals', value: 'x' },
      ];
      const result = buildFilterWhereClause(filters);
      expect(result.clause).toBe('');
    });
  });
  describe('topic__<facet> filters', () => {
    it('builds a tenant-scoped TraceId IN subquery on trace_facets for equals', () => {
      const filters: AnalyticsFilter[] = [
        { field: 'topic__task', operator: 'equals', value: 'v1-c0' },
      ];
      const result = buildFilterWhereClause(filters, 'app-1', 'tenant-1');
      expect(result.clause).toContain('TraceId IN (SELECT TraceId FROM trace_facets FINAL');
      expect(result.clause).toContain('AppId = {topic_appId:String}');
      expect(result.clause).toContain('TenantId = {topic_tenantId:String}');
      expect(result.clause).toContain('Facet = {topic_facet_0:String}');
      expect(result.clause).toContain('TopicId = {topic_value_0:String}');
      // Parameterized, never inlined — pins out the injection vector.
      expect(result.clause).not.toContain('v1-c0');
      expect(result.params).toEqual({
        topic_appId: 'app-1',
        topic_tenantId: 'tenant-1',
        topic_facet_0: 'task',
        topic_value_0: 'v1-c0',
      });
    });

    it('negates with TraceId NOT IN for not_equals', () => {
      const filters: AnalyticsFilter[] = [
        { field: 'topic__issues', operator: 'not_equals', value: 'no_match' },
      ];
      const result = buildFilterWhereClause(filters, 'app-1', 'tenant-1');
      expect(result.clause).toContain('TraceId NOT IN (SELECT TraceId FROM trace_facets FINAL');
      expect(result.params.topic_facet_0).toBe('issues');
      expect(result.params.topic_value_0).toBe('no_match');
    });

    it('accepts the steering facet — a fanned-out trace matches when ANY of its rows carries the topic', () => {
      const result = buildFilterWhereClause(
        [{ field: 'topic__steering', operator: 'equals', value: 'v1-s0' }],
        'app-1',
        'tenant-1',
      );
      expect(result.clause).toContain('TraceId IN (SELECT TraceId FROM trace_facets FINAL');
      expect(result.params.topic_facet_0).toBe('steering');
      expect(result.params.topic_value_0).toBe('v1-s0');
    });

    it('rejects unknown facets and unsupported operators (filter dropped, no clause)', () => {
      const unknownFacet = buildFilterWhereClause(
        [{ field: 'topic__sentiment', operator: 'equals', value: 'x' }],
        'app-1',
        'tenant-1',
      );
      expect(unknownFacet.clause).toBe('');
      expect(unknownFacet.params).toEqual({});

      const badOperator = buildFilterWhereClause(
        [{ field: 'topic__task', operator: 'contains', value: 'x' }],
        'app-1',
        'tenant-1',
      );
      expect(badOperator.clause).toBe('');
      expect(badOperator.params).toEqual({});
    });

    it('omits the tenant clause when tenantId is not provided', () => {
      const result = buildFilterWhereClause(
        [{ field: 'topic__task', operator: 'equals', value: 'v1-c0' }],
        'app-1',
      );
      expect(result.clause).not.toContain('topic_tenantId');
      expect(result.params.topic_appId).toBe('app-1');
    });

    it('drops the filter entirely when appId is missing (no unbound topic_appId)', () => {
      // The subquery is unconditionally AppId-scoped; without an appId that
      // parameter would be unbound and ClickHouse rejects the whole query.
      const result = buildFilterWhereClause([
        { field: 'topic__task', operator: 'equals', value: 'v1-c0' },
      ]);
      expect(result.clause).toBe('');
      expect(result.params).toEqual({});
      expect(result.clause).not.toContain('topic_appId');
    });
  });
});
