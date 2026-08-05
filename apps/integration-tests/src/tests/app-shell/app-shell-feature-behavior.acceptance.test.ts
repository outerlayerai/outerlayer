/**
 * Acceptance: app resolution by name (`getAppByName`) and the app-list seed
 * read (`listOrgApps`) — the two RSC companions that seed `AppContext` /
 * `AppSelect` once per request instead of the client running its own query.
 *
 * Both call `createSupabaseServerClient` (next/headers) directly — the same
 * Next.js request-scope gap as every other domain — so they can't be invoked
 * as exported functions here. Both are thin: one Supabase query each, with no
 * branching beyond that. The identical query is run here through a real
 * `X-Tenant-Id`-scoped client (the same wire `createSupabaseServerClient`
 * builds), which exercises the RLS/query shape the functions depend on.
 *
 * has-traces (the app-shell's third resolution surface) is already covered
 * in onboarding-feature-behavior.acceptance.test.ts — cited, not duplicated.
 */

import { describe, it, beforeAll, afterAll, expect } from 'vitest';
import { randomUUID } from 'crypto';
import { createSupabaseAdminClient } from '../../lib/supabase-admin';
import { createTenantScopedClient } from '../../lib/tenant-scoped-client';
import { createTenantWithOwner, cleanupTenantAndUsers, type SameTenantUser } from '../custom-roles/helpers';

describe('app-shell feature behavior — getAppByName + listOrgApps query shape', () => {
  const admin = createSupabaseAdminClient();

  let owner: SameTenantUser;
  let otherOrg: SameTenantUser;
  const suffix = randomUUID().slice(0, 8);
  const ownAppName = `shell-own-${suffix}`;
  const foreignAppName = `shell-foreign-${suffix}`;
  let ownAppId: string;
  let secondOwnAppId: string;
  let foreignAppId: string;

  beforeAll(async () => {
    owner = await createTenantWithOwner();
    otherOrg = await createTenantWithOwner();

    const { data: app, error } = await admin
      .from('app')
      .insert({ name: ownAppName, display_name: 'Own App', tenant_id: owner.tenantId, created_by: owner.id })
      .select('id')
      .single();
    if (error) throw new Error(`app insert: ${error.message}`);
    ownAppId = app!.id;

    const { data: second, error: secondError } = await admin
      .from('app')
      .insert({ name: `shell-b-${suffix}`, display_name: null, tenant_id: owner.tenantId, created_by: owner.id })
      .select('id')
      .single();
    if (secondError) throw new Error(`second app insert: ${secondError.message}`);
    secondOwnAppId = second!.id;

    const { data: foreignApp, error: foreignError } = await admin
      .from('app')
      .insert({ name: foreignAppName, tenant_id: otherOrg.tenantId, created_by: otherOrg.id })
      .select('id')
      .single();
    if (foreignError) throw new Error(`foreign app insert: ${foreignError.message}`);
    foreignAppId = foreignApp!.id;
  }, 60000);

  afterAll(async () => {
    await cleanupTenantAndUsers(owner.tenantId, [owner]);
    await cleanupTenantAndUsers(otherOrg.tenantId, [otherOrg]);
  });

  describe('getAppByName resolution', () => {
    it('resolves the caller’s own app by name', async () => {
      const scoped = await createTenantScopedClient(owner, owner.tenantId);
      const { data, error } = await scoped
        .from('app')
        // Mirrors getAppByName's select, hints included. Two keys relate these
        // tables to app — the original app_id one and the composite
        // (tenant_id, app_id) — so an unhinted embed fails with PGRST201.
        .select('*, git_connection!git_connection_app_id_fkey(app_id, repository, provider), git_branch!github_branch_app_id_fkey(branch_name)')
        .eq('name', ownAppName)
        .single();

      expect(error).toBeNull();
      expect(data?.id).toBe(ownAppId);
      expect(data?.git_connection).toEqual([]);
      expect(data?.git_branch).toEqual([]);
    });

    it('a foreign tenant’s app name never resolves under the caller’s own tenant scope — no cross-tenant leak by name', async () => {
      const scoped = await createTenantScopedClient(owner, owner.tenantId);
      const { data, error } = await scoped
        .from('app')
        .select('id')
        .eq('name', foreignAppName)
        .maybeSingle();

      expect(error).toBeNull();
      expect(data).toBeNull();
    });

    it('the same app name resolves to a DIFFERENT row under the org that actually owns it — same spelling, no collision', async () => {
      const scoped = await createTenantScopedClient(otherOrg, otherOrg.tenantId);
      const { data, error } = await scoped.from('app').select('id').eq('name', foreignAppName).single();

      expect(error).toBeNull();
      expect(data?.id).toEqual(expect.any(String));
      expect(data?.id).not.toBe(ownAppId);
    });
  });

  describe('listOrgApps seed read', () => {
    it('a member sees exactly their own org’s apps, exact projection, name-ascending order', async () => {
      const scoped = await createTenantScopedClient(owner, owner.tenantId);
      const { data, error } = await scoped.from('app').select('id, name, display_name').order('name', { ascending: true });

      expect(error).toBeNull();
      expect((data ?? []).map((r) => r.id)).not.toContain(foreignAppId);

      const rows = (data ?? []).filter((r) => [ownAppId, secondOwnAppId].includes(r.id));
      expect(rows).toEqual([
        { id: secondOwnAppId, name: `shell-b-${suffix}`, display_name: null },
        { id: ownAppId, name: ownAppName, display_name: 'Own App' },
      ]);
    });

    it('a foreign tenant never sees this org’s apps in its own list read', async () => {
      const scoped = await createTenantScopedClient(otherOrg, otherOrg.tenantId);
      const { data, error } = await scoped.from('app').select('id, name, display_name');

      expect(error).toBeNull();
      const ids = (data ?? []).map((r) => r.id);
      expect(ids).not.toContain(ownAppId);
      expect(ids).not.toContain(secondOwnAppId);
    });
  });
});
