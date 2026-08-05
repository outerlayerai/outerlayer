/**
 * Pins the reads against dropped tables FROZEN rather than deleted, so the
 * gateway's public wire contract (`GET /v1/environments/:id`) doesn't change
 * shape: `getInFlightSaga` always resolves `null`, and
 * `computeCascade()` reports `deployments_deleted` and `alerts_deleted` as
 * always `0`. These used to query the `deployment` and `alert` tables.
 *
 * These exist so a future edit that tries to "restore" any of those reads
 * (e.g. pointing one at a new table) doesn't silently un-freeze the contract
 * without a deliberate, reviewed decision — the exact values below must keep
 * passing.
 */
import { describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

import {
  EnvironmentService,
  type EnvironmentServiceDeps,
} from './environment-service';

const ENV_ID = '44444444-4444-4444-8444-444444444444';

function makeService(supabase: SupabaseClient): EnvironmentService {
  const deps: EnvironmentServiceDeps = {
    supabase,
  };
  return new EnvironmentService(deps);
}

describe('EnvironmentService — frozen deployment-table reads', () => {
  it('getInFlightSaga always resolves null, regardless of envId, without querying Supabase', async () => {
    const from = vi.fn();
    const service = makeService({ from } as unknown as SupabaseClient);

    await expect(service.getInFlightSaga(ENV_ID)).resolves.toBeNull();
    await expect(service.getInFlightSaga('some-other-env-id')).resolves.toBeNull();
    expect(from).not.toHaveBeenCalled();
  });

  it('computeCascade pins alerts_deleted and deployments_deleted to exactly 0 alongside the live api_key count', async () => {
    // Any table the service DID query would return 7 here, so a frozen field
    // reporting 0 proves it was never queried — not merely that it came back
    // empty.
    const from = vi.fn(() => ({
      select: vi.fn(() => ({
        eq: vi.fn(() => Promise.resolve({ count: 7, error: null })),
      })),
    }));
    const service = makeService({ from } as unknown as SupabaseClient);

    const cascade = await service.computeCascade(ENV_ID);

    expect(cascade).toEqual({
      api_keys_revoked: 7,
      alerts_deleted: 0,
      deployments_deleted: 0,
    });
    // The two frozen counts are literals, not live queries against the
    // dropped tables.
    expect(from).toHaveBeenCalledWith('api_key');
    expect(from).not.toHaveBeenCalledWith('alert');
    expect(from).not.toHaveBeenCalledWith('deployment');
  });
});
