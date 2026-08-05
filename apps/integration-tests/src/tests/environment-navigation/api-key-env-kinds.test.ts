/**
 * API Key — Env-Kind Scoping & Selector Authorization (Integration)
 *
 * An api_key may be scoped to a SET of environment kinds (allowed_env_kinds)
 * instead of pinned to one environment_id, and the gateway authorizes a
 * per-request env selection against that set
 * (gateway `resolveEnvironmentForSelector`). This exercises the real schema
 * constraints + the selection/authorization logic (env lookup by PR number +
 * kind classification via @repo/env-kind) against a real local Supabase.
 *
 * Each test seeds its own rows and deletes them in the same block.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { classifyEnvKind, envKindToTarget } from '@repo/env-kind';
import { createSupabaseAdminClient } from '../../lib/supabase-admin';
import type { SupabaseClient } from '@supabase/supabase-js';
import { setupEnvNavFixture, type EnvNavFixture } from './helpers';

describe('api_key — env-kind scoping + selector authorization', () => {
  const admin = createSupabaseAdminClient() as unknown as SupabaseClient;
  let fixture: EnvNavFixture;
  let previewEnvId: string;
  const PR_NUMBER = 7;
  const createdEnvIds: string[] = [];
  const createdKeyIds: string[] = [];

  // Mirrors gateway resolveEnvironmentForSelector: resolve the env named by the
  // request (PR number → preview env, or name), classify its kind, authorize
  // against the key's allowed_env_kinds.
  async function resolveBySelector(
    selector: { prNumber?: number; envName?: string },
    allowedEnvKinds: string[],
  ): Promise<{ envId: string | null; authorized: boolean }> {
    let q = admin
      .from('environment')
      .select('id, current_version, is_ephemeral')
      .eq('app_id', fixture.appId)
      .eq('tenant_id', fixture.tenantId);
    if (selector.prNumber != null) {
      q = q.eq('source_pr_number', selector.prNumber).eq('is_ephemeral', true);
    } else {
      q = q.eq('name', selector.envName!);
    }
    const { data } = await q.maybeSingle();
    if (!data) return { envId: null, authorized: false };
    const target = envKindToTarget(
      classifyEnvKind(data as { current_version: number; is_ephemeral?: boolean | null }),
    );
    return {
      envId: (data as { id: string }).id,
      authorized: target != null && allowedEnvKinds.includes(target),
    };
  }

  beforeAll(async () => {
    fixture = await setupEnvNavFixture();

    const { data: preview, error: pErr } = await admin
      .from('environment')
      .insert({
        tenant_id: fixture.tenantId,
        app_id: fixture.appId,
        name: 'pr-7',
        is_ephemeral: true,
        source_branch: 'feature-y',
        source_pr_number: PR_NUMBER,
        current_version: 0,
      })
      .select('id')
      .single();
    if (pErr || !preview) throw new Error(`preview env insert failed: ${pErr?.message}`);
    previewEnvId = preview.id as string;
    createdEnvIds.push(previewEnvId);

    const { data: promoted, error: prErr } = await admin
      .from('environment')
      .insert({
        tenant_id: fixture.tenantId,
        app_id: fixture.appId,
        name: 'production',
        current_version: 1,
      })
      .select('id')
      .single();
    if (prErr || !promoted) throw new Error(`promoted env insert failed: ${prErr?.message}`);
    createdEnvIds.push(promoted.id as string);
  });

  afterAll(async () => {
    if (createdKeyIds.length) {
      await admin.from('api_key').delete().in('id', createdKeyIds);
    }
    if (createdEnvIds.length) {
      await admin.from('environment').delete().in('id', createdEnvIds);
    }
    if (fixture) await fixture.cleanup();
  });

  // ───────────────────────────────────────────────────────────────────────────
  // Schema constraints
  // ───────────────────────────────────────────────────────────────────────────

  it('inserts a kind-scoped key with NO environment pin', async () => {
    const { data, error } = await admin
      .from('api_key')
      .insert({
        api_key_id: 'unkey_preview_only_1',
        name: 'ci-preview-key',
        app_id: fixture.appId,
        tenant_id: fixture.tenantId,
        environment_id: null,
        allowed_env_kinds: ['preview'],
      })
      .select('id, environment_id, allowed_env_kinds')
      .single();
    expect(error).toBeNull();
    expect(data?.environment_id).toBeNull();
    expect(data?.allowed_env_kinds).toEqual(['preview']);
    if (data) createdKeyIds.push(data.id as string);
  });

  it('rejects an api_key with an invalid env kind', async () => {
    const { error } = await admin.from('api_key').insert({
      api_key_id: 'unkey_bad_kind',
      name: 'bad-kind-key',
      app_id: fixture.appId,
      tenant_id: fixture.tenantId,
      environment_id: null,
      allowed_env_kinds: ['bogus'],
    });
    expect(error?.message).toContain('chk_api_key_allowed_env_kinds');
  });

  it('rejects an api_key with neither env pin nor kinds', async () => {
    const { error } = await admin.from('api_key').insert({
      api_key_id: 'unkey_no_scope',
      name: 'no-scope-key',
      app_id: fixture.appId,
      tenant_id: fixture.tenantId,
      environment_id: null,
      allowed_env_kinds: null,
    });
    expect(error?.message).toContain('chk_api_key_scope_present');
  });

  // ───────────────────────────────────────────────────────────────────────────
  // Selector authorization
  // ───────────────────────────────────────────────────────────────────────────

  it('authorizes a preview-scoped key selecting its PR preview env', async () => {
    const result = await resolveBySelector({ prNumber: PR_NUMBER }, ['preview']);
    expect(result.envId).toBe(previewEnvId);
    expect(result.authorized).toBe(true);
  });

  it('rejects a preview-scoped key selecting production (cross-kind)', async () => {
    const result = await resolveBySelector({ envName: 'production' }, ['preview']);
    // The env resolves, but its kind (promoted) is not in the key's allowed set.
    expect(result.envId).not.toBeNull();
    expect(result.authorized).toBe(false);
  });
});
