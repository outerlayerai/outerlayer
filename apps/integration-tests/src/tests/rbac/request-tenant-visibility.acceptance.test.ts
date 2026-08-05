/**
 * Request-tenant acceptance — tenant visibility and role scoping, asserted as
 * business behavior through the real PostgREST → RLS wire path.
 *
 * A dashboard request derives its tenant from the URL org and sends it as an
 * `X-Tenant-Id` header; the database validates that header against the caller's
 * active membership and scopes every read and write to it (fail-closed on a
 * non-member header). These tests drive that exact path with a header-scoped,
 * authenticated client and assert the OUTCOME a user would observe — which rows
 * they see, whether a write lands — never the header wiring itself.
 *
 * This is the business-behavior complement to the resolver-layer dual-source
 * test (rbac/dual-source-tenancy.test.ts): that one pins the SQL resolver via
 * raw pg; this one proves the same guarantees survive end-to-end through Kong.
 */

import { describe, it, beforeAll, afterAll, expect } from 'vitest';
import { randomUUID } from 'crypto';
import { createSupabaseAdminClient } from '../../lib/supabase-admin';
import { createTenantScopedClient } from '../../lib/tenant-scoped-client';
import { createTenantWithOwner, addUserToTenant, SameTenantUser } from '../app-level-roles/helpers';

