/**
 * Env-escalation acceptance — the queue's reads and ack/resolve updates are
 * tenant- and permission-scoped, asserted as business behavior through the
 * real PostgREST → RLS wire path.
 *
 * A dashboard request derives its tenant from the URL org and sends it as an
 * `X-Tenant-Id` header; the `env_escalation` policies gate SELECT on
 * `env_escalation.read` + tenant match and UPDATE on `env_escalation.update` +
 * tenant match. Rows are born from the eval worker's service-role client (no
 * INSERT policy), so the fixtures seed with the admin client and then read /
 * update through a header-scoped, authenticated client — exactly what the
 * dashboard's RSC read and the `env_escalation.update` server action do.
 *
 * `env_escalation` is not in the generated Database type (it is a
 * service-role-written table), so it is addressed through an untyped client.
 */

import { describe, it, beforeAll, afterAll, expect } from 'vitest';
import { randomUUID } from 'crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import { createSupabaseAdminClientUntyped } from '../../lib/supabase-admin';
import { createTenantScopedClient } from '../../lib/tenant-scoped-client';
import { createTenantWithOwner, addUserToTenant, SameTenantUser } from '../app-level-roles/helpers';

/** Address env_escalation (absent from the generated Database type) untyped. */
const untyped = (client: unknown) => client as SupabaseClient;

describe('env-escalation reads and updates are tenant- and permission-scoped', () => {
  const admin = createSupabaseAdminClientUntyped();

  let orgA: SameTenantUser; // owner of A → holds env_escalation.update
  let orgB: SameTenantUser; // owner of B, member of B only
  let readerA: SameTenantUser; // read role in A → holds .read, NOT .update

  let appA: string;
  let appB: string;
  let escA: string; // an open escalation under org A
  let escB: string; // an open escalation under org B

  const seedApp = async (name: string, tenantId: string, createdBy: string): Promise<string> => {
    const { data, error } = await admin
      .from('app')
      .insert({ name, tenant_id: tenantId, created_by: createdBy })
      .select('id')
      .single();
    if (error) throw new Error(`seed app ${name}: ${error.message}`);
    return data!.id as string;
  };

  const seedEscalation = async (tenantId: string, appId: string): Promise<string> => {
    const { data, error } = await admin
      .from('env_escalation')
      .insert({
        tenant_id: tenantId,
        app_id: appId,
        repo: `acme/repo-${randomUUID().slice(0, 8)}`,
        base_commit: 'c0ffee',
        status: 'open',
      })
      .select('id')
      .single();
    if (error) throw new Error(`seed escalation: ${error.message}`);
    return data!.id as string;
  };

  beforeAll(async () => {
    orgA = await createTenantWithOwner();
    orgB = await createTenantWithOwner();
    readerA = await addUserToTenant(orgA.tenantId, 'read');

    const suffix = randomUUID().slice(0, 8);
    appA = await seedApp(`esc-a-${suffix}`, orgA.tenantId, orgA.id);
    appB = await seedApp(`esc-b-${suffix}`, orgB.tenantId, orgB.id);
    escA = await seedEscalation(orgA.tenantId, appA);
    escB = await seedEscalation(orgB.tenantId, appB);
  }, 90000);

  afterAll(async () => {
    await admin.from('env_escalation').delete().in('tenant_id', [orgA.tenantId, orgB.tenantId]);
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

  it("a member sees exactly their org's escalations, and none of another org's", async () => {
    const asA = await createTenantScopedClient(orgA, orgA.tenantId);

    const { data, error } = await untyped(asA).from('env_escalation').select('id');
    expect(error).toBeNull();
    expect((data ?? []).map((r: { id: string }) => r.id)).toEqual([escA]);

    // Org B's escalation is never reachable under org A, even probed by its id.
    const { data: crossProbe, error: probeError } = await untyped(asA)
      .from('env_escalation')
      .select('id')
      .eq('id', escB);
    expect(probeError).toBeNull();
    expect(crossProbe).toEqual([]);
  });

  it('operating under an org the user does not belong to yields no escalation reads', async () => {
    // Org A's owner is not a member of org B — the fail-closed / spoof case.
    const asBSpoof = await createTenantScopedClient(orgA, orgB.tenantId);

    const { data: reads, error: readError } = await untyped(asBSpoof).from('env_escalation').select('id');
    expect(readError).toBeNull();
    expect(reads).toEqual([]);

    const { data: probe, error: probeError } = await untyped(asBSpoof)
      .from('env_escalation')
      .select('id')
      .eq('id', escB);
    expect(probeError).toBeNull();
    expect(probe).toEqual([]);
  });

  it('a read-only role can see an escalation but cannot ack it; a role with update can', async () => {
    // The read-only member holds env_escalation.read (sees the row) but not
    // env_escalation.update, so the UPDATE policy matches zero rows.
    const asReader = await createTenantScopedClient(readerA, orgA.tenantId);

    const { data: readerSees, error: readerReadError } = await untyped(asReader)
      .from('env_escalation')
      .select('id')
      .eq('id', escA);
    expect(readerReadError).toBeNull();
    expect((readerSees ?? []).map((r: { id: string }) => r.id)).toEqual([escA]);

    const { data: deniedUpdate, error: deniedError } = await untyped(asReader)
      .from('env_escalation')
      .update({ status: 'acked' })
      .eq('id', escA)
      .select('id');
    expect(deniedError).toBeNull();
    expect(deniedUpdate).toEqual([]);

    // The row is untouched by the denied update.
    const { data: afterReader } = await admin
      .from('env_escalation')
      .select('status')
      .eq('id', escA)
      .single();
    expect(afterReader!.status).toBe('open');

    // The owner holds env_escalation.update — the same ack lands.
    const asOwner = await createTenantScopedClient(orgA, orgA.tenantId);
    const { data: okUpdate, error: okError } = await untyped(asOwner)
      .from('env_escalation')
      .update({ status: 'acked' })
      .eq('id', escA)
      .select('id, status');
    expect(okError).toBeNull();
    expect(okUpdate).toEqual([{ id: escA, status: 'acked' }]);
  });

  it('a member cannot ack an escalation in an org they do not belong to', async () => {
    // Org A's owner, operating under org B's tenant, cannot see or move B's row.
    const asAToB = await createTenantScopedClient(orgA, orgB.tenantId);

    const { data: crossUpdate, error } = await untyped(asAToB)
      .from('env_escalation')
      .update({ status: 'acked' })
      .eq('id', escB)
      .select('id');
    expect(error).toBeNull();
    expect(crossUpdate).toEqual([]);

    // Org B's escalation still sits at open — nothing crossed the tenant line.
    const { data: bAfter } = await admin
      .from('env_escalation')
      .select('status')
      .eq('id', escB)
      .single();
    expect(bAfter!.status).toBe('open');
  });
});
