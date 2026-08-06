/**
 * Acceptance: `features/apps/service.ts`'s `listAppsWithGitStatus` — the RSC
 * read behind the org apps-list page — against the real local Postgres/RLS
 * wire path (Kong → PostgREST), not a mock.
 *
 * Drives `AppsService.listAppsWithGitStatus(ctx)` directly with a `ctx.db`
 * built from `createTenantScopedClient` (the header-scoped, real-RLS client
 * the acceptance-mechanics doc models tests on) — the same query the page
 * runs, minus the Next.js RSC wrapper.
 *
 * Cases covered:
 *   - apps-list read isolation, fail-closed for a non-member header.
 *   - list read shape: connected / unconnected / legacy-gitlab rows.
 *   - projection + `!<fk_name>` embed disambiguation (this is the case that
 *     fails at the PostgREST wire if the hints are dropped — the reason this
 *     suite exercises the real DB rather than a fake).
 */

import { randomUUID } from 'crypto';
import { createTenantWithOwner, cleanupTenantAndUsers, type SameTenantUser } from '../app-level-roles/helpers';
import { createTenantScopedClient } from '../../lib/tenant-scoped-client';
import { createSupabaseAdminClient } from '../../lib/supabase-admin';
import { uniqueInstallationId } from '../../lib/app-test-utils';
import { appsService } from 'tenant-dashboard/src/features/apps/service';
import type { ServiceContext } from 'tenant-dashboard/src/lib/action-kit/service-context';

async function ctxFor(user: SameTenantUser, tenantId: string): Promise<ServiceContext> {
  const db = await createTenantScopedClient(user, tenantId);
  return { db, tenantId, actor: { userId: user.id, role: user.orgRole } };
}

