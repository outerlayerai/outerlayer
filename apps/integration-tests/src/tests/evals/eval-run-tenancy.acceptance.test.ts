/**
 * Eval-run acceptance — the benchmarks history read and the launch insert are
 * tenant- and permission-scoped, asserted as business behavior through the
 * real PostgREST → RLS wire path.
 *
 * A dashboard request derives its tenant from the URL org and sends it as an
 * `X-Tenant-Id` header; the `eval_run` policies gate SELECT on `eval_run.read`
 * + tenant match and INSERT on `eval_run.insert` + tenant match (`supabase/
 * schemas/71-eval-run.sql`). Unlike `env_escalation`, `eval_run` grants
 * `authenticated` its own INSERT policy — the dashboard's `launchEvalRun`
 * action is a thin, app-layer-first gate in front of it (a read-only actor is
 * refused before any Vault read or credential mint), but the DB check is the
 * backstop these tests exercise directly, the same way a bypassed or buggy
 * action body would still be stopped.
 *
 * `eval_run` is not in the generated Database type, so it is addressed
 * through an untyped client (mirrors the escalations acceptance test).
 */

import { describe, it, beforeAll, afterAll, expect } from 'vitest';
import { randomUUID } from 'crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import { createSupabaseAdminClientUntyped } from '../../lib/supabase-admin';
import { createTenantScopedClient } from '../../lib/tenant-scoped-client';
import { createTenantWithOwner, addUserToTenant, SameTenantUser } from '../app-level-roles/helpers';

/** Address eval_run (absent from the generated Database type) untyped. */
const untyped = (client: unknown) => client as SupabaseClient;

