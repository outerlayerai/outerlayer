/**
 * Unit tests for the JSON filter validator + search-window guardrails.
 *
 * The properties these tests pin (mirroring the DSL parser's test contract):
 *  1. A valid filter list normalizes to the EXACT `AnalyticsFilterNode[]`
 *     the SQL compilers expect (canonical operator, string/string[] values,
 *     datetimes in ClickHouse format).
 *  2. Anything semantically invalid THROWS FilterParseError with a specific
 *     message — never silently dropped.
 *  3. The discovery payload is generated from the same tables, so what it
 *     advertises is accepted by the validator.
 */

import { describe, it, expect } from 'vitest';
import {
  validateSearchFilters,
  resolveSearchWindow,
  MAX_SEARCH_WINDOW_DAYS,
} from './filter-validation';
import { buildFilterSchemaPayload } from '@repo/api-schemas';
import { FilterParseError, parseFilterExpression } from './trace-filter-dsl';

describe('validateSearchFilters — normalization', () => {
  it('returns undefined for missing or empty filters', () => {
    expect(validateSearchFilters(undefined, 'traces')).toBeUndefined();
    expect(validateSearchFilters([], 'traces')).toBeUndefined();
  });

  it('passes a valid leaf through verbatim', () => {
    expect(
      validateSearchFilters([{ field: 'model', operator: 'equals', value: 'gpt-4o' }], 'traces'),
    ).toEqual([{ field: 'model', operator: 'equals', value: 'gpt-4o' }]);
  });

  it('coerces numeric values to strings (the AST value type)', () => {
    expect(
      validateSearchFilters([{ field: 'cost', operator: 'gt', value: 0.01 }], 'traces'),
    ).toEqual([{ field: 'cost', operator: 'gt', value: '0.01' }]);
  });

  it('normalizes in lists to string arrays', () => {
    expect(
      validateSearchFilters(
        [{ field: 'prompt_tokens', operator: 'in', value: [100, 200] }],
        'traces',
      ),
    ).toEqual([{ field: 'prompt_tokens', operator: 'in', value: ['100', '200'] }]);
  });

  it('normalizes exists to an empty value', () => {
    expect(
      validateSearchFilters([{ field: 'metadata.env', operator: 'exists' }], 'traces'),
    ).toEqual([{ field: 'metadata.env', operator: 'exists', value: '' }]);
  });

  it('unwraps a one-member OR group to a plain leaf', () => {
    expect(
      validateSearchFilters(
        [{ or: [{ field: 'status', operator: 'equals', value: 'ERROR' }] }],
        'traces',
      ),
    ).toEqual([{ field: 'status', operator: 'equals', value: 'ERROR' }]);
  });

  it('keeps multi-member OR groups as { or } nodes, members normalized', () => {
    expect(
      validateSearchFilters(
        [
          {
            or: [
              { field: 'model', operator: 'equals', value: 'gpt-4o' },
              { field: 'latency_ms', operator: 'between', value: [1000, 5000] },
            ],
          },
        ],
        'spans',
      ),
    ).toEqual([
      {
        or: [
          { field: 'model', operator: 'equals', value: 'gpt-4o' },
          { field: 'latency_ms', operator: 'between', value: ['1000', '5000'] },
        ],
      },
    ]);
  });

  it('converts scores created_at values to ClickHouse datetime format', () => {
    const result = validateSearchFilters(
      [{ field: 'created_at', operator: 'gte', value: '2026-06-01T00:00:00.000Z' }],
      'scores',
    );
    expect(result).toEqual([
      { field: 'created_at', operator: 'gte', value: '2026-06-01 00:00:00.000' },
    ]);
  });
});