describe('request-tenant visibility and role scoping', () => {
  const admin = createSupabaseAdminClient();

  // Two orgs, each seeded with its own apps. Exact app ids are the visibility
  // assertions below.
  let orgA: SameTenantUser; // owner of A, member of A only
  let orgB: SameTenantUser; // owner of B, member of B only
  let dualRole: SameTenantUser; // admin in A, read-only in B; claim names A

  let appA1: string;
  let appA2: string;
  let appB1: string;

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

    // The cross-tenant actor: signed in with a claim naming org A (admin), then
    // granted a second, read-only membership in org B directly. The header path
    // re-resolves the role from membership live, so this stale-friendly claim is
    // exactly the confusion the URL-scoped tenant resolution closes.
    dualRole = await addUserToTenant(orgA.tenantId, 'admin');
    const { error: bMembershipError } = await admin.from('membership').insert({
      user_id: dualRole.id,
      tenant_id: orgB.tenantId,
      role: 'read',
      status: 'active',
    });
    if (bMembershipError) throw new Error(`dual-role B membership: ${bMembershipError.message}`);

    const suffix = randomUUID().slice(0, 8);
    appA1 = await seedApp(`accept-a1-${suffix}`, orgA.tenantId, orgA.id);
    appA2 = await seedApp(`accept-a2-${suffix}`, orgA.tenantId, orgA.id);
    appB1 = await seedApp(`accept-b1-${suffix}`, orgB.tenantId, orgB.id);
  }, 90000);

  afterAll(async () => {
    // Dependency order: apps → memberships → profiles/auth users → tenants.
    await admin.from('app').delete().in('tenant_id', [orgA.tenantId, orgB.tenantId]);
    await admin.from('membership').delete().in('user_id', [orgA.id, orgB.id, dualRole.id]);
    for (const user of [orgA, orgB, dualRole]) {
      await admin.from('profile').delete().eq('id', user.id);
      try {
        await admin.auth.admin.deleteUser(user.id);
      } catch {
        // best-effort; a leaked auth user does not affect other suites
      }
    }
    await admin.from('tenant').delete().in('tenant_id', [orgA.tenantId, orgB.tenantId]);
  });

  it("a member operating under their org sees exactly that org's apps, and none of another org's", async () => {
    const asA = await createTenantScopedClient(orgA, orgA.tenantId);

    const { data, error } = await asA.from('app').select('id');
    expect(error).toBeNull();
    expect((data ?? []).map((r) => r.id).sort()).toEqual([appA1, appA2].sort());

    // Org B's app is never reachable under org A, even probed by its exact id.
    const { data: crossOrgProbe, error: probeError } = await asA
      .from('app')
      .select('id')
      .eq('id', appB1);
    expect(probeError).toBeNull();
    expect(crossOrgProbe).toEqual([]);
  });

  it('operating under an org the user does not belong to yields no reads and a denied write', async () => {
    // orgA's owner is not a member of orgB — the fail-closed / spoof case.
    const asBSpoof = await createTenantScopedClient(orgA, orgB.tenantId);

    const { data: reads, error: readError } = await asBSpoof.from('app').select('id');
    expect(readError).toBeNull();
    expect(reads).toEqual([]);

    const { data: probe, error: probeError } = await asBSpoof
      .from('app')
      .select('id')
      .eq('id', appB1);
    expect(probeError).toBeNull();
    expect(probe).toEqual([]);

    // The write fails at the DB: the header resolves to no tenant, so RLS has
    // no tenant to admit the row into.
    const { data: inserted, error: writeError } = await asBSpoof
      .from('app')
      .insert({ name: `accept-spoof-${randomUUID().slice(0, 8)}`, tenant_id: orgB.tenantId })
      .select('id');
    expect(writeError).not.toBeNull();
    expect(inserted).toBeNull();

    // Org B still holds exactly its seeded app — nothing leaked in.
    const { data: bApps } = await admin.from('app').select('id').eq('tenant_id', orgB.tenantId);
    expect((bApps ?? []).map((r) => r.id)).toEqual([appB1]);
  });

  it("a user admin in one org but read-only in another gets the operating org's role, not the claim's", async () => {
    // Claim names org A (admin). Under org B the same user is only a reader.
    const asBReader = await createTenantScopedClient(dualRole, orgB.tenantId);

    // Read is allowed in B (a reader holds app.read): org B's app is visible.
    const { data: bReads, error: bReadError } = await asBReader.from('app').select('id');
    expect(bReadError).toBeNull();
    expect((bReads ?? []).map((r) => r.id)).toEqual([appB1]);

    // The write is denied in B despite the admin claim — the role follows org B.
    const { error: bWriteError } = await asBReader
      .from('app')
      .insert({ name: `accept-brole-${randomUUID().slice(0, 8)}`, tenant_id: orgB.tenantId })
      .select('id');
    expect(bWriteError).not.toBeNull();

    // Under org A, where the same user is an admin, the equivalent write lands.
    const asAAdmin = await createTenantScopedClient(dualRole, orgA.tenantId);
    const createdName = `accept-arole-${randomUUID().slice(0, 8)}`;
    const { data: aWrite, error: aWriteError } = await asAAdmin
      .from('app')
      .insert({ name: createdName, tenant_id: orgA.tenantId })
      .select('id, tenant_id')
      .single();
    expect(aWriteError).toBeNull();
    expect(aWrite?.tenant_id).toBe(orgA.tenantId);

    // Keep org A's app set at its two seeded rows for the assertions above.
    if (aWrite?.id) await admin.from('app').delete().eq('id', aWrite.id);
  });

  it('with no tenant header the claim scopes the request to the same org and the same rows', async () => {
    // The fixture client sends no X-Tenant-Id; the claim (app_metadata.tenant_id
    // = org A) scopes the request, exactly as it does today before the flip.
    const { data: claimData, error: claimError } = await orgA.client.from('app').select('id');
    expect(claimError).toBeNull();
    const claimIds = (claimData ?? []).map((r: { id: string }) => r.id).sort();
    expect(claimIds).toEqual([appA1, appA2].sort());

    // The header-scoped path for the same org yields the identical business
    // outcome — claim/header equivalence at the level a user observes.
    const asA = await createTenantScopedClient(orgA, orgA.tenantId);
    const { data: headerData } = await asA.from('app').select('id');
    expect((headerData ?? []).map((r) => r.id).sort()).toEqual(claimIds);
  });
});
