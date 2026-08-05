/**
 * Deployment Env Var — Kind-Targeting Integration Tests
 *
 * A `env_var` row now targets EITHER a specific environment
 * (environment_id) OR a kind ('all' | 'development' | 'preview' | 'promoted',
 * target_kind), enforced by the exactly-one CHECK + a partial unique index on
 * (app_id, key, target_kind). Resolution for a concrete env merges its
 * specific-env rows with the kind rows that apply, most-specific-wins
 * (resolveEnvVarRows in @repo/env-kind).
 *
 * This exercises the REAL schema + constraints against a real local Supabase,
 * then runs the shared resolver over the real candidate query — proving the
 * end-to-end win: a preview env inherits preview/all vars it was never
 * individually configured with, a promoted env does not see preview-only vars,
 * and a specific-env row overrides a kind row.
 *
 * Each test seeds its own rows and deletes them in the same block.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { envTargetOf, resolveEnvVarRows } from '@repo/env-kind';
import { createSupabaseAdminClient } from '../../lib/supabase-admin';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  setupEnvNavFixture,
  createVaultSecret,
  type EnvNavFixture,
} from './helpers';

describe('env_var — kind targeting', () => {
  const admin = createSupabaseAdminClient() as unknown as SupabaseClient;
  let fixture: EnvNavFixture;
  let previewEnvId: string;
  let promotedEnvId: string;
  const createdEnvVarIds: string[] = [];
  const createdEnvIds: string[] = [];

  // Candidate query mirroring EnvVarService.collectAll / the gateway builder.
  async function resolveFor(envId: string, envTarget: ReturnType<typeof envTargetOf>) {
    const { data: rows, error } = await admin
      .from('env_var')
      .select('key, target_kind, environment_id')
      .eq('app_id', fixture.appId)
      .or(`environment_id.eq.${envId},target_kind.not.is.null`);
    if (error) throw new Error(`candidate query failed: ${error.message}`);
    const winners = resolveEnvVarRows(
      (rows ?? []) as {
        key: string;
        target_kind: 'all' | 'development' | 'preview' | 'promoted' | null;
        environment_id: string | null;
      }[],
      envId,
      envTarget,
    );
    return Object.fromEntries(
      winners.map((w) => [w.key, w.target_kind ?? `env:${w.environment_id}`]),
    );
  }

  async function seedKindVar(key: string, targetKind: string, value: string) {
    const secretId = await createVaultSecret(
      `env_${fixture.appId}_kind_${targetKind}_${key}`,
      value,
    );
    const { data, error } = await admin
      .from('env_var')
      .insert({
        tenant_id: fixture.tenantId,
        app_id: fixture.appId,
        target_kind: targetKind,
        environment_id: null,
        key,
        vault_secret_id: secretId,
      })
      .select('id')
      .single();
    if (error || !data) throw new Error(`seedKindVar(${key}) failed: ${error?.message}`);
    createdEnvVarIds.push(data.id as string);
    return data.id as string;
  }

  beforeAll(async () => {
    fixture = await setupEnvNavFixture();

    // An ephemeral preview env (pr-1) and a pinned promoted env.
    const { data: preview, error: pErr } = await admin
      .from('environment')
      .insert({
        tenant_id: fixture.tenantId,
        app_id: fixture.appId,
        name: 'pr-1',
        is_ephemeral: true,
        source_branch: 'feature-x',
        source_pr_number: 1,
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
    promotedEnvId = promoted.id as string;
    createdEnvIds.push(promotedEnvId);
  });

  afterAll(async () => {
    if (createdEnvVarIds.length) {
      await admin.from('env_var').delete().in('id', createdEnvVarIds);
    }
    if (createdEnvIds.length) {
      await admin.from('environment').delete().in('id', createdEnvIds);
    }
    if (fixture) await fixture.cleanup();
  });

  // ───────────────────────────────────────────────────────────────────────────
  // Constraints
  // ───────────────────────────────────────────────────────────────────────────

  it('should reject a row that sets BOTH environment_id and target_kind', async () => {
    const secretId = await createVaultSecret(`env_${fixture.appId}_both`, 'x');
    const { error } = await admin.from('env_var').insert({
      tenant_id: fixture.tenantId,
      app_id: fixture.appId,
      environment_id: fixture.devEnv.id,
      target_kind: 'preview',
      key: 'BOTH_SET',
      vault_secret_id: secretId,
    });
    expect(error?.message).toContain('chk_env_var_scope_exactly_one');
  });

  it('should reject a row that sets NEITHER environment_id nor target_kind', async () => {
    const secretId = await createVaultSecret(`env_${fixture.appId}_neither`, 'x');
    const { error } = await admin.from('env_var').insert({
      tenant_id: fixture.tenantId,
      app_id: fixture.appId,
      environment_id: null,
      target_kind: null,
      key: 'NEITHER_SET',
      vault_secret_id: secretId,
    });
    expect(error?.message).toContain('chk_env_var_scope_exactly_one');
  });

  it('should reject a duplicate (app_id, key, target_kind) via the partial unique index', async () => {
    await seedKindVar('DUP_KIND', 'preview', 'first');
    const secretId = await createVaultSecret(`env_${fixture.appId}_kind_preview_DUP_KIND_2`, 'second');
    const { error } = await admin.from('env_var').insert({
      tenant_id: fixture.tenantId,
      app_id: fixture.appId,
      target_kind: 'preview',
      environment_id: null,
      key: 'DUP_KIND',
      vault_secret_id: secretId,
    });
    expect(error?.message).toContain('env_var_app_key_kind_unique');
  });

  // ───────────────────────────────────────────────────────────────────────────
  // Resolution
  // ───────────────────────────────────────────────────────────────────────────

  it('resolves preview-inherits, promoted-excludes, and specific-overrides-kind', async () => {
    // Arrange: an 'all' var, a 'preview'-only var, and a preview-specific
    // override of the 'all' key.
    await seedKindVar('SHARED', 'all', 'shared-val');
    await seedKindVar('PREVIEW_ONLY', 'preview', 'prev-val');

    const overrideSecret = await createVaultSecret(
      `env_${fixture.appId}_${previewEnvId}_SHARED`,
      'preview-override',
    );
    const { data: ov, error: ovErr } = await admin
      .from('env_var')
      .insert({
        tenant_id: fixture.tenantId,
        app_id: fixture.appId,
        environment_id: previewEnvId,
        key: 'SHARED',
        vault_secret_id: overrideSecret,
      })
      .select('id')
      .single();
    if (ovErr || !ov) throw new Error(`override insert failed: ${ovErr?.message}`);
    createdEnvVarIds.push(ov.id as string);

    // Act + Assert: preview env sees the override + the preview-only var.
    const previewResolved = await resolveFor(
      previewEnvId,
      envTargetOf({ current_version: 0, is_ephemeral: true }),
    );
    expect(previewResolved).toEqual({
      SHARED: `env:${previewEnvId}`, // specific override beats the 'all' kind row
      PREVIEW_ONLY: 'preview',
      DUP_KIND: 'preview',
    });

    // Promoted env sees only the 'all' var — never the preview-only one, never
    // the preview-specific override.
    const promotedResolved = await resolveFor(
      promotedEnvId,
      envTargetOf({ current_version: 1, is_ephemeral: false }),
    );
    expect(promotedResolved).toEqual({ SHARED: 'all' });
  });
});