describe('eval_run reads and launches are tenant- and permission-scoped', () => {
  const admin = createSupabaseAdminClientUntyped();

  let orgA: SameTenantUser; // owner of A → holds eval_run.insert
  let orgB: SameTenantUser; // owner of B, member of B only
  let readerA: SameTenantUser; // read role in A → holds .read, NOT .insert
  let writerA: SameTenantUser; // write role in A → holds .read AND .insert, not owner

  let appA: string;
  let appB: string;
  let appHistoryA: string; // dedicated app for the history-projection read, isolated from runA's count
  let runA: string; // a queued run under org A
  let runB: string; // a queued run under org B

  const seedApp = async (name: string, tenantId: string, createdBy: string): Promise<string> => {
    const { data, error } = await admin
      .from('app')
      .insert({ name, tenant_id: tenantId, created_by: createdBy })
      .select('id')
      .single();
    if (error) throw new Error(`seed app ${name}: ${error.message}`);
    return data!.id as string;
  };

  const seedRun = async (tenantId: string, appId: string): Promise<string> => {
    const { data, error } = await admin
      .from('eval_run')
      .insert({
        tenant_id: tenantId,
        app_id: appId,
        repo_label: `acme/repo-${randomUUID().slice(0, 8)}`,
        request: { configs: [] },
      })
      .select('id')
      .single();
    if (error) throw new Error(`seed eval_run: ${error.message}`);
    return data!.id as string;
  };

  /** Seeds a fully-specified run (explicit `created_at`, so history ordering is
   *  deterministic instead of racing on `now()` millisecond resolution) and
   *  returns the row shaped exactly like the service's LIST_COLUMNS
   *  projection, for a positional comparison against the real read. */
  const seedHistoryRun = async (
    tenantId: string,
    appId: string,
    fields: { status: string; repoLabel: string; costUsd: number; error: string | null; createdAt: string },
  ) => {
    const request = { configs: [], seededAt: fields.createdAt };
    const { data, error } = await admin
      .from('eval_run')
      .insert({
        tenant_id: tenantId,
        app_id: appId,
        status: fields.status,
        repo_label: fields.repoLabel,
        cost_usd: fields.costUsd,
        error: fields.error,
        request,
        created_at: fields.createdAt,
      })
      .select('id')
      .single();
    if (error) throw new Error(`seed history eval_run: ${error.message}`);
    return {
      id: data!.id as string,
      status: fields.status,
      repo_label: fields.repoLabel,
      request,
      cost_usd: fields.costUsd,
      error: fields.error,
      created_at: fields.createdAt,
    };
  };

  beforeAll(async () => {
    orgA = await createTenantWithOwner();
    orgB = await createTenantWithOwner();
    readerA = await addUserToTenant(orgA.tenantId, 'read');
    writerA = await addUserToTenant(orgA.tenantId, 'write');

    const suffix = randomUUID().slice(0, 8);
    appA = await seedApp(`eval-a-${suffix}`, orgA.tenantId, orgA.id);
    appB = await seedApp(`eval-b-${suffix}`, orgB.tenantId, orgB.id);
    appHistoryA = await seedApp(`eval-a-history-${suffix}`, orgA.tenantId, orgA.id);
    runA = await seedRun(orgA.tenantId, appA);
    runB = await seedRun(orgB.tenantId, appB);
  }, 90000);

  afterAll(async () => {
    await admin.from('eval_run').delete().in('tenant_id', [orgA.tenantId, orgB.tenantId]);
    await admin.from('app').delete().in('tenant_id', [orgA.tenantId, orgB.tenantId]);
    await admin.from('membership').delete().in('user_id', [orgA.id, orgB.id, readerA.id, writerA.id]);
    for (const user of [orgA, orgB, readerA, writerA]) {
      await admin.from('profile').delete().eq('id', user.id);
      try {
        await admin.auth.admin.deleteUser(user.id);
      } catch {
        // best-effort; a leaked auth user does not affect other suites
      }
    }
    await admin.from('tenant').delete().in('tenant_id', [orgA.tenantId, orgB.tenantId]);
  });

  it("a member sees exactly their org's runs, and none of another org's", async () => {
    const asA = await createTenantScopedClient(orgA, orgA.tenantId);

    const { data, error } = await untyped(asA).from('eval_run').select('id');
    expect(error).toBeNull();
    expect((data ?? []).map((r: { id: string }) => r.id)).toEqual([runA]);

    // Org B's run is never reachable under org A, even probed by its id.
    const { data: crossProbe, error: probeError } = await untyped(asA)
      .from('eval_run')
      .select('id')
      .eq('id', runB);
    expect(probeError).toBeNull();
    expect(crossProbe).toEqual([]);
  });

  it('operating under an org the user does not belong to yields no run reads', async () => {
    // Org A's owner is not a member of org B — the fail-closed / spoof case.
    const asBSpoof = await createTenantScopedClient(orgA, orgB.tenantId);

    const { data: reads, error: readError } = await untyped(asBSpoof).from('eval_run').select('id');
    expect(readError).toBeNull();
    expect(reads).toEqual([]);

    const { data: probe, error: probeError } = await untyped(asBSpoof)
      .from('eval_run')
      .select('id')
      .eq('id', runB);
    expect(probeError).toBeNull();
    expect(probe).toEqual([]);
  });

  it("a member's own org header cannot read or launch a run against another org's app id", async () => {
    // Org A's owner, still scoped to org A's own tenant header, names org B's
    // app — the "right URL org, wrong org's appId" shape a spoofed request
    // would try against the canonical route. The tenant-match half of the
    // policy denies it regardless of the app_id lookup.
    const asA = await createTenantScopedClient(orgA, orgA.tenantId);

    const { data: reads, error: readError } = await untyped(asA)
      .from('eval_run')
      .select('id')
      .eq('app_id', appB);
    expect(readError).toBeNull();
    expect(reads).toEqual([]);

    const { data: insertData, error: insertError } = await untyped(asA)
      .from('eval_run')
      .insert({ tenant_id: orgA.tenantId, app_id: appB, repo_label: 'acme/spoof', request: {} })
      .select('id');
    expect(insertError).not.toBeNull();
    expect(insertError!.message).toContain('row-level security');
    expect(insertData).toBeNull();

    // No row was created under either org from the denied insert.
    const { data: afterA } = await admin.from('eval_run').select('id').eq('app_id', appB);
    expect((afterA ?? []).map((r: { id: string }) => r.id)).toEqual([runB]);
  });

  it('a read-only role can see runs but cannot launch one; a role with eval_run.insert can', async () => {
    // The read-only member holds eval_run.read (sees the row) but not
    // eval_run.insert, so the INSERT policy's WITH CHECK fails.
    const asReader = await createTenantScopedClient(readerA, orgA.tenantId);

    const { data: readerSees, error: readerReadError } = await untyped(asReader)
      .from('eval_run')
      .select('id')
      .eq('id', runA);
    expect(readerReadError).toBeNull();
    expect((readerSees ?? []).map((r: { id: string }) => r.id)).toEqual([runA]);

    const { data: deniedInsert, error: deniedError } = await untyped(asReader)
      .from('eval_run')
      .insert({ tenant_id: orgA.tenantId, app_id: appA, repo_label: 'acme/reader-attempt', request: {} })
      .select('id');
    expect(deniedError).not.toBeNull();
    expect(deniedError!.message).toContain('row-level security');
    expect(deniedInsert).toBeNull();

    // The owner holds eval_run.insert — the same shape of launch lands.
    const asOwner = await createTenantScopedClient(orgA, orgA.tenantId);
    const { data: okInsert, error: okError } = await untyped(asOwner)
      .from('eval_run')
      .insert({ tenant_id: orgA.tenantId, app_id: appA, repo_label: 'acme/owner-launch', request: {} })
      .select('id, status');
    expect(okError).toBeNull();
    expect(okInsert).toHaveLength(1);
    expect(typeof okInsert![0]!.id).toBe('string');
    expect(okInsert![0]!.status).toBe('queued');
  });

  it("a plain member's history read returns the seeded rows in the exact list projection the benchmarks RSC uses", async () => {
    // Newest-first, and the shape matches service.ts's LIST_COLUMNS exactly —
    // no `card` (the projection's whole point: the history list never pays
    // for the heavy Report Card blob).
    const older = await seedHistoryRun(orgA.tenantId, appHistoryA, {
      status: 'succeeded',
      repoLabel: 'acme/history-older',
      costUsd: 1.5,
      error: null,
      createdAt: new Date(Date.now() - 60_000).toISOString(),
    });
    const newer = await seedHistoryRun(orgA.tenantId, appHistoryA, {
      status: 'failed',
      repoLabel: 'acme/history-newer',
      costUsd: 0,
      error: 'executor responded 500',
      createdAt: new Date().toISOString(),
    });

    const asWriter = await createTenantScopedClient(writerA, orgA.tenantId);
    const { data, error } = await untyped(asWriter)
      .from('eval_run')
      .select('id, status, repo_label, request, cost_usd, error, created_at')
      .eq('app_id', appHistoryA)
      .order('created_at', { ascending: false });

    expect(error).toBeNull();
    // PostgREST renders `timestamptz` with a `+00:00` offset rather than the
    // seeded `Z`-suffixed ISO string, so `created_at` is compared by instant
    // (below) rather than folded into the positional `toEqual`.
    const rows = (data ?? []) as Array<Record<string, unknown>>;
    expect(rows.map(({ created_at: _created_at, ...rest }) => rest)).toEqual([
      { id: newer.id, status: 'failed', repo_label: 'acme/history-newer', request: newer.request, cost_usd: 0, error: 'executor responded 500' },
      { id: older.id, status: 'succeeded', repo_label: 'acme/history-older', request: older.request, cost_usd: 1.5, error: null },
    ]);
    expect(rows.map((r) => new Date(r.created_at as string).getTime())).toEqual([
      new Date(newer.created_at).getTime(),
      new Date(older.created_at).getTime(),
    ]);
    for (const row of rows) {
      expect('card' in row).toBe(false);
    }
  });

  it("a permitted member's launch insert lands and is re-readable through the real wire with the expected status", async () => {
    // `writerA` holds eval_run.insert via the `write` role (not the tenant
    // owner) — the same permission-holder shape `launchEvalRun` checks before
    // its Vault read and Fly dispatch. This proves the insert half of that
    // path lands on the real PostgREST wire and the row is re-readable
    // exactly as inserted; it does not dispatch a Fly machine or drive the
    // action body itself.
    const asWriter = await createTenantScopedClient(writerA, orgA.tenantId);

    const { data: inserted, error: insertError } = await untyped(asWriter)
      .from('eval_run')
      .insert({ tenant_id: orgA.tenantId, app_id: appA, repo_label: 'acme/writer-launch', request: { configs: [] } })
      .select('id, status')
      .single();
    expect(insertError).toBeNull();
    expect(typeof inserted!.id).toBe('string');
    expect(inserted!.status).toBe('queued');

    const { data: reread, error: rereadError } = await untyped(asWriter)
      .from('eval_run')
      .select('id, status, repo_label')
      .eq('id', inserted!.id)
      .single();
    expect(rereadError).toBeNull();
    expect(reread).toEqual({ id: inserted!.id, status: 'queued', repo_label: 'acme/writer-launch' });
  });
});
