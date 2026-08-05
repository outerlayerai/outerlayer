import {
  getSupabaseAdmin,
  checkTableExists,
  requirePrerequisite,
  createAuthenticatedUser,
  cleanupTestUsers,
  type PrerequisiteCheck,
} from '../../lib/test-utils';

/**
 * Tenant-facing audit trail reads.
 *
 * Exercises the "Members can read own tenant audit trail" RLS policy on
 * public.audit_log against a REAL local Supabase through REAL signed-in user
 * clients — the only way to prove the policy scopes correctly (a mocked
 * client passes regardless).
 *
 * RLS semantics relied on (documented pattern from the environments suite):
 *   - SELECT under a denying policy returns 0 rows + null error.
 *   - INSERT under a denying policy returns a row-level security error.
 *   - UPDATE/DELETE under a denying policy return 0 affected rows + null
 *     error (USING acts as a filter) — verify the row is UNCHANGED.
 */

describe('audit_log tenant read RLS', () => {
  const supabaseAdmin = getSupabaseAdmin();
  let tableCheck: PrerequisiteCheck;

  beforeAll(async () => {
    tableCheck = await checkTableExists('audit_log');
  });

  afterAll(async () => {
    await cleanupTestUsers();
  });

  /** Seeds one audit row via service_role and returns its id. */
  async function seedAuditRow(
    tenantId: string | null,
    targetIdentifier: string
  ): Promise<string> {
    const { data, error } = await supabaseAdmin
      .from('audit_log')
      .insert({
        tenant_id: tenantId,
        actor_type: 'human',
        action_type: 'member_role_changed',
        target_type: 'membership',
        target_identifier: targetIdentifier,
        before_state: { role: 'read' },
        after_state: { role: 'write' },
      })
      .select('id')
      .single();
    expect(error).toBeNull();
    return data!.id;
  }

  it('grants audit_log.read to owner and admin, denies it to read-role members', async () => {
    requirePrerequisite(tableCheck);
    const [owner, admin, reader] = await Promise.all([
      createAuthenticatedUser('owner'),
      createAuthenticatedUser('admin'),
      createAuthenticatedUser('read'),
    ]);

    const [ownerAuthz, adminAuthz, readerAuthz] = await Promise.all([
      owner.client.rpc('authorize', { requested_permission: 'audit_log.read' }),
      admin.client.rpc('authorize', { requested_permission: 'audit_log.read' }),
      reader.client.rpc('authorize', { requested_permission: 'audit_log.read' }),
    ]);

    expect(ownerAuthz).toMatchObject({ data: true, error: null });
    expect(adminAuthz).toMatchObject({ data: true, error: null });
    expect(readerAuthz).toMatchObject({ data: false, error: null });
  });

  it('owner reads ONLY their own tenant rows — other tenants and platform rows are invisible', async () => {
    requirePrerequisite(tableCheck);
    const ownerA = await createAuthenticatedUser('owner');
    const ownerB = await createAuthenticatedUser('owner');

    const mineId = await seedAuditRow(ownerA.tenantId, 'mine@rls-test.com');
    const theirsId = await seedAuditRow(ownerB.tenantId, 'theirs@rls-test.com');
    const platformId = await seedAuditRow(null, 'platform@rls-test.com');

    const { data: visible, error } = await ownerA.client
      .from('audit_log')
      .select('id, tenant_id, target_identifier');

    expect(error).toBeNull();
    // Everything visible belongs to tenant A — nothing cross-tenant, nothing
    // platform-scoped, regardless of what other suites have written.
    expect(visible!.every((row) => row.tenant_id === ownerA.tenantId)).toBe(true);
    const visibleIds = visible!.map((row) => row.id);
    expect(visibleIds).toContain(mineId);
    expect(visibleIds).not.toContain(theirsId);
    expect(visibleIds).not.toContain(platformId);

    // Fetching a foreign entry by id returns nothing (silent filter).
    const { data: byId, error: byIdError } = await ownerA.client
      .from('audit_log')
      .select('id')
      .eq('id', theirsId);
    expect(byIdError).toBeNull();
    expect(byId).toEqual([]);
  });

  it('read-role members see zero rows even when their tenant has entries', async () => {
    requirePrerequisite(tableCheck);
    const reader = await createAuthenticatedUser('read');
    await seedAuditRow(reader.tenantId, 'reader-tenant@rls-test.com');

    const { data, error } = await reader.client
      .from('audit_log')
      .select('id')
      .eq('tenant_id', reader.tenantId);

    expect(error).toBeNull();
    expect(data).toEqual([]);
  });

  it('authenticated users cannot insert audit rows (write stays service_role-only)', async () => {
    requirePrerequisite(tableCheck);
    const owner = await createAuthenticatedUser('owner');

    const { error } = await owner.client.from('audit_log').insert({
      tenant_id: owner.tenantId,
      actor_type: 'human',
      action_type: 'member_role_changed',
      target_type: 'membership',
      target_identifier: 'forged@rls-test.com',
    });

    expect(error).not.toBeNull();
    // Denied at the first security layer it hits: the hash-chain trigger's
    // function has no EXECUTE grant for authenticated (so the error is
    // "permission denied for function audit_log_compute_hash"); with EXECUTE
    // it would still die on the service_role-only INSERT policy.
    expect(error!.message).toMatch(/permission denied|row-level security/);

    const { data: forged } = await supabaseAdmin
      .from('audit_log')
      .select('id')
      .eq('target_identifier', 'forged@rls-test.com');
    expect(forged).toEqual([]);
  });

  it('owners cannot update or delete their own trail (write-once posture)', async () => {
    requirePrerequisite(tableCheck);
    const owner = await createAuthenticatedUser('owner');
    const rowId = await seedAuditRow(owner.tenantId, 'immutable@rls-test.com');

    // The owner CAN read it…
    const { data: readable } = await owner.client
      .from('audit_log')
      .select('id')
      .eq('id', rowId);
    expect(readable!.map((r) => r.id)).toEqual([rowId]);

    // …but UPDATE and DELETE match nothing (USING false acts as a filter).
    const { data: updated, error: updateError } = await owner.client
      .from('audit_log')
      .update({ target_identifier: 'tampered@rls-test.com' })
      .eq('id', rowId)
      .select('id');
    expect(updateError).toBeNull();
    expect(updated).toEqual([]);

    const { data: deleted, error: deleteError } = await owner.client
      .from('audit_log')
      .delete()
      .eq('id', rowId)
      .select('id');
    expect(deleteError).toBeNull();
    expect(deleted).toEqual([]);

    const { data: intact } = await supabaseAdmin
      .from('audit_log')
      .select('target_identifier')
      .eq('id', rowId)
      .single();
    expect(intact).toEqual({ target_identifier: 'immutable@rls-test.com' });
  });
});
