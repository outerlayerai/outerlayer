/**
 * has-traces request-tenant flip — acceptance (Supabase side).
 *
 * Every analytics route authorizes through `verifyAppAccess`: it resolves the
 * requested app UNDER the resolved tenant and denies (ForbiddenError → 403)
 * when that tenant is not the caller's. This slice flips that resolved tenant
 * to prefer the URL-derived request tenant (the X-Tenant-Id header the
 * middleware attaches) over the JWT claim; has-traces is the route it flips.
 *
 * These tests drive that gate through the real header-scoped wire — the same
 * single-app lookup `verifyAppAccess` runs, under an authenticated,
 * X-Tenant-Id-scoped client that `public.tenant_id()` validates against live
 * membership — and assert the OUTCOME has-traces produces: the gate opens for a
 * member's own tenant (has-traces then runs its existence read), a non-member
 * request tenant is denied even pointed straight at the app id, and with no
 * header the claim still serves (coexistence). The ClickHouse existence read
 * behind an open gate is proven by the cross-tenant leak test.
 */

import { describe, it, beforeAll, afterAll, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createSupabaseAdminClient } from '../../lib/supabase-admin';
import { createTenantScopedClient } from '../../lib/tenant-scoped-client';
import { createTenantWithOwner, type SameTenantUser } from '../app-level-roles/helpers';

/** The exact lookup verifyAppAccess runs — the analytics auth gate. Returns the
 * app id when the gate opens, or null when it denies. */
async function resolveAppUnderTenant(
  user: SameTenantUser,
  requestTenantId: string,
  appId: string,
): Promise<string | null> {
  const scoped = await createTenantScopedClient(user, requestTenantId);
  const { data } = await scoped
    .from('app')
    .select('id')
    .eq('id', appId)
    .eq('tenant_id', requestTenantId)
    .maybeSingle();
  return data?.id ?? null;
}

describe('has-traces auth gate under the request-tenant flip', () => {
  const admin = createSupabaseAdminClient();

  let orgA: SameTenantUser; // caller, member of A only
  let orgB: SameTenantUser; // a foreign tenant the caller does not belong to
  let appA: string;
  let appB: string;

  const seedApp = async (name: string, tenantId: string, createdBy: string): Promise<string> => {
    const { data, error } = await admin
      .from('app')
      .insert({ name, tenant_id: tenantId, created_by: createdBy })
      .select('id')
      .single();
    if (error) throw new Error(`seed app ${name}: ${error.message}`);
    return data!.id;
  };

  beforeAll(async () => {
    orgA = await createTenantWithOwner();
    orgB = await createTenantWithOwner();
    const suffix = randomUUID().slice(0, 8);
    appA = await seedApp(`has-traces-a-${suffix}`, orgA.tenantId, orgA.id);
    appB = await seedApp(`has-traces-b-${suffix}`, orgB.tenantId, orgB.id);
  }, 90000);

  afterAll(async () => {
    await admin.from('app').delete().in('tenant_id', [orgA.tenantId, orgB.tenantId]);
    await admin.from('membership').delete().in('user_id', [orgA.id, orgB.id]);
    for (const user of [orgA, orgB]) {
      await admin.from('profile').delete().eq('id', user.id);
      try {
        await admin.auth.admin.deleteUser(user.id);
      } catch {
        // best-effort; a leaked auth user does not affect other suites
      }
    }
    await admin.from('tenant').delete().in('tenant_id', [orgA.tenantId, orgB.tenantId]);
  });

  it('opens the gate for a member operating under their own request tenant', async () => {
    // has-traces would proceed to its ClickHouse existence read.
    await expect(resolveAppUnderTenant(orgA, orgA.tenantId, appA)).resolves.toBe(appA);
  });

  it('denies a request tenant the caller is not an active member of (→ 403), even pointed at the app id', async () => {
    // The middleware would not mint this header for a non-member, but the gate
    // must fail closed if one ever reaches it: public.tenant_id() resolves to no
    // tenant, RLS returns no row, verifyAppAccess throws ForbiddenError.
    await expect(resolveAppUnderTenant(orgA, orgB.tenantId, appB)).resolves.toBeNull();
    await expect(resolveAppUnderTenant(orgA, orgB.tenantId, appA)).resolves.toBeNull();
  });

  it("denies an app from another tenant even under the caller's own request tenant", async () => {
    // Cross-tenant app id under a legitimate request tenant: the tenant_id
    // predicate finds no row — a stale claim could not rescue it.
    await expect(resolveAppUnderTenant(orgA, orgA.tenantId, appB)).resolves.toBeNull();
  });

  it('serves the JWT claim when no request-tenant header is present (coexistence)', async () => {
    // The caller's own client sends no X-Tenant-Id; the claim (org A) scopes the
    // lookup, exactly as it does before the flip.
    const { data } = await orgA.client
      .from('app')
      .select('id')
      .eq('id', appA)
      .eq('tenant_id', orgA.tenantId)
      .maybeSingle();
    expect((data as { id: string } | null)?.id ?? null).toBe(appA);
  });
});
