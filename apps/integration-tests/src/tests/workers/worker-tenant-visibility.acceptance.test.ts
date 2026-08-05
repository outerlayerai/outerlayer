/**
 * Workers request-tenant acceptance — run visibility and the write-permission
 * gate, asserted as business behavior through the real PostgREST → RLS wire path
 * (Kong → PostgREST), not the header wiring.
 *
 * A dashboard request derives its tenant from the URL org and sends it as an
 * `X-Tenant-Id` header; `public.tenant_id()` validates it against the caller's
 * active membership and scopes every worker_run read/write to it (fail-closed on
 * a non-member header). These prove: a member sees exactly their org's runs; a
 * user operating under an org they don't belong to sees none (the spoof case the
 * client's polling refresh must survive); and a read-only role cannot dispatch or cancel a
 * run — the DB backstop under the action's permission gate.
 *
 * worker_run / worker_workspace are addressed through untyped clients: they are
 * absent from the integration-tests `Database` type, and casting keeps the
 * dynamic `.from(...)` honest.
 */

import { describe, it, beforeAll, afterAll, expect } from 'vitest';
import { randomUUID } from 'crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import { createSupabaseAdminClientUntyped } from '../../lib/supabase-admin';
import { createTenantScopedClient } from '../../lib/tenant-scoped-client';
import { createTenantWithOwner, addUserToTenant, SameTenantUser } from '../app-level-roles/helpers';

/** worker_run / worker_workspace live outside the typed Database — read them dynamically. */
const untyped = (client: { from: SupabaseClient['from'] }): SupabaseClient => client as unknown as SupabaseClient;

describe('workers request-tenant visibility and role scoping', () => {
  const admin = createSupabaseAdminClientUntyped();

  let orgA: SameTenantUser; // owner + member of A only
  let orgB: SameTenantUser; // owner + member of B only
  let readerA: SameTenantUser; // read-only member of A

  let appA: string;
  let appB: string;
  let runA1: string;
  let runA2: string;

  const seedApp = async (name: string, tenantId: string, createdBy: string): Promise<string> => {
    const { data, error } = await admin
      .from('app')
      .insert({ name, tenant_id: tenantId, created_by: createdBy })
      .select('id')
      .single();
    if (error) throw new Error(`seed app ${name}: ${error.message}`);
    return data!.id as string;
  };

  const seedRun = async (appId: string, tenantId: string, createdBy: string, prompt: string): Promise<string> => {
    const { data, error } = await admin
      .from('worker_run')
      .insert({
        app_id: appId,
        tenant_id: tenantId,
        created_by: createdBy,
        agent: 'claude-code',
        task_prompt: prompt,
        base_branch: 'main',
        status: 'running',
        dispatch: 'local',
        wall_clock_cap_s: 1800,
      })
      .select('id')
      .single();
    if (error) throw new Error(`seed worker_run: ${error.message}`);
    return data!.id as string;
  };

  beforeAll(async () => {
    orgA = await createTenantWithOwner();
    orgB = await createTenantWithOwner();
    readerA = await addUserToTenant(orgA.tenantId, 'read');

    const suffix = randomUUID().slice(0, 8);
    appA = await seedApp(`worker-a-${suffix}`, orgA.tenantId, orgA.id);
    appB = await seedApp(`worker-b-${suffix}`, orgB.tenantId, orgB.id);
    runA1 = await seedRun(appA, orgA.tenantId, orgA.id, 'add a /health route');
    runA2 = await seedRun(appA, orgA.tenantId, orgA.id, 'fix the flaky test');
    await seedRun(appB, orgB.tenantId, orgB.id, "org B's own run");
  }, 90000);

  afterAll(async () => {
    await admin.from('worker_run').delete().in('tenant_id', [orgA.tenantId, orgB.tenantId]);
    await admin.from('app').delete().in('tenant_id', [orgA.tenantId, orgB.tenantId]);
    await admin.from('membership').delete().in('user_id', [orgA.id, orgB.id, readerA.id]);
    for (const user of [orgA, orgB, readerA]) {
      await admin.from('profile').delete().eq('id', user.id);
      try {
        await admin.auth.admin.deleteUser(user.id);
      } catch {
        // best-effort; a leaked auth user does not affect other suites
      }
    }
    await admin.from('tenant').delete().in('tenant_id', [orgA.tenantId, orgB.tenantId]);
  });

  it("a member operating under their org sees exactly that org's worker runs", async () => {
    const asA = untyped(await createTenantScopedClient(orgA, orgA.tenantId));

    const { data, error } = await asA.from('worker_run').select('id');
    expect(error).toBeNull();
    expect((data ?? []).map((r) => r.id).sort()).toEqual([runA1, runA2].sort());
  });

  it('operating under an org the user does not belong to yields no runs, even probed by id', async () => {
    // orgA's owner is not a member of orgB — the fail-closed spoof the // live:
    // poll must survive: the resolver returns NULL, so no rows are visible.
    const asBSpoof = untyped(await createTenantScopedClient(orgA, orgB.tenantId));

    const { data: reads, error: readError } = await asBSpoof.from('worker_run').select('id');
    expect(readError).toBeNull();
    expect(reads).toEqual([]);

    const { data: probe } = await asBSpoof.from('worker_run').select('id').eq('id', runA1);
    expect(probe).toEqual([]);
  });

  it('a read-only role cannot dispatch a run, while the owner can', async () => {
    const asReader = untyped(await createTenantScopedClient(readerA, orgA.tenantId));

    const { data: readerInsert, error: readerError } = await asReader
      .from('worker_run')
      .insert({
        app_id: appA,
        tenant_id: orgA.tenantId,
        agent: 'claude-code',
        task_prompt: 'reader should not be able to launch this',
        base_branch: 'main',
        status: 'queued',
        dispatch: 'local',
        wall_clock_cap_s: 1800,
      })
      .select('id');
    expect(readerError).not.toBeNull();
    expect(readerInsert).toBeNull();

    // The owner holds worker_run.insert, so the equivalent dispatch lands.
    const asOwner = untyped(await createTenantScopedClient(orgA, orgA.tenantId));
    const { data: ownerInsert, error: ownerError } = await asOwner
      .from('worker_run')
      .insert({
        app_id: appA,
        tenant_id: orgA.tenantId,
        agent: 'claude-code',
        task_prompt: 'owner launches a run',
        base_branch: 'main',
        status: 'queued',
        dispatch: 'local',
        wall_clock_cap_s: 1800,
      })
      .select('id')
      .single();
    expect(ownerError).toBeNull();
    expect(ownerInsert?.id).toEqual(expect.any(String));

    if (ownerInsert?.id) await admin.from('worker_run').delete().eq('id', ownerInsert.id);
  });

  it('a read-only role cannot cancel a run — its update matches no rows', async () => {
    const asReader = untyped(await createTenantScopedClient(readerA, orgA.tenantId));

    const { data: updated } = await asReader
      .from('worker_run')
      .update({ status: 'cancelled' })
      .eq('id', runA1)
      .select('id');
    // The UPDATE policy admits no row for a reader, so nothing is returned...
    expect(updated ?? []).toEqual([]);

    // ...and the run is untouched.
    const { data: still } = await admin.from('worker_run').select('status').eq('id', runA1).single();
    expect(still!.status).toBe('running');
  });
});
