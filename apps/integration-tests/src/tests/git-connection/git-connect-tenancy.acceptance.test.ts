/**
 * Git-connect tenancy acceptance — a connection lands under the tenant carried
 * by the HMAC-signed OAuth state, validated at the DB against membership, with
 * no dependence on the session claim.
 *
 * The OAuth provider round-trip cannot run in CI, so these tests enter at the
 * callback's DB-write boundary with a real, signature-valid state: they mint it
 * with `signGitConnectState` (the gateway lib) and verify it exactly as the
 * callback does, then issue the connection upsert through a client scoped to
 * `verified.payload.tenant_id` via `X-Tenant-Id` — the same wire path the route
 * builds. This exercises the real RLS + `set_tenant_id()` trigger the tenancy
 * claim rests on.
 */

import { describe, it, beforeAll, afterAll, expect } from 'vitest';
import { createSupabaseAdminClient } from '../../lib/supabase-admin';
import { createTenantScopedClient } from '../../lib/tenant-scoped-client';
import { createTenantWithOwner, addUserToTenant, SameTenantUser } from '../app-level-roles/helpers';
import { signGitConnectState } from '@repo/gateway-core/lib/git-connect-state';
import { verifySignedGitConnectState } from 'tenant-dashboard/src/lib/git-connect/verify-state';
import type { Database } from 'tenant-dashboard/src/types/db';

type GitConnectionInsert = Database['public']['Tables']['git_connection']['Insert'];

// The signed state is symmetric HMAC — the mint and verify halves share this
// secret. In production it is `OAUTH_STATE_SECRET`, mirrored gateway↔dashboard;
// the integration env does not expose it, so the harness pins its own.
const STATE_SECRET = 'integration-oauth-state-secret-at-least-32-chars';

