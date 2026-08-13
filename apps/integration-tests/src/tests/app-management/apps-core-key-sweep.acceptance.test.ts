/**
 * Acceptance: `deleteAppAction`'s api_key sweep runs the exact query shape
 * `features/apps/actions.ts` issues on `ctx.db` — `api_key` DELETE filtered
 * by `app_id`, under a header-scoped, real-RLS client. A
 * wrong-tenant scope must match no rows, not error and not silently touch
 * the row — the fail-silent shape the standalone action always had, pinned
 * as a tripwire so a future RLS change surfaces here.
 *
 * Driven through `createTenantScopedClient` (real Kong → PostgREST, real
 * RLS) rather than the Next.js action itself — no Next.js request scope is
 * needed to prove the DB-level boundary the action's sweep step relies on.
 */

import { randomUUID } from 'crypto';
import { createTenantWithOwner, cleanupTenantAndUsers, type SameTenantUser } from '../app-level-roles/helpers';
import { createTenantScopedClient } from '../../lib/tenant-scoped-client';
import { createSupabaseAdminClient } from '../../lib/supabase-admin';

describe('apps-core: api_key sweep tenant scoping', () => {
  const admin = createSupabaseAdminClient();

  let orgA: SameTenantUser;
  let orgB: SameTenantUser;
  let appInA: string;
  let apiKeyId: string;

  beforeAll(async () => {
    orgA = await createTenantWithOwner();
    orgB = await createTenantWithOwner();

    const { data: app, error } = await admin
      .from('app')
      .insert({ tenant_id: orgA.tenantId, name: `g5-sweep-${randomUUID().slice(0, 8)}` })
      .select('id')
      .single();
    if (error || !app) throw new Error(`seed app: ${error?.message}`);
    appInA = app.id;

    const { data: key, error: keyError } = await admin
      .from('api_key')
      .insert({
        tenant_id: orgA.tenantId,
        app_id: appInA,
        name: 'g5-sweep-key',
        api_key_id: `g5_${randomUUID().slice(0, 8)}`,
        // chk_api_key_scope_present requires either environment_id or
        // allowed_env_kinds — a kind-scoped key sidesteps needing a real
        // environment row for this test.
        allowed_env_kinds: ['development'],
      })
      .select('id')
      .single();
    if (keyError || !key) throw new Error(`seed api_key: ${keyError?.message}`);
    apiKeyId = key.id;
  }, 60000);

  afterAll(async () => {
    await admin.from('api_key').delete().eq('app_id', appInA);
    await admin.from('app').delete().eq('id', appInA);
    await cleanupTenantAndUsers(orgA.tenantId, [orgA]);
    await cleanupTenantAndUsers(orgB.tenantId, [orgB]);
  });

  // proves AC-060-13
  it('a wrong-tenant scope matches no rows and leaves the key untouched', async () => {
    // orgB's owner has no membership in A — a client scoped to A's app_id but
    // B's tenant header (RLS filters by public.tenant_id() from the header,
    // not the URL param) hits zero rows.
    const wrongTenantDb = await createTenantScopedClient(orgB, orgB.tenantId);
    const { error, data } = await wrongTenantDb
      .from('api_key')
      .delete()
      .eq('app_id', appInA)
      .select('id');

    expect(error).toBeNull();
    expect(data).toEqual([]);

    const { data: stillThere } = await admin.from('api_key').select('id').eq('id', apiKeyId).single();
    expect(stillThere?.id).toBe(apiKeyId);
  });

  it('the correct tenant scope sweeps the key', async () => {
    const rightTenantDb = await createTenantScopedClient(orgA, orgA.tenantId);
    const { error, data } = await rightTenantDb
      .from('api_key')
      .delete()
      .eq('app_id', appInA)
      .select('id');

    expect(error).toBeNull();
    expect((data ?? []).map((r) => r.id)).toEqual([apiKeyId]);

    const { data: gone } = await admin.from('api_key').select('id').eq('id', apiKeyId).maybeSingle();
    expect(gone).toBeNull();
  });
});
