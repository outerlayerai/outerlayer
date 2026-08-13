/**
 * Regression — manual-tester pr-preview-envs run (2026-06-19).
 *
 * The env-limit gate (`max_environments_per_app`) counted EVERY
 * `environment` row for the app, including ephemeral preview envs. A tenant
 * with several open PRs (each spinning up a system-created preview env) would
 * hit the cap and be refused creation of a legitimate persistent env — and on
 * a low cap, preview creation itself could be blocked. The cap governs the
 * durable envs a user owns, not transient PR previews.
 *
 * The fix adds `.eq('is_ephemeral', false)` to `countEnvironments`. This test
 * drives a Supabase stub that applies the recorded `.eq` filters against a
 * fixed dataset (3 ephemeral previews + 2 persistent envs) and asserts the
 * count handed to `checkEnvLimit` is 2 — the persistent envs only. The
 * smallest production change that breaks this test is dropping the ephemeral
 * filter, which is exactly the bug.
 */
import { describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

import {
  EnvironmentService,
  type CheckEnvLimitFn,
  type EnvironmentServiceDeps,
} from './environment-service';

// A fixed app population: 3 ephemeral previews + 2 persistent envs.
const ENV_ROWS = [
  { id: 'e1', is_ephemeral: true },
  { id: 'e2', is_ephemeral: true },
  { id: 'e3', is_ephemeral: true },
  { id: 'p1', is_ephemeral: false },
  { id: 'p2', is_ephemeral: false },
];

/**
 * Supabase stub whose `environment` count query honors the chained `.eq`
 * filters. `countEnvironments` issues `.select('id', {count, head}).eq('app_id',
 * ...).eq('is_ephemeral', false)` and awaits the builder — so the builder is a
 * thenable that, when awaited, filters ENV_ROWS by the accumulated eq() pairs
 * and resolves `{ count, error }`.
 */
function stubSupabase(eqCalls: Array<[string, unknown]>): SupabaseClient {
  const makeBuilder = () => {
    const builder: Record<string, unknown> = {
      select: vi.fn(() => builder),
      eq: vi.fn((col: string, val: unknown) => {
        eqCalls.push([col, val]);
        return builder;
      }),
      then: (resolve: (v: unknown) => void) => {
        const count = ENV_ROWS.filter((row) =>
          eqCalls.every(([col, val]) =>
            col === 'app_id' ? true : (row as Record<string, unknown>)[col] === val,
          ),
        ).length;
        resolve({ count, data: null, error: null });
      },
    };
    return builder;
  };
  return {
    from: vi.fn(() => makeBuilder()),
  } as unknown as SupabaseClient;
}

describe('EnvironmentService.createEnvironment — env-limit count excludes ephemeral previews', () => {
  // proves AC-069-11
  it('hands checkEnvLimit the persistent-env count only, not the preview envs', async () => {
    const eqCalls: Array<[string, unknown]> = [];
    const seenCounts: number[] = [];
    const checkEnvLimit: CheckEnvLimitFn = async ({ currentCount }) => {
      seenCounts.push(currentCount);
      // Reject so the call short-circuits before any DB write / Fly call.
      return { allowed: false, limit: 5, tierName: 'hobby' };
    };

    const deps: EnvironmentServiceDeps = {
      supabase: stubSupabase(eqCalls),
      checkEnvLimit,
    };

    const result = await new EnvironmentService(deps).createEnvironment({
      tenantId: '11111111-1111-4111-8111-111111111111',
      appId: '22222222-2222-4222-8222-222222222222',
      name: 'staging',
      actorId: '33333333-3333-4333-8333-333333333333',
    });

    // 3 ephemeral + 2 persistent → the count must be 2.
    expect(seenCounts).toEqual([2]);
    // The ephemeral filter must be present on the count query.
    expect(eqCalls).toContainEqual(['is_ephemeral', false]);
    // And the limit branch is the one we exercised.
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.code).toBe('env_limit_exceeded');
  });
});