describe('apps-core: apps-list read behavior + tenancy', () => {
  const admin = createSupabaseAdminClient();

  let orgA: SameTenantUser;
  let orgB: SameTenantUser;

  beforeAll(async () => {
    orgA = await createTenantWithOwner();
    orgB = await createTenantWithOwner();
  }, 60000);

  afterAll(async () => {
    await cleanupTenantAndUsers(orgA.tenantId, [orgA]);
    await cleanupTenantAndUsers(orgB.tenantId, [orgB]);
  });

  describe('read isolation', () => {
    it('a member of org A sees exactly A\'s apps under A\'s header, and none under a B header', async () => {
      const appName = `g1-isolation-${randomUUID().slice(0, 8)}`;
      const { error } = await admin.from('app').insert({ tenant_id: orgA.tenantId, name: appName });
      if (error) throw new Error(`seed app: ${error.message}`);

      const underA = await appsService.listAppsWithGitStatus(await ctxFor(orgA, orgA.tenantId));
      expect(underA.map((a) => a.name)).toContain(appName);

      // Non-member of B — createTenantScopedClient still builds the client,
      // but `X-Tenant-Id: B` for a caller with no membership in B resolves to
      // an empty, not an error: fail-closed, never an unfiltered list.
      const underB = await appsService.listAppsWithGitStatus(await ctxFor(orgA, orgB.tenantId));
      expect(underB).toEqual([]);

      await admin.from('app').delete().eq('tenant_id', orgA.tenantId).eq('name', appName);
    });
  });

  describe('list read shape', () => {
    it('pins isGitConnected/provider/repository/connectedBranch/environments for connected, unconnected, and legacy-gitlab rows', async () => {
      const suffix = randomUUID().slice(0, 8);

      const { data: connectedApp, error: e1 } = await admin
        .from('app')
        .insert({ tenant_id: orgA.tenantId, name: `f1-connected-${suffix}` })
        .select('id')
        .single();
      if (e1 || !connectedApp) throw new Error(`seed connected app: ${e1?.message}`);
      const { error: gcErr } = await admin.from('git_connection').insert({
        tenant_id: orgA.tenantId,
        app_id: connectedApp.id,
        provider: 'github',
        installation_id: uniqueInstallationId(),
        repository: 'acme/triage',
      });
      if (gcErr) throw new Error(`seed git_connection: ${gcErr.message}`);
      const { error: gbErr } = await admin.from('git_branch').insert({
        tenant_id: orgA.tenantId,
        app_id: connectedApp.id,
        branch_name: 'main',
        repo: 'acme/triage',
      });
      if (gbErr) throw new Error(`seed git_branch: ${gbErr.message}`);

      const { data: unconnectedApp, error: e2 } = await admin
        .from('app')
        .insert({ tenant_id: orgA.tenantId, name: `f1-unconnected-${suffix}` })
        .select('id')
        .single();
      if (e2 || !unconnectedApp) throw new Error(`seed unconnected app: ${e2?.message}`);

      // A legacy GitLab connection: provider is 'gitlab', no installation_id —
      // the removed provider's true-arm must not resurrect for this shape.
      const { data: legacyApp, error: e3 } = await admin
        .from('app')
        .insert({ tenant_id: orgA.tenantId, name: `f1-legacy-gitlab-${suffix}` })
        .select('id')
        .single();
      if (e3 || !legacyApp) throw new Error(`seed legacy app: ${e3?.message}`);
      const { error: gcLegacyErr } = await admin.from('git_connection').insert({
        tenant_id: orgA.tenantId,
        app_id: legacyApp.id,
        provider: 'gitlab',
        installation_id: null,
        repository: 'acme/legacy',
      });
      if (gcLegacyErr) throw new Error(`seed legacy git_connection: ${gcLegacyErr.message}`);

      try {
        const rows = await appsService.listAppsWithGitStatus(await ctxFor(orgA, orgA.tenantId));

        const connected = rows.find((r) => r.id === connectedApp.id);
        expect(connected).toEqual(
          expect.objectContaining({
            isGitConnected: true,
            provider: 'github',
            repository: 'acme/triage',
            connectedBranch: 'main',
          }),
        );

        const unconnected = rows.find((r) => r.id === unconnectedApp.id);
        expect(unconnected).toEqual(
          expect.objectContaining({
            isGitConnected: false,
            provider: null,
            repository: null,
          }),
        );

        const legacy = rows.find((r) => r.id === legacyApp.id);
        expect(legacy).toEqual(
          expect.objectContaining({
            isGitConnected: false,
            provider: 'gitlab',
            repository: 'acme/legacy',
          }),
        );
      } finally {
        await admin.from('git_branch').delete().eq('app_id', connectedApp.id);
        await admin.from('git_connection').delete().in('app_id', [connectedApp.id, legacyApp.id]);
        await admin.from('app').delete().in('id', [connectedApp.id, unconnectedApp.id, legacyApp.id]);
      }
    });
  });

  describe('projection + embed disambiguation', () => {
    it('resolves git_connection/git_branch/environment embeds without a PostgREST ambiguous-relationship error', async () => {
      // git_connection/git_branch/environment each carry a second
      // (tenant_id, app_id) composite FK alongside the original app_id-only
      // FK. Dropping the service's `!<fk_name>` hints makes PostgREST refuse
      // to guess — this call throwing IS the failure mode this case pins.
      const appName = `f2-embed-${randomUUID().slice(0, 8)}`;
      const { data: app, error } = await admin
        .from('app')
        .insert({ tenant_id: orgA.tenantId, name: appName })
        .select('id')
        .single();
      if (error || !app) throw new Error(`seed app: ${error?.message}`);

      await admin.from('git_connection').insert({
        tenant_id: orgA.tenantId,
        app_id: app.id,
        provider: 'github',
        installation_id: uniqueInstallationId(),
        repository: 'acme/embed-check',
      });

      try {
        const rows = await appsService.listAppsWithGitStatus(await ctxFor(orgA, orgA.tenantId));
        const row = rows.find((r) => r.id === app.id);
        expect(row).toEqual(
          expect.objectContaining({
            id: app.id,
            name: appName,
            isGitConnected: true,
            provider: 'github',
            repository: 'acme/embed-check',
          }),
        );
        // The explicit projection means unrendered columns are absent at
        // runtime, not merely untyped — a regression to `select("*")` would
        // pass every assertion above but fail this one.
        expect(row).not.toHaveProperty('tenant_id');
        expect(row).not.toHaveProperty('runtime');
      } finally {
        await admin.from('git_connection').delete().eq('app_id', app.id);
        await admin.from('app').delete().eq('id', app.id);
      }
    });

    it('orders apps newest-first by created_at', async () => {
      const suffix = randomUUID().slice(0, 8);
      const { data: older, error: e1 } = await admin
        .from('app')
        .insert({ tenant_id: orgA.tenantId, name: `f2-order-older-${suffix}`, created_at: '2020-01-01T00:00:00Z' })
        .select('id')
        .single();
      if (e1 || !older) throw new Error(`seed older app: ${e1?.message}`);
      const { data: newer, error: e2 } = await admin
        .from('app')
        .insert({ tenant_id: orgA.tenantId, name: `f2-order-newer-${suffix}`, created_at: '2020-01-02T00:00:00Z' })
        .select('id')
        .single();
      if (e2 || !newer) throw new Error(`seed newer app: ${e2?.message}`);

      try {
        const rows = await appsService.listAppsWithGitStatus(await ctxFor(orgA, orgA.tenantId));
        const ids = rows.map((r) => r.id);
        expect(ids.indexOf(newer.id)).toBeLessThan(ids.indexOf(older.id));
      } finally {
        await admin.from('app').delete().in('id', [older.id, newer.id]);
      }
    });
  });
});
