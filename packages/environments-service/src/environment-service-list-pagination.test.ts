/**
 * Regression — schemathesis OpenAPI Contract Fuzz found:
 *
 *   GET /v1/environments?offset=2 returned 500
 *     {"error":{"code":"internal_error","message":"Failed to list environments"}}
 *
 * Root cause: PostgREST returns `PGRST103` ("Requested range not satisfiable")
 * when `.range(offset, ...)` requests an offset beyond the result set. The
 * service was bubbling that as a generic error, which the route caught and
 * surfaced as 500.
 *
 * The contract for paginated list endpoints is 200 + empty `data: []` + real
 * `total`, matching how every other list route in the gateway behaves and how
 * REST pagination conventions work. This locks that behavior.
 */

import { describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

import { EnvironmentService } from './environment-service';

/**
 * Build a Supabase stub whose `.range()` call resolves with PGRST103, and
 * whose head-only follow-up resolves with an exact `count` (no rows).
 */
function stubSupabaseReturningPgrst103(actualCount: number): {
  client: SupabaseClient;
  headSelectCalls: Array<{ columns: string; options: unknown }>;
} {
  const headSelectCalls: Array<{ columns: string; options: unknown }> = [];

  const client = {
    from: vi.fn(() => ({
      select: vi.fn((columns: string, options: unknown) => {
        const isHeadOnly =
          typeof options === 'object' &&
          options !== null &&
          (options as Record<string, unknown>).head === true;

        if (isHeadOnly) {
          headSelectCalls.push({ columns, options });
          return {
            eq: vi.fn(() =>
              Promise.resolve({ count: actualCount, data: null, error: null }),
            ),
          };
        }

        // The paged read chain: .select(cols, {count:'exact'}).eq(...).order(...).order(...).range(...)
        // resolves to PGRST103 when offset is past the end.
        const chain: Record<string, unknown> = {};
        chain.eq = vi.fn(() => chain);
        chain.order = vi.fn(() => chain);
        chain.range = vi.fn(() =>
          Promise.resolve({
            data: null,
            count: null,
            error: {
              code: 'PGRST103',
              message:
                'Requested range not satisfiable: An offset of 2 was requested, but there are only 1 rows.',
              details: null,
              hint: null,
            },
          }),
        );
        return chain;
      }),
    })),
  } as unknown as SupabaseClient;

  return { client, headSelectCalls };
}

describe('EnvironmentService.listEnvironments — out-of-bounds offset', () => {
  it('returns empty rows + the true total when PostgREST raises PGRST103', async () => {
    const { client, headSelectCalls } = stubSupabaseReturningPgrst103(1);
    const service = new EnvironmentService({
      supabase: client,
    });

    const result = await service.listEnvironments(
      '22222222-2222-4222-8222-222222222222',
      { limit: 50, offset: 2 },
    );

    expect(result).toEqual({ rows: [], total: 1 });
    // The recovery path MUST hit a head-only follow-up — without it the
    // real count would be unknowable and we'd be lying to the client.
    expect(headSelectCalls).toHaveLength(1);
    expect(headSelectCalls[0]?.options).toMatchObject({
      count: 'exact',
      head: true,
    });
  });

  it('still propagates non-PGRST103 errors so genuine failures stay loud', async () => {
    const client = {
      from: vi.fn(() => ({
        select: vi.fn(() => {
          const chain: Record<string, unknown> = {};
          chain.eq = vi.fn(() => chain);
          chain.order = vi.fn(() => chain);
          chain.range = vi.fn(() =>
            Promise.resolve({
              data: null,
              count: null,
              error: {
                code: '42P01',
                message: 'relation "environment" does not exist',
                details: null,
                hint: null,
              },
            }),
          );
          return chain;
        }),
      })),
    } as unknown as SupabaseClient;

    const service = new EnvironmentService({
      supabase: client,
    });

    await expect(
      service.listEnvironments('22222222-2222-4222-8222-222222222222', {
        limit: 50,
        offset: 0,
      }),
    ).rejects.toThrow(/listEnvironments.*relation "environment" does not exist/);
  });
});
