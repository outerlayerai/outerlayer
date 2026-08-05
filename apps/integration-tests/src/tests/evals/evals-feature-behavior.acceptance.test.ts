/**
 * Acceptance: the evals feature behavior eval-run-tenancy.acceptance.test.ts
 * doesn't reach (that suite proves list/insert tenant + permission scoping
 * through raw table reads/writes; this one drives the actual `EvalRunService`
 * methods `refreshEvalRuns` and the poll route delegate to, plus the launch
 * dispatch's foreign-environmentId gap).
 *
 * `launchEvalRun`/`refreshEvalRuns` are `authorizedAction`-wrapped and the
 * poll route is `withApi`-wrapped — both need the Next.js request scope this
 * harness doesn't have (same gap as every other domain). Their handlers are
 * thin, though: `EvalRunService` (`features/evals/service.ts`) is a plain
 * class over `ServiceContext`, driven directly here.
 *
 * The poll route's params-vs-query mismatch + 404 remap is already
 * unit-tested with `evalsService.get` mocked in
 * `app/api/orgs/[orgName]/apps/[appId]/evals/runs/[runId]/__tests__/route.test.ts`
 * — cited, not duplicated. `evalsService.get`'s real-wire behavior (the part
 * missing at acceptance level) is added below.
 *
 * The read-only-can-read-but-not-launch permission shape is already proven in
 * eval-run-tenancy.acceptance.test.ts ("a read-only role can see runs but
 * cannot launch one") — cited. Added below: `evalsService.list`
 * (refreshEvalRuns's actual delegate) driven directly, pinning it to the same
 * exact-shape/ordering contract the existing raw-query test proves.
 *
 * The 2000-char truncation bound is already unit-pinned in
 * `features/evals/service.test.ts:145` — cited. Added below: a cheap
 * real-wire round-trip (patch through `fail()`, re-read through `get()`)
 * since neither call reaches outside Postgres.
 */

import { describe, it, beforeAll, afterAll, expect } from 'vitest';
import { randomUUID } from 'crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import { createSupabaseAdminClientUntyped } from '../../lib/supabase-admin';
import { createTenantScopedClient } from '../../lib/tenant-scoped-client';
import { createTenantWithOwner, addUserToTenant, cleanupTenantAndUsers, type SameTenantUser } from '../custom-roles/helpers';
import { evalsService } from 'tenant-dashboard/src/features/evals/service';
import type { ServiceContext } from 'tenant-dashboard/src/lib/action-kit/service-context';

const untyped = (client: { from: SupabaseClient['from'] }): SupabaseClient => client as unknown as SupabaseClient;

function ctxFor(user: SameTenantUser): ServiceContext {
  return { db: untyped(user.client), tenantId: user.tenantId, actor: { userId: user.id, role: user.orgRole } };
}