describe('git-connect lands under the signed-state tenant, rejects a foreign tenant', () => {
  const admin = createSupabaseAdminClient();

  let orgA: SameTenantUser; // target org; also seeds its apps
  let orgB: SameTenantUser; // the actor's CLAIM org
  let orgC: SameTenantUser; // an org the actor is NOT a member of
  // Signed in with a claim naming org B, but also an admin in org A — the
  // divergent-claim actor. If a connect followed the claim it would land in B.
  let actor: SameTenantUser;

  let appAForActor: string;
  let appAForOwner: string;
  let appC: string;

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
    orgC = await createTenantWithOwner();

    // Claim names org B; a direct second membership makes the actor an admin in
    // org A as well, so the org-A connect is a legitimate write there.
    actor = await addUserToTenant(orgB.tenantId, 'admin');
    const { error: aMembershipError } = await admin.from('membership').insert({
      user_id: actor.id,
      tenant_id: orgA.tenantId,
      role: 'admin',
      status: 'active',
    });
    if (aMembershipError) throw new Error(`actor org-A membership: ${aMembershipError.message}`);

    appAForActor = await seedApp('gc-a-actor', orgA.tenantId, orgA.id);
    appAForOwner = await seedApp('gc-a-owner', orgA.tenantId, orgA.id);
    appC = await seedApp('gc-c', orgC.tenantId, orgC.id);
  }, 90000);

  afterAll(async () => {
    const tenantIds = [orgA.tenantId, orgB.tenantId, orgC.tenantId];
    // git_connection cascade-deletes with its app; drop apps first, then the
    // rest in dependency order.
    await admin.from('git_connection').delete().in('tenant_id', tenantIds);
    await admin.from('app').delete().in('tenant_id', tenantIds);
    await admin.from('membership').delete().in('user_id', [orgA.id, orgB.id, orgC.id, actor.id]);
    for (const user of [orgA, orgB, orgC, actor]) {
      await admin.from('profile').delete().eq('id', user.id);
      try {
        await admin.auth.admin.deleteUser(user.id);
      } catch {
        // best-effort; a leaked auth user does not affect other suites
      }
    }
    await admin.from('tenant').delete().in('tenant_id', tenantIds);
  });

  it('a divergent-claim connect lands under the signed-state tenant, not the claim tenant', async () => {
    // Mint + verify the state exactly as the callback does: the tenant it lands
    // under is `verified.payload.tenant_id` (org A), while the actor's claim is org B.
    const { token } = await signGitConnectState({
      secret: STATE_SECRET,
      appId: appAForActor,
      tenantId: orgA.tenantId,
      provider: 'github',
    });
    const verified = await verifySignedGitConnectState({ secret: STATE_SECRET, token });
    expect(verified.ok).toBe(true);
    if (!verified.ok) return;
    expect(verified.payload.tenant_id).toBe(orgA.tenantId);

    const scoped = await createTenantScopedClient(actor, verified.payload.tenant_id);
    const { error } = await scoped.from('git_connection').upsert(
      { app_id: appAForActor, provider: 'github', installation_id: 111, repository: null } as GitConnectionInsert,
      { onConflict: 'tenant_id, app_id' },
    );
    expect(error).toBeNull();

    // The row landed under org A (the state tenant), never org B (the claim).
    const { data: rows } = await admin
      .from('git_connection')
      .select('tenant_id, app_id')
      .eq('app_id', appAForActor);
    expect(rows).toEqual([{ tenant_id: orgA.tenantId, app_id: appAForActor }]);

    // Invisible to the actor operating under org B — it is not org B's row.
    const asB = await createTenantScopedClient(actor, orgB.tenantId);
    const { data: bView, error: bError } = await asB
      .from('git_connection')
      .select('id')
      .eq('app_id', appAForActor);
    expect(bError).toBeNull();
    expect(bView).toEqual([]);
  });

  it('a signed state for a tenant the user does not belong to writes nothing', async () => {
    // Org C is validly signed, but the actor is not a member — public.tenant_id()
    // resolves to null and the write is denied at the DB, fail-closed.
    const { token } = await signGitConnectState({
      secret: STATE_SECRET,
      appId: appC,
      tenantId: orgC.tenantId,
      provider: 'github',
    });
    const verified = await verifySignedGitConnectState({ secret: STATE_SECRET, token });
    expect(verified.ok).toBe(true);
    if (!verified.ok) return;

    const scoped = await createTenantScopedClient(actor, verified.payload.tenant_id);
    const { error } = await scoped.from('git_connection').upsert(
      { app_id: appC, provider: 'github', installation_id: 222, repository: null } as GitConnectionInsert,
      { onConflict: 'tenant_id, app_id' },
    );
    expect(error).not.toBeNull();

    // Nothing landed for appC — not under org C, not anywhere.
    const { data: rows } = await admin.from('git_connection').select('id').eq('app_id', appC);
    expect(rows).toEqual([]);
  });

  it('a single-org connect (state tenant == the only org) lands the row', async () => {
    const { token } = await signGitConnectState({
      secret: STATE_SECRET,
      appId: appAForOwner,
      tenantId: orgA.tenantId,
      provider: 'github',
    });
    const verified = await verifySignedGitConnectState({ secret: STATE_SECRET, token });
    expect(verified.ok).toBe(true);
    if (!verified.ok) return;

    // orgA's owner is a single-org user; the state names their only org.
    const scoped = await createTenantScopedClient(orgA, verified.payload.tenant_id);
    const { error } = await scoped.from('git_connection').upsert(
      { app_id: appAForOwner, provider: 'github', installation_id: 333, repository: null } as GitConnectionInsert,
      { onConflict: 'tenant_id, app_id' },
    );
    expect(error).toBeNull();

    const { data: rows } = await admin
      .from('git_connection')
      .select('tenant_id')
      .eq('app_id', appAForOwner);
    expect(rows).toEqual([{ tenant_id: orgA.tenantId }]);
  });
});