describe('validateSearchFilters — rejections (400 surface)', () => {
  const traceCases: Array<[string, Parameters<typeof validateSearchFilters>[0], RegExp]> = [
    ['unknown field', [{ field: 'foobar', operator: 'equals', value: 'x' }], /unknown filter field/i],
    ['operator invalid for kind', [{ field: 'status', operator: 'in', value: ['OK'] }], /not valid for status field/i],
    ['contains on numeric', [{ field: 'cost', operator: 'contains', value: '1' }], /not valid for numeric field/i],
    ['non-numeric value', [{ field: 'cost', operator: 'equals', value: 'abc' }], /numeric value/i],
    ['hex number (parseFloat divergence)', [{ field: 'cost', operator: 'equals', value: '0x10' }], /numeric value/i],
    ['invalid status value', [{ field: 'status', operator: 'equals', value: 'WEIRD' }], /invalid status value/i],
    ['invalid metadata key', [{ field: 'metadata.a.b', operator: 'exists' }], /invalid metadata key/i],
    ['invalid score name', [{ field: 'score__', operator: 'gt', value: '1' }], /invalid score name/i],
    ['exists with a value', [{ field: 'metadata.env', operator: 'exists', value: 'x' }], /takes no value/i],
    ['in with scalar value', [{ field: 'model', operator: 'in', value: 'gpt-4o' }], /non-empty list/i],
    ['in with empty list', [{ field: 'model', operator: 'in', value: [] }], /non-empty list/i],
    ['in list member wrong kind', [{ field: 'cost', operator: 'in', value: ['1', 'abc'] }], /numeric value/i],
    ['between with wrong arity', [{ field: 'cost', operator: 'between', value: [1] }], /exactly \[min, max\]/i],
    ['between with scalar', [{ field: 'cost', operator: 'between', value: 5 }], /exactly \[min, max\]/i],
    ['scalar op with list value', [{ field: 'model', operator: 'equals', value: ['a'] }], /single value/i],
    ['empty scalar value', [{ field: 'model', operator: 'equals', value: '' }], /empty value/i],
  ];

  it.each(traceCases)('throws on %s', (_label, filters, messageRe) => {
    expect(() => validateSearchFilters(filters, 'traces')).toThrow(FilterParseError);
    expect(() => validateSearchFilters(filters, 'traces')).toThrow(messageRe);
  });

  it('rejects trace-side fields on the scores resource (no cross-surface leakage)', () => {
    expect(() =>
      validateSearchFilters([{ field: 'model', operator: 'equals', value: 'x' }], 'scores'),
    ).toThrow(/unknown scores filter field/i);
    expect(() =>
      validateSearchFilters([{ field: 'metadata.env', operator: 'exists' }], 'scores'),
    ).toThrow(/unknown scores filter field/i);
  });

  it('rejects equality on the scores created_at (range ops only)', () => {
    expect(() =>
      validateSearchFilters(
        [{ field: 'created_at', operator: 'equals', value: '2026-06-01T00:00:00Z' }],
        'scores',
      ),
    ).toThrow(/not valid for datetime field/i);
  });

  it('rejects an unparseable datetime on scores created_at', () => {
    expect(() =>
      validateSearchFilters(
        [{ field: 'created_at', operator: 'gte', value: 'not-a-date' }],
        'scores',
      ),
    ).toThrow(/ISO-8601 datetime/i);
  });

  it('counts grouped leaves against the predicate cap', () => {
    const leaf = { field: 'cost', operator: 'equals' as const, value: '1' };
    const nodes = [
      { or: Array.from({ length: 10 }, () => ({ ...leaf })) },
      { or: Array.from({ length: 11 }, () => ({ ...leaf })) },
    ];
    expect(() => validateSearchFilters(nodes, 'traces')).toThrow(/too many filter predicates/i);
  });

  it('rejects a single oversized OR-group through the SAME invalid_filter path', () => {
    // The group-member schema deliberately has no shape-level cap, so a
    // 21-member group reaches this validator and fails identically to
    // 11+10 split across two groups — one error surface for one violation.
    const leaf = { field: 'cost', operator: 'equals' as const, value: '1' };
    const nodes = [{ or: Array.from({ length: 21 }, () => ({ ...leaf })) }];
    expect(() => validateSearchFilters(nodes, 'traces')).toThrow(FilterParseError);
    expect(() => validateSearchFilters(nodes, 'traces')).toThrow(/too many filter predicates/i);
  });
});

describe('resolveSearchWindow', () => {
  it('defaults to a 7-day lookback ending now', () => {
    const before = Date.now();
    const { startDate, endDate } = resolveSearchWindow();
    const after = Date.now();
    const start = Date.parse(startDate);
    const end = Date.parse(endDate);
    expect(end).toBeGreaterThanOrEqual(before);
    expect(end).toBeLessThanOrEqual(after);
    expect(end - start).toBe(7 * 24 * 60 * 60 * 1_000);
  });

  it('anchors the default lookback to an explicit end_date', () => {
    const { startDate, endDate } = resolveSearchWindow(undefined, '2026-06-10T00:00:00.000Z');
    expect(endDate).toBe('2026-06-10T00:00:00.000Z');
    expect(startDate).toBe('2026-06-03T00:00:00.000Z');
  });

  it('passes an explicit valid window through', () => {
    const { startDate, endDate } = resolveSearchWindow(
      '2026-06-01T00:00:00.000Z',
      '2026-06-10T00:00:00.000Z',
    );
    expect(startDate).toBe('2026-06-01T00:00:00.000Z');
    expect(endDate).toBe('2026-06-10T00:00:00.000Z');
  });

  it('rejects an inverted window', () => {
    expect(() =>
      resolveSearchWindow('2026-06-10T00:00:00Z', '2026-06-01T00:00:00Z'),
    ).toThrow(/start_date must not be after end_date/i);
  });

  it('rejects a window over the maximum, and accepts exactly the maximum', () => {
    expect(() =>
      resolveSearchWindow('2026-01-01T00:00:00Z', '2026-06-01T00:00:00Z'),
    ).toThrow(new RegExp(`max ${MAX_SEARCH_WINDOW_DAYS} days`));
    // 90 days exactly — boundary is inclusive, window passes through verbatim.
    expect(
      resolveSearchWindow('2026-01-01T00:00:00Z', '2026-03-31T23:59:59Z'),
    ).toEqual({
      startDate: '2026-01-01T00:00:00.000Z',
      endDate: '2026-03-31T23:59:59.000Z',
    });
  });
});