describe('evals feature behavior — EvalRunService.get/list wire, launch foreign-environment gap, and error truncation', () => {
  const admin = createSupabaseAdminClientUntyped();

  let owner: SameTenantUser;
  let writeMember: SameTenantUser;
  let otherOrg: SameTenantUser;
  let appId: string;
  let ownEnvironmentId: string;
  let crossAppEnvironmentId: string;
  let foreignEnvironmentId: string;
  const suffix = randomUUID().slice(0, 8);

  beforeAll(async () => {
    owner = await createTenantWithOwner();
    writeMember = await addUserToTenant(owner.tenantId, 'write');
    otherOrg = await createTenantWithOwner();

    const { data: app, error: appError } = await admin
      .from('app')
      .insert({ name: `eval-behavior-${suffix}`, tenant_id: owner.tenantId, created_by: owner.id })
      .select('id')
      .single();
    if (appError) throw new Error(`app insert: ${appError.message}`);
    appId = app!.id as string;

    const { data: ownEnv, error: ownEnvError } = await admin
      .from('environment')
      .select('id')
      .eq('app_id', appId)
      .eq('is_default', true)
      .single();
    if (ownEnvError) throw new Error(`own environment lookup: ${ownEnvError.message}`);
    ownEnvironmentId = ownEnv!.id as string;

    // Same tenant, different app — proves the FK correlates on app, not just tenant.
    const { data: crossApp, error: crossAppError } = await admin
      .from('app')
      .insert({ name: `eval-cross-app-${suffix}`, tenant_id: owner.tenantId, created_by: owner.id })
      .select('id')
      .single();
    if (crossAppError) throw new Error(`cross-app insert: ${crossAppError.message}`);

    const { data: crossAppEnv, error: crossAppEnvError } = await admin
      .from('environment')
      .select('id')
      .eq('app_id', crossApp!.id)
      .eq('is_default', true)
      .single();
    if (crossAppEnvError) throw new Error(`cross-app environment lookup: ${crossAppEnvError.message}`);
    crossAppEnvironmentId = crossAppEnv!.id as string;

    const { data: foreignApp, error: foreignAppError } = await admin
      .from('app')
      .insert({ name: `eval-foreign-${suffix}`, tenant_id: otherOrg.tenantId, created_by: otherOrg.id })
      .select('id')
      .single();
    if (foreignAppError) throw new Error(`foreign app insert: ${foreignAppError.message}`);

    const { data: foreignEnv, error: envError } = await admin
      .from('environment')
      .select('id')
      .eq('app_id', foreignApp!.id)
      .eq('is_default', true)
      .single();
    if (envError) throw new Error(`foreign environment lookup: ${envError.message}`);
    foreignEnvironmentId = foreignEnv!.id as string;
  }, 60000);

  afterAll(async () => {
    await cleanupTenantAndUsers(owner.tenantId, [owner, writeMember]);
    await cleanupTenantAndUsers(otherOrg.tenantId, [otherOrg]);
  });

  describe('evalsService.get — the poll route’s real-wire delegate', () => {
    it('resolves a seeded run by (appId, runId) with the full row shape', async () => {
      const ctx = ctxFor(owner);
      const { data: run, error } = await admin
        .from('eval_run')
        .insert({ tenant_id: owner.tenantId, app_id: appId, repo_label: 'acme/poll-hit', request: { configs: [] } })
        .select('id')
        .single();
      if (error) throw new Error(`seed eval_run: ${error.message}`);

      const got = await evalsService.get(ctx, appId, run!.id as string);
      expect(got).toEqual({
        id: run!.id,
        tenant_id: owner.tenantId,
        app_id: appId,
        environment_id: null,
        status: 'queued',
        repo_label: 'acme/poll-hit',
        request: { configs: [] },
        card: null,
        cost_usd: 0,
        error: null,
        created_at: expect.any(String),
        created_by: null,
        updated_at: null,
        updated_by: null,
      });
    });

    it('returns null for an unknown runId — the shape the route remaps to its 404', async () => {
      const ctx = ctxFor(owner);
      const got = await evalsService.get(ctx, appId, randomUUID());
      expect(got).toBeNull();
    });
  });

  describe('evalsService.list — refreshEvalRuns’s real-wire delegate', () => {
    it('lists an app’s runs newest-first with the exact LIST_COLUMNS projection', async () => {
      const ctx = ctxFor(owner);
      const older = await admin
        .from('eval_run')
        .insert({
          tenant_id: owner.tenantId,
          app_id: appId,
          repo_label: 'acme/list-older',
          request: { configs: [] },
          created_at: new Date(Date.now() - 60_000).toISOString(),
        })
        .select('id')
        .single();
      const newer = await admin
        .from('eval_run')
        .insert({ tenant_id: owner.tenantId, app_id: appId, repo_label: 'acme/list-newer', request: { configs: [] } })
        .select('id')
        .single();

      const list = await evalsService.list(ctx, appId);
      const ids = list.map((r) => r.id);
      expect(ids.indexOf(newer.data!.id as string)).toBeLessThan(ids.indexOf(older.data!.id as string));
      expect(list.find((r) => r.id === newer.data!.id)?.repo_label).toBe('acme/list-newer');
    });
  });

  describe('eval_run.environment_id ownership — composite FK (environment_id, app_id) → environment(id, app_id)', () => {
    it("a member's insert naming another tenant's environmentId is rejected by the composite FK, and no row lands", async () => {
      const asOwner = await createTenantScopedClient(owner, owner.tenantId);
      const { data, error } = await asOwner
        .from('eval_run')
        .insert({
          tenant_id: owner.tenantId,
          app_id: appId,
          environment_id: foreignEnvironmentId,
          repo_label: 'acme/cross-tenant-env',
          request: { configs: [] },
        })
        .select('id')
        .single();

      expect(error).not.toBeNull();
      expect(error!.message).toContain('eval_run_environment_app_fkey');
      expect(data).toBeNull();
      const { data: leaked } = await admin.from('eval_run').select('id').eq('environment_id', foreignEnvironmentId);
      expect(leaked).toEqual([]);
    });

    it('a same-tenant insert naming a different app’s environmentId is rejected by the same composite FK', async () => {
      const asOwner = await createTenantScopedClient(owner, owner.tenantId);
      const { data, error } = await asOwner
        .from('eval_run')
        .insert({
          tenant_id: owner.tenantId,
          app_id: appId,
          environment_id: crossAppEnvironmentId,
          repo_label: 'acme/cross-app-env',
          request: { configs: [] },
        })
        .select('id')
        .single();

      expect(error).not.toBeNull();
      expect(error!.message).toContain('eval_run_environment_app_fkey');
      expect(data).toBeNull();
      const { data: leaked } = await admin.from('eval_run').select('id').eq('environment_id', crossAppEnvironmentId);
      expect(leaked).toEqual([]);
    });

    it('a foreign-but-existing env id and a nonexistent env id fail with the same constraint — no existence oracle', async () => {
      const asOwner = await createTenantScopedClient(owner, owner.tenantId);
      const insert = (environmentId: string) =>
        asOwner
          .from('eval_run')
          .insert({
            tenant_id: owner.tenantId,
            app_id: appId,
            environment_id: environmentId,
            repo_label: 'acme/oracle-probe',
            request: { configs: [] },
          })
          .select('id')
          .single();

      const foreignResult = await insert(foreignEnvironmentId);
      const nonexistentResult = await insert(randomUUID());

      expect(foreignResult.error).not.toBeNull();
      expect(nonexistentResult.error).not.toBeNull();
      expect(foreignResult.error!.message).toContain('eval_run_environment_app_fkey');
      expect(nonexistentResult.error!.message).toContain('eval_run_environment_app_fkey');
      // Postgres foreign_key_violation — pinned literally so a drift to a
      // different violation class (e.g. a check constraint) fails this test.
      expect(foreignResult.error!.code).toBe('23503');
      expect(nonexistentResult.error!.code).toBe('23503');
    });

    it("a non-owner write-role member's insert naming the app's own default env lands, and environment_id round-trips", async () => {
      const asWrite = await createTenantScopedClient(writeMember, owner.tenantId);
      const { data, error } = await asWrite
        .from('eval_run')
        .insert({
          tenant_id: owner.tenantId,
          app_id: appId,
          environment_id: ownEnvironmentId,
          repo_label: 'acme/own-env',
          request: { configs: [] },
        })
        .select('id, environment_id')
        .single();

      expect(error).toBeNull();
      expect(data?.environment_id).toBe(ownEnvironmentId);
    });

    it('an insert with environment_id: null still lands — default-env semantics unchanged', async () => {
      const asOwner = await createTenantScopedClient(owner, owner.tenantId);
      const { data, error } = await asOwner
        .from('eval_run')
        .insert({
          tenant_id: owner.tenantId,
          app_id: appId,
          environment_id: null,
          repo_label: 'acme/null-env',
          request: { configs: [] },
        })
        .select('id, environment_id')
        .single();

      expect(error).toBeNull();
      expect(data?.environment_id).toBeNull();
    });
  });

  describe('fail() truncation bound through the real wire (unit-pinned in service.test.ts:145)', () => {
    it('a runaway error message is truncated to exactly 2000 characters when re-read via get()', async () => {
      const ctx = ctxFor(owner);
      const { data: run, error } = await admin
        .from('eval_run')
        .insert({ tenant_id: owner.tenantId, app_id: appId, repo_label: 'acme/truncate', request: { configs: [] } })
        .select('id')
        .single();
      if (error) throw new Error(`seed eval_run: ${error.message}`);

      const runaway = 'x'.repeat(5000);
      await evalsService.fail(ctx, appId, run!.id as string, runaway);

      const reread = await evalsService.get(ctx, appId, run!.id as string);
      expect(reread?.status).toBe('failed');
      expect(reread?.error).toHaveLength(2000);
      expect(reread?.error).toBe(runaway.slice(0, 2000));
    });
  });
});
