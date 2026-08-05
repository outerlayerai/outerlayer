/**
 * parseFilters validation tests.
 *
 * Tests the filter parsing and validation logic that sits between
 * the API route (raw query string) and the service layer.
 */

import { parseFilters } from '../validation';
import { ValidationError } from '@repo/observability-service';

describe('parseFilters', () => {
  // ── Happy path ────────────────────────────────────────────────────

  it('should return undefined for undefined input', () => {
    expect(parseFilters(undefined)).toBeUndefined();
  });

  it('should return undefined for empty string input', () => {
    expect(parseFilters('')).toBeUndefined();
  });

  it('should parse a single valid filter', () => {
    const input = JSON.stringify([
      { field: 'model', operator: 'equals', value: 'gpt-4' },
    ]);
    const result = parseFilters(input);
    expect(result).toEqual([
      { field: 'model', operator: 'equals', value: 'gpt-4' },
    ]);
  });

  it('should parse multiple valid filters', () => {
    const input = JSON.stringify([
      { field: 'model', operator: 'equals', value: 'gpt-4' },
      { field: 'status', operator: 'equals', value: 'ERROR' },
      { field: 'latency_ms', operator: 'gt', value: '100' },
    ]);
    const result = parseFilters(input);
    expect(result).toHaveLength(3);
  });

  it('should lowercase field names', () => {
    const input = JSON.stringify([
      { field: 'Model', operator: 'equals', value: 'gpt-4' },
    ]);
    const result = parseFilters(input);
    expect(result![0]!.field).toBe('model');
  });

  it('should lowercase operator names', () => {
    const input = JSON.stringify([
      { field: 'model', operator: 'Contains', value: 'gpt' },
    ]);
    const result = parseFilters(input);
    expect(result![0]!.operator).toBe('contains');
  });

  it('should convert non-string values to strings', () => {
    const input = JSON.stringify([
      { field: 'latency_ms', operator: 'gt', value: 100 },
    ]);
    const result = parseFilters(input);
    expect(result![0]!.value).toBe('100');
  });

  it('should default operator to equals when not provided', () => {
    const input = JSON.stringify([
      { field: 'model', value: 'gpt-4' },
    ]);
    const result = parseFilters(input);
    expect(result![0]!.operator).toBe('equals');
  });

  it('should default unknown operators to equals', () => {
    const input = JSON.stringify([
      { field: 'model', operator: 'INVALID_OP', value: 'gpt-4' },
    ]);
    const result = parseFilters(input);
    expect(result![0]!.operator).toBe('equals');
  });

  // ── Error cases ───────────────────────────────────────────────────

  it('should throw ValidationError for invalid JSON', () => {
    expect(() => parseFilters('not valid json')).toThrow(ValidationError);
    expect(() => parseFilters('not valid json')).toThrow(
      'Invalid filters format - must be valid JSON'
    );
  });

  it('should throw ValidationError for non-array JSON', () => {
    expect(() => parseFilters('{"field":"model"}')).toThrow(ValidationError);
    expect(() => parseFilters('{"field":"model"}')).toThrow(
      'Filters must be an array'
    );
  });

  it('should throw ValidationError for JSON string (not array)', () => {
    expect(() => parseFilters('"just a string"')).toThrow(ValidationError);
  });

  it('should throw ValidationError when more than 10 filters', () => {
    const filters = Array.from({ length: 11 }, (_, i) => ({
      field: 'model',
      operator: 'equals',
      value: `model-${i}`,
    }));
    expect(() => parseFilters(JSON.stringify(filters))).toThrow(
      'Maximum 10 filters allowed'
    );
  });

  it('should accept exactly 10 filters', () => {
    const filters = Array.from({ length: 10 }, (_, i) => ({
      field: 'model',
      operator: 'equals',
      value: `model-${i}`,
    }));
    const result = parseFilters(JSON.stringify(filters));
    expect(result).toHaveLength(10);
  });

  it('should throw ValidationError for filter value exceeding 500 chars', () => {
    const input = JSON.stringify([
      { field: 'model', operator: 'equals', value: 'a'.repeat(501) },
    ]);
    expect(() => parseFilters(input)).toThrow(
      'Filter value exceeds maximum length of 500'
    );
  });

  it('should accept filter value of exactly 500 chars', () => {
    const input = JSON.stringify([
      { field: 'model', operator: 'equals', value: 'a'.repeat(500) },
    ]);
    const result = parseFilters(input);
    expect(result).toHaveLength(1);
  });

  // ── Skipped / filtered entries ────────────────────────────────────

  it('should skip null entries in the array', () => {
    const input = JSON.stringify([
      null,
      { field: 'model', operator: 'equals', value: 'gpt-4' },
    ]);
    const result = parseFilters(input);
    expect(result).toHaveLength(1);
  });

  it('should skip non-object entries', () => {
    const input = JSON.stringify([
      'not an object',
      42,
      { field: 'model', operator: 'equals', value: 'gpt-4' },
    ]);
    const result = parseFilters(input);
    expect(result).toHaveLength(1);
  });

  it('should skip entries with non-string field', () => {
    const input = JSON.stringify([
      { field: 123, operator: 'equals', value: 'test' },
    ]);
    const result = parseFilters(input);
    expect(result).toBeUndefined(); // 0 valid filters → undefined
  });

  it('should skip entries with unknown field names', () => {
    const input = JSON.stringify([
      { field: 'unknown_field', operator: 'equals', value: 'test' },
    ]);
    const result = parseFilters(input);
    expect(result).toBeUndefined();
  });

  it('should skip entries with empty value', () => {
    const input = JSON.stringify([
      { field: 'model', operator: 'equals', value: '' },
    ]);
    const result = parseFilters(input);
    expect(result).toBeUndefined();
  });

  it('should skip entries with null value', () => {
    const input = JSON.stringify([
      { field: 'model', operator: 'equals', value: null },
    ]);
    const result = parseFilters(input);
    expect(result).toBeUndefined();
  });

  it('should skip entries with undefined value', () => {
    // When JSON.stringify is used, undefined becomes missing/null
    const input = JSON.stringify([
      { field: 'model', operator: 'equals' },
    ]);
    const result = parseFilters(input);
    expect(result).toBeUndefined();
  });

  it('should return undefined when all filters are invalid', () => {
    const input = JSON.stringify([
      { field: 'unknown', operator: 'equals', value: 'test' },
      { field: 'model', operator: 'equals', value: '' },
    ]);
    const result = parseFilters(input);
    expect(result).toBeUndefined();
  });

  it('should return valid filters and skip invalid ones', () => {
    const input = JSON.stringify([
      { field: 'model', operator: 'equals', value: 'gpt-4' },
      { field: 'unknown', operator: 'equals', value: 'skip-me' },
      { field: 'status', operator: 'equals', value: 'OK' },
    ]);
    const result = parseFilters(input);
    expect(result).toHaveLength(2);
    expect(result![0]!.field).toBe('model');
    expect(result![1]!.field).toBe('status');
  });

  // ── Empty array ───────────────────────────────────────────────────

  it('should return undefined for empty array', () => {
    expect(parseFilters('[]')).toBeUndefined();
  });

  // ── All allowed fields ────────────────────────────────────────────

  it('should accept all allowed filter fields', () => {
    const allowedFields = [
      'model', 'model_used', 'user_id', 'user', 'status',
      'latency_ms', 'latency', 'input', 'output', 'props',
      'prompt_tokens', 'completion_tokens', 'cost',
      'trace_id',
    ];

    for (const field of allowedFields) {
      const input = JSON.stringify([
        { field, operator: 'equals', value: 'test' },
      ]);
      const result = parseFilters(input);
      expect(result).toHaveLength(1);
    }
  });

  // ── All allowed operators ─────────────────────────────────────────

  it('should accept lowercase and symbol operators correctly', () => {
    // These operators are in the allowlist and survive lowercasing
    const correctlyHandledOps = [
      'equals', '=', 'not_equals', '!=',
      'contains', 'like', 'starts_with',
      'ends_with', 'not_contains',
      'lt', '<', 'lte', '<=', 'gt', '>', 'gte', '>=',
    ];

    for (const op of correctlyHandledOps) {
      const input = JSON.stringify([
        { field: 'model', operator: op, value: 'test' },
      ]);
      const result = parseFilters(input);
      expect(result).toHaveLength(1);
      expect(result![0]!.operator).toBe(op.toLowerCase());
    }
  });

  it('should correctly handle camelCase operators by lowercasing the allowlist', () => {
    const camelCaseOps = ['notEquals', 'startsWith', 'endsWith', 'notContains'];
    for (const op of camelCaseOps) {
      const input = JSON.stringify([
        { field: 'model', operator: op, value: 'test' },
      ]);
      const result = parseFilters(input);
      expect(result).toHaveLength(1);
      expect(result![0]!.operator).toBe(op.toLowerCase());
    }
  });

  // ── metadata.* fields ─────────────────────────────────────────────

  it('should allow metadata.* fields with valid key names', () => {
    const input = JSON.stringify([
      { field: 'metadata.environment', operator: 'equals', value: 'prod' },
    ]);
    const result = parseFilters(input);
    expect(result).toHaveLength(1);
    expect(result![0]!.field).toBe('metadata.environment');
  });

  it('should reject metadata.* fields with invalid key names', () => {
    const input = JSON.stringify([
      { field: "metadata.'; DROP TABLE--", operator: 'equals', value: 'x' },
    ]);
    const result = parseFilters(input);
    expect(result).toBeUndefined();
  });

  it('should reject metadata keys with dashes (harmonized with service layer)', () => {
    const input = JSON.stringify([
      { field: 'metadata.some-key', operator: 'equals', value: 'test' },
    ]);
    const result = parseFilters(input);
    expect(result).toBeUndefined();
  });

  it('should reject metadata. prefix with no key name', () => {
    const input = JSON.stringify([
      { field: 'metadata.', operator: 'equals', value: 'test' },
    ]);
    const result = parseFilters(input);
    expect(result).toBeUndefined();
  });

  // ── Minimum text search length ─────────────────────────────────────

  describe('minimum text search length validation', () => {
    it('should reject 1-character contains search on input field', () => {
      const input = JSON.stringify([
        { field: 'input', operator: 'contains', value: 'a' },
      ]);
      expect(() => parseFilters(input)).toThrow(ValidationError);
      expect(() => parseFilters(input)).toThrow(
        'Text search on "input" requires at least 2 characters'
      );
    });

    it('should reject 1-character contains search on output field', () => {
      const input = JSON.stringify([
        { field: 'output', operator: 'contains', value: 'b' },
      ]);
      expect(() => parseFilters(input)).toThrow(ValidationError);
    });

    it('should reject 1-character contains search on props field', () => {
      const input = JSON.stringify([
        { field: 'props', operator: 'contains', value: 'x' },
      ]);
      expect(() => parseFilters(input)).toThrow(ValidationError);
    });

    it('should accept exactly 2-character contains search on input field', () => {
      const input = JSON.stringify([
        { field: 'input', operator: 'contains', value: 'ab' },
      ]);
      const result = parseFilters(input);
      expect(result).toHaveLength(1);
    });

    it('should reject 1-character startsWith on output field', () => {
      const input = JSON.stringify([
        { field: 'output', operator: 'startsWith', value: 'x' },
      ]);
      expect(() => parseFilters(input)).toThrow(ValidationError);
    });

    it('should reject 1-character endsWith on input field', () => {
      const input = JSON.stringify([
        { field: 'input', operator: 'endsWith', value: 'z' },
      ]);
      expect(() => parseFilters(input)).toThrow(ValidationError);
    });

    it('should reject 1-character notContains on props field', () => {
      const input = JSON.stringify([
        { field: 'props', operator: 'notContains', value: 'q' },
      ]);
      expect(() => parseFilters(input)).toThrow(ValidationError);
    });

    it('should reject 1-character like operator on input field', () => {
      const input = JSON.stringify([
        { field: 'input', operator: 'like', value: 'a' },
      ]);
      expect(() => parseFilters(input)).toThrow(ValidationError);
    });

    it('should NOT enforce min-length on model field (not a text search field)', () => {
      const input = JSON.stringify([
        { field: 'model', operator: 'contains', value: 'a' },
      ]);
      const result = parseFilters(input);
      expect(result).toHaveLength(1);
    });

    it('should NOT enforce min-length on user_id field', () => {
      const input = JSON.stringify([
        { field: 'user_id', operator: 'contains', value: 'x' },
      ]);
      const result = parseFilters(input);
      expect(result).toHaveLength(1);
    });

    it('should NOT enforce min-length for equals operator on text fields', () => {
      const input = JSON.stringify([
        { field: 'input', operator: 'equals', value: 'a' },
      ]);
      const result = parseFilters(input);
      expect(result).toHaveLength(1);
    });

    it('should NOT enforce min-length for gt operator on text fields', () => {
      const input = JSON.stringify([
        { field: 'input', operator: 'gt', value: '1' },
      ]);
      const result = parseFilters(input);
      expect(result).toHaveLength(1);
    });

    it('should accept long search terms on text fields', () => {
      const input = JSON.stringify([
        { field: 'input', operator: 'contains', value: 'translate this document into French' },
      ]);
      const result = parseFilters(input);
      expect(result).toHaveLength(1);
    });
  });
});
