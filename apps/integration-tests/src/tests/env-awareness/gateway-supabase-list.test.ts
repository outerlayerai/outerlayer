/**
 * Integration tests for environment-aware list scoping.
 *
 * Asserts: `GET /v1/api-keys` filters by the API-key-bound `environment_id`.
 * Tests run directly against Supabase (admin client) to verify the filter
 * clause works at the PostgREST layer without requiring a live gateway
 * process.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * Layer strategy
 * ─────────────────────────────────────────────────────────────────────────────
 * The gateway route applies `.eq('environment_id', envId)` (api-keys). These
 * tests seed rows in two environments and assert that the PostgREST `.eq()`
 * filter — the same call the gateway issues — returns only the rows
 * belonging to the scoped env.
 *
 * Runs against a real local Supabase; each test cleans up the rows it seeds.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { randomUUID } from 'crypto';
import { createSupabaseAdminClient } from '../../lib/supabase-admin';
import {
  setupEnvFixture,
  seedPinnedEnvironment,
  type EnvTestFixture,
} from '../environments/helpers';

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

const RUN_ID = `t028-${Date.now().toString(36)}`;

/** Seed a minimal `api_key` row. Returns the inserted row's `id`. */
async function seedApiKey(
  admin: SupabaseClient,
  opts: {
    appId: string;
    tenantId: string;
    environmentId: string;
    suffix: string;
  },
): Promise<string> {
  const { data, error } = await (admin as any)
    .from('api_key')
    .insert({
      name: `t028-key-${opts.suffix}-${RUN_ID}`,
      api_key_id: `key_t028_${opts.suffix}_${RUN_ID}`,
      app_id: opts.appId,
      tenant_id: opts.tenantId,
      environment_id: opts.environmentId,
    })
    .select('id')
    .single();

  if (error || !data) {
    throw new Error(`seedApiKey(${opts.suffix}) failed: ${error?.message}`);
  }
  return data.id as string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Test suite
// ─────────────────────────────────────────────────────────────────────────────

describe('Gateway Supabase list env-awareness', () => {
  let fixture: EnvTestFixture;
  let admin: SupabaseClient;

  // Row IDs seeded during the tests, for targeted cleanup.
  const seededApiKeyIds: string[] = [];

  beforeAll(async () => {
    fixture = await setupEnvFixture();
    admin = createSupabaseAdminClient() as unknown as SupabaseClient;
  });

  afterAll(async () => {
    // Clean up seeded rows before calling fixture.cleanup() which deletes the
    // environment rows.
    if (seededApiKeyIds.length) {
      await (admin as any).from('api_key').delete().in('id', seededApiKeyIds);
    }
    await fixture.cleanup();
  });

  // ─── api_key env-id filter ────────────────────────────────────────────────

  describe('api_key.environment_id filter', () => {
    it('eq(environment_id) returns only keys scoped to that environment', async () => {
      const stagingEnv = await seedPinnedEnvironment(fixture, {
        name: 'api-key-staging',
        version: 1,
        commitSha: `${randomUUID().replace(/-/g, '').slice(0, 40)}`,
      });

      const stagingKeyId = await seedApiKey(admin, {
        appId: fixture.app.id,
        tenantId: fixture.tenant.id,
        environmentId: stagingEnv.id,
        suffix: 'staging',
      });
      const devKeyId = await seedApiKey(admin, {
        appId: fixture.app.id,
        tenantId: fixture.tenant.id,
        environmentId: fixture.defaultEnv.id,
        suffix: 'dev',
      });
      seededApiKeyIds.push(stagingKeyId, devKeyId);

      // Simulate what the gateway's ListApiKeys does: filter by env id.
      const { data: stagingKeys, error: stagingErr } = await (admin as any)
        .from('api_key')
        .select('id, environment_id')
        .eq('app_id', fixture.app.id)
        .eq('environment_id', stagingEnv.id);

      expect(stagingErr).toBeNull();
      const stagingKeyIds = (stagingKeys as Array<{ id: string }>).map((r) => r.id);

      // The staging-scoped key must appear.
      expect(stagingKeyIds).toContain(stagingKeyId);
      // The dev key must NOT appear.
      expect(stagingKeyIds).not.toContain(devKeyId);
    });

    it('eq(environment_id) for the default env does not surface keys from another env', async () => {
      const otherEnv = await seedPinnedEnvironment(fixture, {
        name: 'api-key-other',
        version: 1,
        commitSha: `${randomUUID().replace(/-/g, '').slice(0, 40)}`,
      });

      const otherKeyId = await seedApiKey(admin, {
        appId: fixture.app.id,
        tenantId: fixture.tenant.id,
        environmentId: otherEnv.id,
        suffix: 'other',
      });
      const defaultKeyId = await seedApiKey(admin, {
        appId: fixture.app.id,
        tenantId: fixture.tenant.id,
        environmentId: fixture.defaultEnv.id,
        suffix: 'default',
      });
      seededApiKeyIds.push(otherKeyId, defaultKeyId);

      const { data: devKeys, error: devErr } = await (admin as any)
        .from('api_key')
        .select('id, environment_id')
        .eq('app_id', fixture.app.id)
        .eq('environment_id', fixture.defaultEnv.id);

      expect(devErr).toBeNull();
      const devKeyIds = (devKeys as Array<{ id: string }>).map((r) => r.id);

      expect(devKeyIds).toContain(defaultKeyId);
      expect(devKeyIds).not.toContain(otherKeyId);
    });
  });
});
