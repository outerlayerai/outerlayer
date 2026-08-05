/**
 * Unit tests for the full-text search (searchQuery) path in getCachedTraces.
 *
 * When a searchQuery is supplied, getCachedTraces must convert it into an
 * AnalyticsFilterOrGroup { or: [input-contains, output-contains] } so the
 * ClickHouse layer matches either the input OR output field.  These tests pin
 * the exact shape passed to getTraces, killing the ConditionalExpression /
 * ArrayDeclaration / ObjectLiteral / EqualityOperator mutants on the
 * construction path.
 */
// @vitest-environment node

import { describe, it, expect, beforeEach, vi } from 'vitest';

// Pass-through stub so the inner function is exercised directly.
vi.mock('next/cache', () => ({
  unstable_cache: <T extends (...args: unknown[]) => unknown>(fn: T): T => fn,
}));

const mockGetTraces = vi.fn();

vi.mock('../service', () => ({
  getAnalyticsService: () => ({
    getTraces: mockGetTraces,
  }),
}));

import { getCachedTraces } from '../cache';
import type { TenantContext } from '../tenant-context';

const ctx = {
  userId: 'u1',
  tenantId: 't1',
  appId: 'app-1',
  dataRetentionDays: -1,
} as unknown as TenantContext;

/** Call getCachedTraces with only searchQuery varied; all other args default. */
function callWithSearch(searchQuery?: string) {
  return getCachedTraces(
    ctx,
    50,  // limit
    0,   // offset
    undefined, undefined, undefined, undefined, undefined,
    undefined, // filters
    undefined, undefined, undefined,
    false,     // environmentIsDefault
    undefined, // environments
    searchQuery,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mockGetTraces.mockResolvedValue({ traces: [], total: 0 });
});

describe('getCachedTraces — searchQuery OR-group construction', () => {
  it('passes no filters when searchQuery is undefined', async () => {
    await callWithSearch(undefined);

    const [, params] = mockGetTraces.mock.calls[0]!;
    expect(params.filters).toBeUndefined();
  });

  it('passes no filters when searchQuery is an empty string', async () => {
    await callWithSearch('');

    const [, params] = mockGetTraces.mock.calls[0]!;
    expect(params.filters).toBeUndefined();
  });

  it('builds an OR-group with input+output when searchQuery is provided', async () => {
    await callWithSearch('hello world');

    const [, params] = mockGetTraces.mock.calls[0]!;
    expect(params.filters).toEqual([
      {
        or: [
          { field: 'input', operator: 'contains', value: 'hello world' },
          { field: 'output', operator: 'contains', value: 'hello world' },
        ],
      },
    ]);
  });

  it('OR-group carries the exact query value (not a truncated or case-folded form)', async () => {
    await callWithSearch('MySpecificQuery123');

    const [, params] = mockGetTraces.mock.calls[0]!;
    const orGroup = params.filters![0];
    expect(orGroup.or[0].value).toBe('MySpecificQuery123');
    expect(orGroup.or[1].value).toBe('MySpecificQuery123');
  });

  it('OR-group has exactly two branches: input first, output second', async () => {
    await callWithSearch('test');

    const [, params] = mockGetTraces.mock.calls[0]!;
    const orGroup = params.filters![0];
    expect(orGroup.or).toHaveLength(2);
    expect(orGroup.or[0].field).toBe('input');
    expect(orGroup.or[1].field).toBe('output');
  });

  it('both OR branches use the contains operator', async () => {
    await callWithSearch('test');

    const [, params] = mockGetTraces.mock.calls[0]!;
    const orGroup = params.filters![0];
    expect(orGroup.or[0].operator).toBe('contains');
    expect(orGroup.or[1].operator).toBe('contains');
  });
});

describe('getCachedTraces — searchQuery combined with explicit filters', () => {
  it('prepends the OR-group before explicit filters', async () => {
    const explicit = [{ field: 'model', operator: 'equals', value: 'gpt-4' }];
    await getCachedTraces(
      ctx, 50, 0, undefined, undefined, undefined, undefined, undefined,
      explicit, undefined, undefined, undefined, false, undefined, 'foo',
    );

    const [, params] = mockGetTraces.mock.calls[0]!;
    expect(params.filters).toHaveLength(2);
    expect(params.filters![0]).toMatchObject({ or: expect.any(Array) });
    expect(params.filters![1]).toEqual(explicit[0]);
  });

  it('passes only explicit filters when searchQuery is absent', async () => {
    const explicit = [{ field: 'model', operator: 'equals', value: 'gpt-4' }];
    await getCachedTraces(
      ctx, 50, 0, undefined, undefined, undefined, undefined, undefined,
      explicit, undefined, undefined, undefined, false, undefined, undefined,
    );

    const [, params] = mockGetTraces.mock.calls[0]!;
    expect(params.filters).toEqual(explicit);
  });

  it('passes filters=undefined when neither searchQuery nor explicit filters present', async () => {
    await getCachedTraces(
      ctx, 50, 0, undefined, undefined, undefined, undefined, undefined,
      undefined, undefined, undefined, undefined, false, undefined, undefined,
    );

    const [, params] = mockGetTraces.mock.calls[0]!;
    expect(params.filters).toBeUndefined();
  });
});
