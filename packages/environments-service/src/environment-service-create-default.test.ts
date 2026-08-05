/**
 * createDefaultEnvironment idempotency.
 *
 * Since the `on_create_seed_default_env` trigger (migration 20260529221911)
 * seeds the default `dev` env atomically with the app row, an explicit caller
 * of createDefaultEnvironment usually finds the row already present (unique
 * violation, PG 23505). The method must treat that as success and return the
 * EXISTING row — not throw — so the app-creation flow stays green when both the
 * trigger and an explicit seed run. A non-conflict error must still fail closed.
 *
 * Service-layer unit test: the Supabase client is stubbed so the
 * insert-conflict + fetch-existing branch is driven deterministically (the
 * package's established style — see environment-service-error-copy.test.ts).
 */
import { describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

import {
  EnvironmentService,
  type EnvironmentServiceDeps,
} from './environment-service';

const TENANT = '11111111-1111-4111-8111-111111111111';
const APP = '22222222-2222-4222-8222-222222222222';
const ACTOR = '33333333-3333-4333-8333-333333333333';
const ENV_ID = '44444444-4444-4444-8444-444444444444';

function makeEnvRow(overrides: Record<string, unknown> = {}) {
  return {
    id: ENV_ID,
    tenant_id: TENANT,
    app_id: APP,
    name: 'dev',
    is_default: true,
    current_version: 0,
    current_commit_sha: null,
    fly_app_name: null,
    epoch: 1,
    created_at: '2026-05-29T00:00:00Z',
    created_by: ACTOR,
    updated_at: null,
    updated_by: null,
    ...overrides,
  };
}

/**
 * Stub `deps.supabase` so `from('environment')` supports BOTH chains the method
 * uses: `.insert(...).select(...).single()` (the seed attempt) and
 * `.select(...).eq(...).eq(...).single()` (the fetch-existing fallback).
 */
function stubSupabase(
  insertResult: { data: unknown; error: unknown },
  fetchResult: { data: unknown; error: unknown },
): SupabaseClient {
  return {
    from: vi.fn(() => ({
      insert: vi.fn(() => ({
        select: vi.fn(() => ({
          single: vi.fn(() => Promise.resolve(insertResult)),
        })),
      })),
      select: vi.fn(() => ({
        eq: vi.fn(() => ({
          eq: vi.fn(() => ({
            single: vi.fn(() => Promise.resolve(fetchResult)),
          })),
        })),
      })),
    })),
  } as unknown as SupabaseClient;
}

function makeService(supabase: SupabaseClient): EnvironmentService {
  const deps: EnvironmentServiceDeps = {
    supabase,
    // createDefaultEnvironment never touches Fly — a no-op client is enough.
  };
  return new EnvironmentService(deps);
}

describe('EnvironmentService.createDefaultEnvironment — idempotency', () => {
  it('returns the inserted row on a clean insert', async () => {
    const inserted = makeEnvRow();
    const service = makeService(
      stubSupabase(
        { data: inserted, error: null },
        { data: null, error: { message: 'fetch must not run on a clean insert' } },
      ),
    );

    const result = await service.createDefaultEnvironment({
      tenantId: TENANT,
      appId: APP,
      actorId: ACTOR,
    });

    expect(result).toEqual(inserted);
  });

  it('returns the EXISTING row (does not throw) when the trigger already seeded it (23505)', async () => {
    // The trigger-seeded row differs slightly (created_by null) so a passing
    // test proves we returned the FETCHED row, not the (null) insert payload.
    const existing = makeEnvRow({ created_by: null });
    const service = makeService(
      stubSupabase(
        {
          data: null,
          error: {
            code: '23505',
            message:
              'duplicate key value violates unique constraint "idx_environment_app_name_unique"',
          },
        },
        { data: existing, error: null },
      ),
    );

    const result = await service.createDefaultEnvironment({
      tenantId: TENANT,
      appId: APP,
      actorId: ACTOR,
    });

    expect(result).toEqual(existing);
  });

  it('fails closed on a non-conflict insert error', async () => {
    const service = makeService(
      stubSupabase(
        {
          data: null,
          error: { code: '42501', message: 'permission denied for table environment' },
        },
        { data: makeEnvRow(), error: null },
      ),
    );

    await expect(
      service.createDefaultEnvironment({
        tenantId: TENANT,
        appId: APP,
        actorId: ACTOR,
      }),
    ).rejects.toThrow(/createDefaultEnvironment failed for app .*permission denied/);
  });
});
