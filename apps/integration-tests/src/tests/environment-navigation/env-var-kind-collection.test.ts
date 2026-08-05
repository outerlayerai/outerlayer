/**
 * Env-var KIND collection — golden path (Integration)
 *
 * The reason kind-targeting exists: a freshly-created PR preview env has ZERO
 * specific-env rows, so without a `preview`/`all` kind layer its deployed agent
 * inherits no model credentials and cannot run. Both the dashboard
 * (`EnvVarService.collectAll`) and the gateway build path
 * (`GatewayManagedBuildService.collectEnvVars`) resolve a concrete env's env
 * vars from the SAME contract: the `environment_id == env OR target_kind IS NOT
 * NULL` candidate query → `resolveEnvVarRows` precedence → a Vault read under
 * the scope's name (`envVarEnvVaultName` / `envVarKindVaultName`).
 *
 * This exercises that contract against REAL Supabase + REAL Vault using the
 * REAL shared `@repo/env-kind` primitives the two production wrappers call — so
 * it catches drift in the candidate query, the precedence, OR the Vault naming
 * (the cross-app seam) that the per-wrapper unit tests (which fake Supabase)
 * cannot. It is NOT a re-implementation: every decision (target classification,
 * precedence, secret name) comes from the shared module, not a parallel copy.
 *
 * Each test seeds its own rows and deletes them in the same block.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  envTargetOf,
  envVarEnvVaultName,
  envVarKindVaultName,
  resolveEnvVarRows,
  type EnvVarTargetKind,
} from '@repo/env-kind';
import { createSupabaseAdminClient } from '../../lib/supabase-admin';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  setupEnvNavFixture,
  seedEnvVar,
  seedKindEnvVar,
  type EnvNavFixture,
} from './helpers';

describe('env_var — kind collection golden path', () => {
  const admin = createSupabaseAdminClient() as unknown as SupabaseClient;
  let fixture: EnvNavFixture;
  let previewEnvId: string;
  let promotedEnvId: string;
  const PR_NUMBER = 4242;

  /**
   * Resolve a concrete env's env vars to a key→value map, replaying the exact
   * steps `collectAll`/`collectEnvVars` take but built from the shared
   * primitives so this asserts the contract, not a copy of the orchestration.
   */
  async function collectResolved(
    environmentId: string,
  ): Promise<Record<string, string>> {
    const { data: envRow } = await admin
      .from('environment')
      .select('current_version, is_ephemeral')
      .eq('id', environmentId)
      .eq('app_id', fixture.appId)
      .maybeSingle();
    const envTarget = envRow
      ? envTargetOf(
          envRow as { current_version: number; is_ephemeral?: boolean | null },
        )
      : null;

    const { data: rows, error } = await admin
      .from('env_var')
      .select('key, target_kind, environment_id')
      .eq('app_id', fixture.appId)
      .or(`environment_id.eq.${environmentId},target_kind.not.is.null`);
    if (error) throw new Error(`candidate query failed: ${error.message}`);

    const winners = resolveEnvVarRows(
      (rows ?? []) as Array<{
        key: string;
        target_kind: EnvVarTargetKind | null;
        environment_id: string | null;
      }>,
      environmentId,
      envTarget,
    );

    const out: Record<string, string> = {};
    for (const w of winners) {
      const secretName =
        w.environment_id != null
          ? envVarEnvVaultName(fixture.appId, w.environment_id, w.key)
          : envVarKindVaultName(fixture.appId, w.target_kind!, w.key);
      const { data: value } = await admin.rpc('read_secret', {
        secret_name: secretName,
      });
      if (value != null) out[w.key] = value as string;
    }
    return out;
  }

  beforeAll(async () => {
    fixture = await setupEnvNavFixture();

    // A preview env (ephemeral, no pin) and a promoted env (current_version>0).
    const { data: preview, error: pErr } = await admin
      .from('environment')
      .insert({
        tenant_id: fixture.tenantId,
        app_id: fixture.appId,
        name: 'pr-4242',
        is_ephemeral: true,
        source_branch: 'feature-kind-collect',
        source_pr_number: PR_NUMBER,
        current_version: 0,
        created_by: fixture.ownerUser.id,
      })
      .select('id')
      .single();
    if (pErr || !preview) throw new Error(`preview env: ${pErr?.message}`);
    previewEnvId = preview.id as string;

    const { data: promoted, error: prErr } = await admin
      .from('environment')
      .insert({
        tenant_id: fixture.tenantId,
        app_id: fixture.appId,
        name: 'production',
        current_version: 1,
        created_by: fixture.ownerUser.id,
      })
      .select('id')
      .single();
    if (prErr || !promoted) throw new Error(`promoted env: ${prErr?.message}`);
    promotedEnvId = promoted.id as string;

    // The kind layer: `all` everywhere, plus one var per kind.
    await seedKindEnvVar({
      tenantId: fixture.tenantId,
      appId: fixture.appId,
      targetKind: 'all',
      key: 'SHARED',
      value: 'all-value',
    });
    await seedKindEnvVar({
      tenantId: fixture.tenantId,
      appId: fixture.appId,
      targetKind: 'preview',
      key: 'PREVIEW_ONLY',
      value: 'preview-value',
    });
    await seedKindEnvVar({
      tenantId: fixture.tenantId,
      appId: fixture.appId,
      targetKind: 'promoted',
      key: 'PROMOTED_ONLY',
      value: 'promoted-value',
    });
  });

  afterAll(async () => {
    if (fixture) await fixture.cleanup();
  });

  it('preview env inherits the all + preview vars it never configured, never the promoted one', async () => {
    const resolved = await collectResolved(previewEnvId);
    expect(resolved).toEqual({
      SHARED: 'all-value',
      PREVIEW_ONLY: 'preview-value',
    });
    // The promoted-only var must NOT leak into a preview build.
    expect(resolved.PROMOTED_ONLY).toBeUndefined();
  });

  it('promoted env gets all + promoted vars, never the preview one', async () => {
    const resolved = await collectResolved(promotedEnvId);
    expect(resolved).toEqual({
      SHARED: 'all-value',
      PROMOTED_ONLY: 'promoted-value',
    });
    expect(resolved.PREVIEW_ONLY).toBeUndefined();
  });

  it('a specific-environment row overrides the all-kind value for the same key', async () => {
    // Arrange: a preview-env-specific SHARED that must win over the `all` row.
    const override = await seedEnvVar({
      client: admin,
      tenantId: fixture.tenantId,
      appId: fixture.appId,
      environmentId: previewEnvId,
      key: 'SHARED',
      value: 'preview-override',
    });

    // Act
    const resolved = await collectResolved(previewEnvId);

    // Assert: most-specific-wins — the override beats `all`; the promoted env,
    // which has no such override, still sees the `all` value.
    expect(resolved.SHARED).toBe('preview-override');
    expect((await collectResolved(promotedEnvId)).SHARED).toBe('all-value');

    // Remove the override so the suite stays order-independent.
    await admin.from('env_var').delete().eq('id', override.id);
  });
});