describe('buildFilterSchemaPayload', () => {
  it('advertises exactly what the validator accepts', () => {
    const payload = buildFilterSchemaPayload();

    // Spot-check the shape plus a few entries the SQL compilers depend on.
    const model = payload.resources.traces.fields.find((f) => f.name === 'model');
    expect(model).toEqual({
      name: 'model',
      kind: 'string',
      operators: expect.arrayContaining(['equals', 'contains', 'in', 'notIn']),
    });

    const status = payload.resources.traces.fields.find((f) => f.name === 'status');
    expect(status?.operators).toEqual(['equals']);

    const createdAt = payload.resources.scores.fields.find((f) => f.name === 'created_at');
    expect(createdAt?.operators).toEqual(expect.arrayContaining(['gte', 'between']));
    expect(createdAt?.operators).not.toContain('equals');

    expect(payload.resources.traces.dynamic_fields.map((d) => d.pattern)).toEqual([
      'metadata.<key>',
      'score__<name>',
    ]);
    expect(payload.resources.spans).toEqual(payload.resources.traces);
    expect(payload.resources.traces.limits).toEqual({ max_predicates: 20, max_in_values: 50 });

    // Every advertised (field, operator) pair must validate. This is the
    // no-drift guarantee the discovery endpoint exists to provide.
    const sample: Record<string, string | string[]> = {
      string: 'x', numeric: '1', status: 'ERROR', tags: 'prod', datetime: '2026-06-01T00:00:00Z',
    };
    for (const [resource, schema] of Object.entries(payload.resources)) {
      for (const f of schema.fields) {
        for (const op of f.operators) {
          const value =
            op === 'between' ? [sample[f.kind]!, sample[f.kind]!].flat()
            : op === 'in' || op === 'notIn' ? [sample[f.kind]!].flat()
            : op === 'exists' || op === 'doesNotExist' ? undefined
            : sample[f.kind]!;
          // Concrete shape assertion: one validated node comes back out.
          const validated = validateSearchFilters(
            [{ field: f.name, operator: op as never, value }],
            resource as never,
          );
          expect(validated).toHaveLength(1);
          expect(validated![0]).toEqual(
            expect.objectContaining({ field: f.name, operator: op }),
          );
        }
      }

      // Dynamic fields: exercise one representative concrete field per
      // advertised pattern — metadata.<key> and score__<name> are half the
      // real-world filter surface and must not drift either.
      const dynamicSamples: Record<string, { field: string; kind: string }> = {
        'metadata.<key>': { field: 'metadata.env', kind: 'string' },
        'score__<name>': { field: 'score__correctness', kind: 'numeric' },
      };
      for (const d of schema.dynamic_fields) {
        const rep = dynamicSamples[d.pattern];
        if (!rep) throw new Error(`no representative sample for dynamic pattern ${d.pattern}`);
        for (const op of d.operators) {
          const value =
            op === 'between' ? [sample[rep.kind]!, sample[rep.kind]!].flat()
            : op === 'in' || op === 'notIn' ? [sample[rep.kind]!].flat()
            : op === 'exists' || op === 'doesNotExist' ? undefined
            : sample[rep.kind]!;
          const validated = validateSearchFilters(
            [{ field: rep.field, operator: op as never, value }],
            resource as never,
          );
          expect(validated).toHaveLength(1);
          expect(validated![0]).toEqual(
            expect.objectContaining({ field: rep.field, operator: op }),
          );
        }
      }
    }
  });
});

// A field name is a plain string off the request body, and the allowlist
// answers it. Only keys the allowlist owns may resolve; anything else is a
// 400, not a 500 from a downstream lookup on a bogus kind.
describe('inherited Object members are not filter fields', () => {
  const INHERITED = ['constructor', '__proto__', 'toString', 'hasOwnProperty', 'valueOf'];

  it.each(INHERITED)('rejects %s on traces with a 400-shaped parse error', inherited => {
    expect(() =>
      validateSearchFilters([{ field: inherited, operator: 'equals', value: 'x' }], 'traces'),
    ).toThrow(FilterParseError);
    expect(() =>
      validateSearchFilters([{ field: inherited, operator: 'equals', value: 'x' }], 'traces'),
    ).toThrow(/Unknown filter field/);
  });

  it.each(INHERITED)('rejects %s on scores with a 400-shaped parse error', inherited => {
    expect(() =>
      validateSearchFilters([{ field: inherited, operator: 'equals', value: 'x' }], 'scores'),
    ).toThrow(FilterParseError);
  });

  it.each(INHERITED)('rejects %s in the string DSL', inherited => {
    expect(() => parseFilterExpression(`${inherited}:x`)).toThrow(FilterParseError);
  });
});
