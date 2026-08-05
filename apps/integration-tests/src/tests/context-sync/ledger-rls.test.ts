/**
 * Integration: RLS on `context_sync_event`. The History panel reads this table
 * through the tenant-scoped (authenticated) client, gated on
 * `app_authorize('context.read', app_id) AND tenant_id() = tenant_id`. Writes
 * are service-role only. Verifies a same-tenant member reads its app's events,
 * a cross-tenant member cannot, and anon cannot.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createClient } from '@supabase/supabase-js';
import { createSupabaseAdminClient } from '../../lib/supabase-admin';
import { createAuthenticatedUser, cleanupTestUsers } from '../../lib/test-utils';

const admin = createSupabaseAdminClient();

describe('context-sync · context_sync_event RLS', () => {
  let tenantId: string;
  let appId: string;
  let eventId: string;
  let member: Awaited<ReturnType<typeof createAuthenticatedUser>>;
  let outsider: Awaited<ReturnType<typeof createAuthenticatedUser>>;

  beforeAll(async () => {
    member = await createAuthenticatedUser('owner');
    outsider = await createAuthenticatedUser('owner');
    tenantId = member.tenantId;

    const { data: app, error: appErr } = await admin
      .from('app')
      .insert({ tenant_id: tenantId, name: `rls-ctx-${Date.now()}` })
      .select('id')
      .single();
    if (appErr || !app) throw new Error(`seed app: ${appErr?.message}`);
    appId = app.id;

    const { data: event, error: evErr } = await admin
      .from('context_sync_event')
      .insert({
        app_id: appId,
        tenant_id: tenantId,
        branch: 'main',
        commit_sha: 'sha-rls-1',
        commit_message: 'seed',
        trigger: 'link',
        status: 'synced',
        error: null,
      })
      .select('id')
      .single();
    if (evErr || !event) throw new Error(`seed event: ${evErr?.message}`);
    eventId = event.id;
  });

  afterAll(async () => {
    await admin.from('context_sync_event').delete().eq('app_id', appId);
    await admin.from('environment').delete().eq('app_id', appId);
    await admin.from('app').delete().eq('id', appId);
    await cleanupTestUsers();
  });

  it('a same-tenant member with context.read reads the event', async () => {
    const { data, error } = await member.client
      .from('context_sync_event')
      .select('id, trigger, status, commit_sha')
      .eq('id', eventId);

    expect(error).toBeNull();
    expect(data).toEqual([{ id: eventId, trigger: 'link', status: 'synced', commit_sha: 'sha-rls-1' }]);
  });

  it('a cross-tenant member cannot read the event', async () => {
    const { data, error } = await outsider.client
      .from('context_sync_event')
      .select('id')
      .eq('app_id', appId);

    expect(error).toBeNull();
    expect(data).toEqual([]);
  });

  it('anon cannot read the event', async () => {
    const anon = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    );
    const { data } = await anon.from('context_sync_event').select('id').eq('id', eventId);
    expect(data ?? []).toEqual([]);
  });

  it('a member cannot write the ledger through the tenant-scoped client (service-role only)', async () => {
    const { error } = await member.client.from('context_sync_event').insert({
      app_id: appId,
      tenant_id: tenantId,
      branch: 'main',
      commit_sha: 'sha-rls-hack',
      trigger: 'push',
      status: 'synced',
      error: null,
    });
    expect(error).not.toBeNull();
    expect(error!.message).toContain('row-level security');
  });
});
