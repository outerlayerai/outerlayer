/**
 * Analytics Validation Tests
 *
 * Tests for input validation schemas (Zod).
 */

import { z } from 'zod';
import {
  metricsParamsSchema,
  tracesParamsSchema,
  percentilesParamsSchema,
  traceIdSchema,
  validateInput,
  parseFilters,
  VALIDATION_LIMITS,
  ALLOWED_FILTER_FIELDS,
  ALLOWED_FILTER_OPERATORS,
  ALLOWED_SORT_FIELDS_TRACES,
} from '../validation';
import { ValidationError } from '@repo/observability-service';

describe('metricsParamsSchema', () => {
  it('should validate correct params and pass them through unchanged', () => {
    expect(
      metricsParamsSchema.parse({
        range: '7d',
        startDate: '2024-01-01',
        endDate: '2024-01-31',
      }),
    ).toEqual({
      range: '7d',
      startDate: '2024-01-01',
      endDate: '2024-01-31',
    });
  });

  it.each(['today', '7d', '30d', '90d'])(
    'should accept %s range value and pass it through',
    (range) => {
      expect(metricsParamsSchema.parse({ range })).toEqual({ range });
    }
  );

  it('should accept custom range with date parameters', () => {
    expect(
      metricsParamsSchema.parse({
        range: 'custom',
        startDate: '2024-01-01',
        endDate: '2024-01-31',
      })
    ).toEqual({ range: 'custom', startDate: '2024-01-01', endDate: '2024-01-31' });
  });

  it('should reject invalid range', () => {
    expect(() =>
      metricsParamsSchema.parse({ range: 'invalid' })
    ).toThrow();
  });

  it('should reject invalid date format', () => {
    expect(() =>
      metricsParamsSchema.parse({
        range: 'custom',
        startDate: 'not-a-date',
        endDate: '2024-01-31',
      })
    ).toThrow();
  });

  it('should accept a same-day custom range (diffDays === 0)', () => {
    expect(
      metricsParamsSchema.parse({
        range: 'custom',
        startDate: '2024-01-15',
        endDate: '2024-01-15',
      })
    ).toEqual({ range: 'custom', startDate: '2024-01-15', endDate: '2024-01-15' });
  });

  it('should accept a range of exactly MAX_DATE_RANGE_DAYS', () => {
    const startDate = '2024-01-01';
    const msPerDay = 86_400_000;
    const end = new Date(
      new Date(startDate).getTime() + VALIDATION_LIMITS.maxDateRangeDays * msPerDay,
    );
    const endDate = end.toISOString().slice(0, 10);
    expect(
      metricsParamsSchema.parse({ range: 'custom', startDate, endDate }),
    ).toEqual({ range: 'custom', startDate, endDate });
  });

  it('should reject a range of MAX_DATE_RANGE_DAYS + 1', () => {
    const startDate = '2024-01-01';
    const msPerDay = 86_400_000;
    const end = new Date(
      new Date(startDate).getTime() + (VALIDATION_LIMITS.maxDateRangeDays + 1) * msPerDay,
    );
    const endDate = end.toISOString().slice(0, 10);
    expect(() =>
      metricsParamsSchema.parse({ range: 'custom', startDate, endDate }),
    ).toThrow(/exceed/i);
  });

  it('should reject when endDate is before startDate', () => {
    expect(() =>
      metricsParamsSchema.parse({
        range: 'custom',
        startDate: '2024-01-31',
        endDate: '2024-01-01',
      }),
    ).toThrow(/end date must be after start/i);
  });

  it('should attach startDate error when custom range omits startDate', () => {
    const result = metricsParamsSchema.safeParse({
      range: 'custom',
      endDate: '2024-01-31',
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const issue = result.error.issues.find((i) => i.path[0] === 'startDate');
      expect(issue?.message).toMatch(/start date is required/i);
    }
  });

  it('should attach endDate error when custom range omits endDate', () => {
    const result = metricsParamsSchema.safeParse({
      range: 'custom',
      startDate: '2024-01-01',
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const issue = result.error.issues.find((i) => i.path[0] === 'endDate');
      expect(issue?.message).toMatch(/end date is required/i);
    }
  });

  it('should attach endDate error with YYYY-MM-DD format message when endDate is malformed', () => {
    const result = metricsParamsSchema.safeParse({
      range: 'custom',
      startDate: '2024-01-01',
      endDate: 'nope',
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const issue = result.error.issues.find((i) => i.path[0] === 'endDate');
      expect(issue?.message).toMatch(/YYYY-MM-DD/);
    }
  });

  it('should attach diff errors to the endDate path', () => {
    const result = metricsParamsSchema.safeParse({
      range: 'custom',
      startDate: '2024-01-31',
      endDate: '2024-01-01',
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const issue = result.error.issues.find((i) =>
        /end date must be after start/i.test(i.message),
      );
      expect(issue?.path).toEqual(['endDate']);
    }
  });
});

describe('tracesParamsSchema', () => {
  it('should validate correct params and return the coerced shape', () => {
    expect(
      tracesParamsSchema.parse({
        limit: 50,
        offset: 0,
        startDate: '2024-01-01',
        endDate: '2024-01-31',
        model: 'gpt-4',
        status: 'OK',
      }),
    ).toEqual({
      limit: 50,
      offset: 0,
      startDate: '2024-01-01',
      endDate: '2024-01-31',
      model: 'gpt-4',
      status: 'OK',
    });
  });

  it('should apply limit/offset defaults when omitted', () => {
    // Catches a dropped `.default(...)` — which a `.not.toThrow()` check on a
    // fully-specified input would never notice.
    expect(tracesParamsSchema.parse({})).toEqual({
      limit: VALIDATION_LIMITS.defaultTracesLimit,
      offset: 0,
    });
  });

  it('should coerce string limit/offset to numbers', () => {
    // Catches removal of `z.coerce` — query-string params arrive as strings.
    expect(tracesParamsSchema.parse({ limit: '25', offset: '5' })).toEqual({
      limit: 25,
      offset: 5,
    });
  });

  it('should enforce limit bounds', () => {
    expect(() =>
      tracesParamsSchema.parse({ limit: 0 })
    ).toThrow();

    expect(() =>
      tracesParamsSchema.parse({ limit: VALIDATION_LIMITS.maxTracesLimit + 1 })
    ).toThrow();
  });

  it('should enforce offset bounds', () => {
    expect(() =>
      tracesParamsSchema.parse({ offset: -1 })
    ).toThrow();
  });

  it.each(['OK', 'ERROR'] as const)(
    'should accept %s status value and preserve it',
    (status) => {
      expect(tracesParamsSchema.parse({ status }).status).toBe(status);
    }
  );

  it('should reject invalid status value', () => {
    expect(() =>
      tracesParamsSchema.parse({ status: 'INVALID' })
    ).toThrow();
  });
});

describe('percentilesParamsSchema', () => {
  it('should validate correct params and merge both schema halves', () => {
    // percentilesParamsSchema is an intersection (date-range AND { metric }).
    // toEqual proves both halves survive the merge, not just that it parses.
    expect(
      percentilesParamsSchema.parse({ range: '7d', metric: 'latency' }),
    ).toEqual({ range: '7d', metric: 'latency' });
  });

  it.each(['latency', 'inputTokens', 'outputTokens', 'totalTokens'] as const)(
    'should accept %s metric value and preserve it',
    (metric) => {
      expect(percentilesParamsSchema.parse({ range: '7d', metric }).metric).toBe(metric);
    }
  );

  it('should reject invalid metric value', () => {
    expect(() =>
      percentilesParamsSchema.parse({ range: '7d', metric: 'invalid' })
    ).toThrow();
  });
});

describe('traceIdSchema', () => {
  it('should validate non-empty strings', () => {
    expect(traceIdSchema.parse('some-trace-id')).toBe('some-trace-id');
  });

  it('should reject empty strings', () => {
    expect(() => traceIdSchema.parse('')).toThrow();
  });
});

describe('validateInput', () => {
  it('should return validated data on success', async () => {
    const result = await validateInput(metricsParamsSchema, { range: '7d' });
    expect(result).toEqual({ range: '7d' });
  });

  it('should throw ValidationError on failure', async () => {
    await expect(
      validateInput(metricsParamsSchema, { range: 'invalid' })
    ).rejects.toThrow(ValidationError);
  });

  it('should include field name in error message', async () => {
    try {
      await validateInput(tracesParamsSchema, { limit: -1 });
      fail('Should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(ValidationError);
      expect((error as ValidationError).message.toLowerCase()).toContain('limit');
    }
  });

  it('should set ValidationError.field to the path of the first issue', async () => {
    try {
      await validateInput(tracesParamsSchema, { limit: -1 });
      fail('Should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(ValidationError);
      expect((error as ValidationError).field).toBe('limit');
    }
  });

  it('should populate ValidationError.details with path → message entries', async () => {
    try {
      await validateInput(tracesParamsSchema, { limit: -1 });
      fail('Should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(ValidationError);
      const details = (error as ValidationError).details;
      expect(details?.limit).toBe('Limit must be at least 1');
    }
  });

  it('should leave ValidationError.details undefined when no issues have paths', async () => {
    try {
      await validateInput(z.string(), 42);
      fail('Should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(ValidationError);
      expect((error as ValidationError).details).toBeUndefined();
    }
  });
});

describe('parseFilters', () => {
  describe('basic parsing', () => {
    it('should return undefined when filtersParam is undefined', () => {
      expect(parseFilters(undefined)).toBeUndefined();
    });

    it('should return undefined when filtersParam is empty string', () => {
      expect(parseFilters('')).toBeUndefined();
    });

    it('should parse valid JSON array of filters', () => {
      const filters = JSON.stringify([
        { field: 'output', operator: 'contains', value: 'test' },
      ]);
      const result = parseFilters(filters);
      expect(result).toHaveLength(1);
      expect(result![0]).toEqual({
        field: 'output',
        operator: 'contains',
        value: 'test',
      });
    });

    it('should parse multiple filters', () => {
      const filters = JSON.stringify([
        { field: 'output', operator: 'contains', value: 'hello' },
        { field: 'input', operator: 'contains', value: 'world' },
      ]);
      const result = parseFilters(filters);
      expect(result).toHaveLength(2);
    });
  });

  describe('field validation', () => {
    it('should accept all allowed filter fields', () => {
      for (const field of ALLOWED_FILTER_FIELDS) {
        const filters = JSON.stringify([
          { field, operator: 'contains', value: 'test' },
        ]);
        const result = parseFilters(filters);
        expect(result).toHaveLength(1);
        expect(result?.[0]?.field).toBe(field.toLowerCase());
      }
    });

    it('should skip filters with unknown fields silently', () => {
      const filters = JSON.stringify([
        { field: 'unknown_field', operator: 'contains', value: 'test' },
        { field: 'output', operator: 'contains', value: 'valid' },
      ]);
      const result = parseFilters(filters);
      expect(result).toHaveLength(1);
      expect(result?.[0]?.field).toBe('output');
    });

    it('should lowercase field names', () => {
      const filters = JSON.stringify([
        { field: 'OUTPUT', operator: 'contains', value: 'test' },
      ]);
      const result = parseFilters(filters);
      expect(result?.[0]?.field).toBe('output');
    });
  });

  describe('operator validation', () => {
    it('should accept all allowed operators', () => {
      for (const operator of ALLOWED_FILTER_OPERATORS) {
        const filters = JSON.stringify([
          { field: 'output', operator, value: 'test' },
        ]);
        const result = parseFilters(filters);
        expect(result).toHaveLength(1);
        expect(result?.[0]?.operator).toBe(operator.toLowerCase());
      }
    });

    it('should default to equals operator when not provided', () => {
      const filters = JSON.stringify([
        { field: 'output', value: 'test' },
      ]);
      const result = parseFilters(filters);
      expect(result?.[0]?.operator).toBe('equals');
    });

    it('should default to equals operator for invalid operator', () => {
      const filters = JSON.stringify([
        { field: 'output', operator: 'invalid_op', value: 'test' },
      ]);
      const result = parseFilters(filters);
      expect(result?.[0]?.operator).toBe('equals');
    });

    it('should default to equals when operator is a non-string type', () => {
      const filters = JSON.stringify([
        { field: 'output', operator: 123, value: 'test' },
      ]);
      const result = parseFilters(filters);
      expect(result?.[0]?.operator).toBe('equals');
    });
  });

  describe('non-object filter entries', () => {
    it('should skip null entries and keep valid filters in the same array', () => {
      const filters = JSON.stringify([
        null,
        { field: 'output', operator: 'contains', value: 'keep' },
      ]);
      const result = parseFilters(filters);
      expect(result).toHaveLength(1);
      expect(result?.[0]?.value).toBe('keep');
    });

    it('should skip primitive entries and keep valid filters in the same array', () => {
      const filters = JSON.stringify([
        'not-a-filter',
        42,
        { field: 'output', operator: 'contains', value: 'keep' },
      ]);
      const result = parseFilters(filters);
      expect(result).toHaveLength(1);
      expect(result?.[0]?.value).toBe('keep');
    });
  });

  describe('score field validation', () => {
    it('should accept a well-formed score field', () => {
      const filters = JSON.stringify([
        { field: 'score__accuracy', operator: 'gt', value: 0.5 },
      ]);
      const result = parseFilters(filters);
      expect(result).toHaveLength(1);
      expect(result?.[0]?.field).toBe('score__accuracy');
    });

    it('should skip a score field whose name fails the identifier regex', () => {
      // score__ followed by a digit fails /^score__[a-zA-Z_].../
      const filters = JSON.stringify([
        { field: 'score__1invalid', operator: 'gt', value: 0.5 },
      ]);
      const result = parseFilters(filters);
      expect(result).toBeUndefined();
    });

    it('should skip a field that ends with score__ but does not start with it', () => {
      const filters = JSON.stringify([
        { field: 'prefix_score__', operator: 'gt', value: 0.5 },
      ]);
      const result = parseFilters(filters);
      expect(result).toBeUndefined();
    });
  });

  describe('value validation', () => {
    it('should skip filters with empty value', () => {
      const filters = JSON.stringify([
        { field: 'output', operator: 'contains', value: '' },
      ]);
      const result = parseFilters(filters);
      expect(result).toBeUndefined();
    });

    it('should skip filters with null value', () => {
      const filters = JSON.stringify([
        { field: 'output', operator: 'contains', value: null },
      ]);
      const result = parseFilters(filters);
      expect(result).toBeUndefined();
    });

    it('should skip filters with undefined value', () => {
      const filters = JSON.stringify([
        { field: 'output', operator: 'contains' },
      ]);
      const result = parseFilters(filters);
      expect(result).toBeUndefined();
    });

    it('should convert numeric values to strings', () => {
      const filters = JSON.stringify([
        { field: 'cost', operator: 'gt', value: 100 },
      ]);
      const result = parseFilters(filters);
      expect(result?.[0]?.value).toBe('100');
    });

    it('should throw ValidationError when value exceeds maximum length', () => {
      const longValue = 'a'.repeat(501);
      const filters = JSON.stringify([
        { field: 'output', operator: 'contains', value: longValue },
      ]);
      expect(() => parseFilters(filters)).toThrow(ValidationError);
    });
  });

  describe('security', () => {
    it('should throw ValidationError for invalid JSON', () => {
      expect(() => parseFilters('not valid json')).toThrow(ValidationError);
    });

    it('should throw ValidationError when filters is not an array', () => {
      expect(() => parseFilters('{"field": "output"}')).toThrow(ValidationError);
    });

    it('should throw ValidationError when exceeding max filter count', () => {
      const manyFilters = Array(11).fill({ field: 'output', operator: 'contains', value: 'test' });
      expect(() => parseFilters(JSON.stringify(manyFilters))).toThrow(ValidationError);
    });

    it('should skip non-object filters silently', () => {
      const filters = JSON.stringify([
        'invalid',
        null,
        123,
        { field: 'output', operator: 'contains', value: 'valid' },
      ]);
      const result = parseFilters(filters);
      expect(result).toHaveLength(1);
    });

    it('should skip filters with non-string field', () => {
      const filters = JSON.stringify([
        { field: 123, operator: 'contains', value: 'test' },
        { field: 'output', operator: 'contains', value: 'valid' },
      ]);
      const result = parseFilters(filters);
      expect(result).toHaveLength(1);
    });
  });

  describe('requests specific fields', () => {
    it('should accept input field filter', () => {
      const filters = JSON.stringify([
        { field: 'input', operator: 'contains', value: 'user query' },
      ]);
      const result = parseFilters(filters);
      expect(result?.[0]?.field).toBe('input');
    });

    it('should accept output field filter', () => {
      const filters = JSON.stringify([
        { field: 'output', operator: 'contains', value: 'response' },
      ]);
      const result = parseFilters(filters);
      expect(result?.[0]?.field).toBe('output');
    });

    it('should accept trace_id field filter', () => {
      const filters = JSON.stringify([
        { field: 'trace_id', operator: 'equals', value: 'abc123' },
      ]);
      const result = parseFilters(filters);
      expect(result?.[0]?.field).toBe('trace_id');
    });

    it('should accept cost field filter', () => {
      const filters = JSON.stringify([
        { field: 'cost', operator: 'gt', value: '0.01' },
      ]);
      const result = parseFilters(filters);
      expect(result?.[0]?.field).toBe('cost');
    });

    it('should accept latency field filter', () => {
      const filters = JSON.stringify([
        { field: 'latency', operator: 'lt', value: '1000' },
      ]);
      const result = parseFilters(filters);
      expect(result?.[0]?.field).toBe('latency');
    });
  });

  describe('new filter fields: session_id and tags', () => {
    it('should accept session_id as a valid filter field', () => {
      const filters = JSON.stringify([
        { field: 'session_id', operator: 'equals', value: 'sess-123' },
      ]);
      const result = parseFilters(filters);
      expect(result).toHaveLength(1);
      expect(result?.[0]?.field).toBe('session_id');
    });

    it('should accept tags as a valid filter field', () => {
      const filters = JSON.stringify([
        { field: 'tags', operator: 'equals', value: 'production' },
      ]);
      const result = parseFilters(filters);
      expect(result).toHaveLength(1);
      expect(result?.[0]?.field).toBe('tags');
    });
  });

  describe('existence operators', () => {
    it('should accept exists as a valid operator', () => {
      const filters = JSON.stringify([
        { field: 'metadata.environment', operator: 'exists', value: '' },
      ]);
      const result = parseFilters(filters);
      expect(result).toHaveLength(1);
      expect(result?.[0]?.operator).toBe('exists');
    });

    it('should accept doesNotExist as a valid operator', () => {
      const filters = JSON.stringify([
        { field: 'metadata.tag', operator: 'doesNotExist', value: '' },
      ]);
      const result = parseFilters(filters);
      expect(result).toHaveLength(1);
      expect(result?.[0]?.operator).toBe('doesnotexist');
    });

    it('should accept does_not_exist as a valid operator alias', () => {
      const filters = JSON.stringify([
        { field: 'metadata.env', operator: 'does_not_exist', value: '' },
      ]);
      const result = parseFilters(filters);
      expect(result).toHaveLength(1);
      expect(result?.[0]?.operator).toBe('does_not_exist');
    });

    it('should not require a value for exists operator', () => {
      const filters = JSON.stringify([
        { field: 'metadata.tag', operator: 'exists' },
      ]);
      const result = parseFilters(filters);
      expect(result).toHaveLength(1);
      expect(result?.[0]?.value).toBe('');
    });

    it('should not require a value for doesNotExist operator', () => {
      const filters = JSON.stringify([
        { field: 'metadata.tag', operator: 'doesNotExist' },
      ]);
      const result = parseFilters(filters);
      expect(result).toHaveLength(1);
      expect(result?.[0]?.value).toBe('');
    });
  });
});

describe('tracesParamsSchema sort fields', () => {
  it('should accept sortBy and sortOrder', () => {
    const valid = {
      limit: 50,
      offset: 0,
      sortBy: 'latency',
      sortOrder: 'desc',
    };

    expect(tracesParamsSchema.parse(valid)).toEqual(valid);
  });

  it.each([...ALLOWED_SORT_FIELDS_TRACES])(
    'should accept %s as a valid sortBy value and preserve it',
    (sortBy) => {
      expect(tracesParamsSchema.parse({ sortBy }).sortBy).toBe(sortBy);
    }
  );

  it('should reject invalid sortBy value', () => {
    expect(() =>
      tracesParamsSchema.parse({ sortBy: 'invalid_column' })
    ).toThrow();
  });

  it('should reject invalid sortOrder value', () => {
    expect(() =>
      tracesParamsSchema.parse({ sortOrder: 'random' })
    ).toThrow();
  });
});
