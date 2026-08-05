/**
 * Acceptance: the app-policy pilot's request path over the real RLS wire.
 *
 * The pilot action issues one tenant-scoped `UPDATE app SET require_pull_request`
 * through a client carrying the URL-derived `X-Tenant-Id`. This drives that exact
 * operation through PostgREST → RLS with the header-scoped authed client and
 * asserts the business outcome, not the wiring:
 *   - a member of the URL org toggles the policy on its own app;
 *   - a non-member URL tenant leaves the row untouched (the resolver returns
 *     NULL, so RLS matches nothing) — never another tenant's data;
 *   - a member without app_policy.update is refused by the DB backstop and the
 *     row is untouched.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createSupabaseAdminClient } from '../../lib/supabase-admin';
import { createTenantScopedClient } from '../../lib/tenant-scoped-client';
import {
  addUserToTenant,
  cleanupTenantAndUsers,
  createTenantWithOwner,
  type SameTenantUser,
} from './helpers';

describe('app policy pilot — X-Tenant-Id → RLS', () => {
  const admin = createSupabaseAdminClient();
  let owner: SameTenantUser; // owner of tenant A (holds app_policy.update)
  let reader: SameTenantUser; // read-only member of tenant A
  let outsider: SameTenantUser; // owner of a DIFFERENT tenant, not a member of A
  let appId: string;

  const resetPolicy = async (value: boolean) => {
    const { error } = await admin
      .from('app')
      .update({ require_pull_request: value })
      .eq('id', appId);
    if (error) throw new Error(`reset policy: ${error.message}`);
  };

  const readPolicy = async (): Promise<boolean | null> => {
    const { data, error } = await admin
      .from('app')
      .select('require_pull_request')
      .eq('id', appId)
      .single();
    if (error) throw new Error(`read policy: ${error.message}`);
    return (data.require_pull_request as boolean | null) ?? null;
  };

  beforeAll(async () => {
    owner = await createTenantWithOwner();
    reader = await addUserToTenant(owner.tenantId, 'read');
    outsider = await createTenantWithOwner();

    const { data, error } = await admin
      .from('app')
      .insert({
        name: `Policy Pilot ${Date.now()}`,
        tenant_id: owner.tenantId,
        created_by: owner.id,
      })
      .select('id')
      .single();
    if (error) throw new Error(`app insert: ${error.message}`);
    appId = data.id;
  });

  afterAll(async () => {
    await cleanupTenantAndUsers(owner.tenantId, [owner, reader]);
    await cleanupTenantAndUsers(outsider.tenantId, [outsider]);
  });

  it('a member of the URL org toggles the policy on its own app', async () => {
    await resetPolicy(false);
    const client = await createTenantScopedClient(owner, owner.tenantId);

    const { error } = await client
      .from('app')
      .update({ require_pull_request: true })
      .eq('id', appId);

    expect(error).toBeNull();
    expect(await readPolicy()).toBe(true);
  });

  it('a non-member URL tenant leaves the row untouched', async () => {
    await resetPolicy(false);
    // outsider owns a different tenant; naming tenant A in the header does not
    // make them a member, so the resolver returns NULL and RLS matches no row.
    const client = await createTenantScopedClient(outsider, owner.tenantId);

    await client
      .from('app')
      .update({ require_pull_request: true })
      .eq('id', appId);

    expect(await readPolicy()).toBe(false);
  });

  it('a member without app_policy.update cannot toggle the policy', async () => {
    await resetPolicy(false);
    const client = await createTenantScopedClient(reader, owner.tenantId);

    await client
      .from('app')
      .update({ require_pull_request: true })
      .eq('id', appId);

    // The read-only member is not authorized to change app policy: RLS and the
    // enforce_app_policy_permission backstop keep the row unchanged — the same
    // UPDATE that landed for the owner does not land here.
    expect(await readPolicy()).toBe(false);
  });
});
