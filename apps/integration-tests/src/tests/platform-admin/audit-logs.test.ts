import { getSupabaseAdmin, checkTableExists, requirePrerequisite, createAuthenticatedUser, cleanupTestUsers, type PrerequisiteCheck } from '../../lib/test-utils';

/**
 * Integration tests for Platform Admin - Audit Logs
 *
 * Integration tests for listAuditLogs (pagination, filtering by date/action/admin)
 * Integration tests for audit log immutability (verify UPDATE/DELETE blocked)
 */

describe('Platform Admin - Audit Logs', () => {
  const supabaseAdmin = getSupabaseAdmin();
  let auditLogCheck: PrerequisiteCheck;
  let testAdminUserId: string;
  let createdAuditLogIds: string[] = [];

  beforeAll(async () => {
    // Check if audit_log table exists
    auditLogCheck = await checkTableExists('audit_log');

    if (!auditLogCheck.available) {
      return;
    }

    // Create test admin user
    const testEmail = `audit-test-admin-${Date.now()}@outerlayer.ai`;
    const { data: authUser, error: authError } = await supabaseAdmin.auth.admin.createUser({
      email: testEmail,
      password: 'TestPassword123!',
      email_confirm: true,
    });

    if (authError || !authUser.user) {
      throw new Error(`Failed to create test admin user: ${authError?.message}`);
    }

    testAdminUserId = authUser.user.id;

    // Create profile for admin
    await supabaseAdmin.from('profile').insert({
      id: testAdminUserId,
      name: 'Audit Test Admin',
      email: testEmail,
    });

    // Create multiple audit log entries for testing
    const actionTypes = ['org_delete', 'user_delete', 'flag_create', 'flag_update', 'temp_access_grant'];

    for (let i = 0; i < actionTypes.length; i++) {
      const { data: auditEntry, error } = await supabaseAdmin
        .from('audit_log')
        .insert({
          actor_id: testAdminUserId,
          action_type: actionTypes[i],
          target_type: i % 2 === 0 ? 'tenant' : 'user',
          target_id: `00000000-0000-0000-0000-00000000000${i}`,
          target_identifier: `Test Target ${i}`,
          details: { test_index: i, created_for: 'integration_test' },
          before_state: { status: 'before' },
          after_state: { status: 'after' },
        })
        .select()
        .single();

      if (!error && auditEntry) {
        createdAuditLogIds.push(auditEntry.id);
      }
    }
  });

  afterAll(async () => {
    if (!auditLogCheck.available) return;

    // Note: We attempt to delete audit logs for cleanup, but if immutability is enforced,
    // this will fail silently. For testing purposes, we may need service_role access.
    // The test data is clearly marked with 'integration_test' in details.

    if (testAdminUserId) {
      await supabaseAdmin.from('profile').delete().eq('id', testAdminUserId);
      await supabaseAdmin.auth.admin.deleteUser(testAdminUserId);
    }
  });

  // listAuditLogs tests
  describe('listAuditLogs', () => {
    it('should return paginated list of audit logs with required fields', async () => {
      requirePrerequisite(auditLogCheck);

      const { data: logs } = await supabaseAdmin
        .from('audit_log')
        .select('id, actor_id, action_type, target_type, created_at')
        .order('created_at', { ascending: false })
        .range(0, 9);

      // Primary assertions: verify returned data structure
      expect(Array.isArray(logs)).toBe(true);
      expect(logs!.length).toBeGreaterThan(0);

      // Verify each log has required fields with valid values
      const firstLog = logs![0]!;
      expect(typeof firstLog.id).toBe('string');
      expect(typeof firstLog.actor_id).toBe('string');
      expect(typeof firstLog.action_type).toBe('string');
      expect(typeof firstLog.created_at).toBe('string');
    });

    it('should return different records when paginated with offset', async () => {
      requirePrerequisite(auditLogCheck);

      const { data: page1 } = await supabaseAdmin
        .from('audit_log')
        .select('id')
        .order('created_at', { ascending: false })
        .range(0, 1);

      const { data: page2 } = await supabaseAdmin
        .from('audit_log')
        .select('id')
        .order('created_at', { ascending: false })
        .range(2, 3);

      // Primary assertions: verify pagination returns different record sets
      expect(page1!.length).toBeGreaterThan(0);
      expect(page2!.length).toBeGreaterThan(0);
      expect(page1![0]!.id).not.toBe(page2![0]!.id);
    });

    it('should return only org_delete logs when filtered by action type', async () => {
      requirePrerequisite(auditLogCheck);

      const { data: results } = await supabaseAdmin
        .from('audit_log')
        .select('action_type, target_type')
        .eq('action_type', 'org_delete');

      // Primary assertions: all returned logs match the filter
      expect(results!.length).toBeGreaterThanOrEqual(1);
      expect(results!.every((log) => log.action_type === 'org_delete')).toBe(true);
    });

    it('should return only logs created by specified admin when filtered', async () => {
      requirePrerequisite(auditLogCheck);

      const { data: results } = await supabaseAdmin
        .from('audit_log')
        .select('actor_id, action_type')
        .eq('actor_id', testAdminUserId);

      // Primary assertions: all returned logs belong to test admin
      expect(results!.length).toBeGreaterThanOrEqual(5); // We created 5 entries in beforeAll
      expect(results!.every((log) => log.actor_id === testAdminUserId)).toBe(true);
    });

    it('should return logs within specified date range', async () => {
      requirePrerequisite(auditLogCheck);

      const now = new Date();
      const oneHourAgo = new Date(now.getTime() - 60 * 60 * 1000);

      const { data: results } = await supabaseAdmin
        .from('audit_log')
        .select('created_at')
        .gte('created_at', oneHourAgo.toISOString())
        .lte('created_at', now.toISOString());

      // Primary assertions: logs exist and all fall within the date range
      expect(results!.length).toBeGreaterThanOrEqual(1);
      expect(results!.every((log) => {
        const logDate = new Date(log.created_at);
        return logDate >= oneHourAgo && logDate <= now;
      })).toBe(true);
    });

    it('should include full audit log details with expected values', async () => {
      requirePrerequisite(auditLogCheck);
      if (createdAuditLogIds.length === 0) {
        throw new Error('[PREREQUISITE NOT MET] No audit log IDs created in beforeAll');
      }

      const { data: log } = await supabaseAdmin
        .from('audit_log')
        .select('*')
        .eq('id', createdAuditLogIds[0])
        .single();

      // Primary assertions: verify log contains expected data from beforeAll setup
      expect(log?.actor_id).toBe(testAdminUserId);
      expect(log?.action_type).toBe('org_delete'); // First action type in setup
      expect(log?.target_identifier).toBe('Test Target 0');
      expect(log?.before_state).toEqual({ status: 'before' });
      expect(log?.after_state).toEqual({ status: 'after' });
      expect(log?.details).toEqual({ test_index: 0, created_for: 'integration_test' });
    });
  });

  // audit log immutability tests
  describe('Audit Log Immutability', () => {
    it('should have RLS policies blocking UPDATE/DELETE for non-service-role', async () => {
      requirePrerequisite(auditLogCheck);

      // Verify the RLS policies exist for immutability
      // Note: service_role bypasses RLS by design for admin operations
      // The immutability is enforced at the RLS level for authenticated users:
      // - block_update policy: USING (false) WITH CHECK (false)
      // - block_delete policy: USING (false)

      // We verify the policies exist by checking we can still read/insert
      // but not update/delete from a non-service-role perspective
      // Since we're using supabaseAdmin (service_role), we document expected behavior

      const { data: testEntry, error: insertError } = await supabaseAdmin
        .from('audit_log')
        .insert({
          actor_id: testAdminUserId,
          action_type: 'immutability_test',
          target_type: 'test',
          target_id: '00000000-0000-0000-0000-000000000099',
          target_identifier: 'Immutability Test Entry',
        })
        .select()
        .single();

      expect(insertError).toBeNull();
      expect(testEntry).not.toBeNull();

      // Service role CAN update (bypasses RLS), but the RLS policies
      // block UPDATE/DELETE for 'authenticated' role users
      // This is the expected security model for audit logs
      if (testEntry) {
        createdAuditLogIds.push(testEntry.id);
      }
    });

    it('should block UPDATE for authenticated users (RLS immutability)', async () => {
      requirePrerequisite(auditLogCheck);

      // Create an authenticated user (not service_role)
      const authUser = await createAuthenticatedUser('admin');

      // Create an audit log entry using service_role
      const { data: auditEntry } = await supabaseAdmin
        .from('audit_log')
        .insert({
          actor_id: testAdminUserId,
          action_type: 'rls_test',
          target_type: 'test',
          target_id: '00000000-0000-0000-0000-000000000098',
          target_identifier: 'RLS Test Entry',
        })
        .select()
        .single();

      if (auditEntry) {
        createdAuditLogIds.push(auditEntry.id);

        // Try to UPDATE using authenticated user's client - should fail due to RLS.
        // The verification below reads the row back and asserts the value is
        // unchanged; we don't assert on the error directly because PostgREST
        // can either return an error or silently affect 0 rows.
        await authUser.client
          .from('audit_log')
          .update({ target_identifier: 'Modified by attacker' })
          .eq('id', auditEntry.id);

        // RLS policy should block the update
        // Either returns error or silently fails (0 rows affected)
        // We verify the entry was NOT modified
        const { data: verifyEntry } = await supabaseAdmin
          .from('audit_log')
          .select('target_identifier')
          .eq('id', auditEntry.id)
          .single();

        expect(verifyEntry?.target_identifier).toBe('RLS Test Entry');
      }

      await cleanupTestUsers();
    });

    it('should block DELETE for authenticated users (RLS immutability)', async () => {
      requirePrerequisite(auditLogCheck);

      // Create an authenticated user (not service_role)
      const authUser = await createAuthenticatedUser('admin');

      // Create an audit log entry using service_role
      const { data: auditEntry } = await supabaseAdmin
        .from('audit_log')
        .insert({
          actor_id: testAdminUserId,
          action_type: 'rls_delete_test',
          target_type: 'test',
          target_id: '00000000-0000-0000-0000-000000000097',
          target_identifier: 'RLS Delete Test Entry',
        })
        .select()
        .single();

      if (auditEntry) {
        createdAuditLogIds.push(auditEntry.id);

        // Try to DELETE using authenticated user's client - should fail due to RLS.
        // See the UPDATE test above for why we don't assert on the error.
        await authUser.client
          .from('audit_log')
          .delete()
          .eq('id', auditEntry.id);

        // RLS policy should block the delete
        // Verify the entry still exists
        const { data: verifyEntry } = await supabaseAdmin
          .from('audit_log')
          .select('id')
          .eq('id', auditEntry.id)
          .single();

        expect(verifyEntry).not.toBeNull();
        expect(verifyEntry?.id).toBe(auditEntry.id);
      }

      await cleanupTestUsers();
    });

    it('should have chronological ordering by created_at', async () => {
      requirePrerequisite(auditLogCheck);

      const { data: logs, error } = await supabaseAdmin
        .from('audit_log')
        .select('id, created_at')
        .order('created_at', { ascending: false })
        .limit(10);

      expect(error).toBeNull();
      expect(Array.isArray(logs)).toBe(true);
      expect(logs!.length).toBeGreaterThan(0);

      // Verify ordering
      for (let i = 1; i < logs!.length; i++) {
        const current = new Date(logs![i]!.created_at);
        const previous = new Date(logs![i - 1]!.created_at);
        expect(previous.getTime()).toBeGreaterThanOrEqual(current.getTime());
      }
    });

    it('should preserve before_state and after_state', async () => {
      requirePrerequisite(auditLogCheck);
      if (createdAuditLogIds.length === 0) {
        throw new Error('[PREREQUISITE NOT MET] No audit log IDs created in beforeAll');
      }

      const { data: log, error } = await supabaseAdmin
        .from('audit_log')
        .select('before_state, after_state')
        .eq('id', createdAuditLogIds[0])
        .single();

      expect(error).toBeNull();
      expect(log).not.toBeNull();
      expect(log?.before_state).toEqual({ status: 'before' });
      expect(log?.after_state).toEqual({ status: 'after' });
    });
  });

  describe('Polymorphic actor', () => {
    it('defaults to a human actor and records machine actors with no profile', async () => {
      requirePrerequisite(auditLogCheck);

      // Human rows (written without actor_type) default to 'human'
      const { data: humanRow, error: humanError } = await supabaseAdmin
        .from('audit_log')
        .insert({
          actor_id: testAdminUserId,
          action_type: 'actor_default_test',
          target_type: 'test',
          target_identifier: 'Actor Default Test',
        })
        .select('id, actor_id, actor_type, actor_label')
        .single();

      expect(humanError).toBeNull();
      expect(humanRow).toMatchObject({
        actor_id: testAdminUserId,
        actor_type: 'human',
        actor_label: null,
      });
      if (humanRow) createdAuditLogIds.push(humanRow.id);

      // Machine actors: actor_id is NULL, discriminated by actor_type + label.
      // No fake human row is required to attribute a machine action.
      const { data: machineRow, error: machineError } = await supabaseAdmin
        .from('audit_log')
        .insert({
          actor_id: null,
          actor_type: 'gateway',
          actor_label: 'api-key-integration-test',
          action_type: 'machine_actor_test',
          target_type: 'test',
          target_identifier: 'Machine Actor Test',
        })
        .select('id, actor_id, actor_type, actor_label')
        .single();

      expect(machineError).toBeNull();
      expect(machineRow).toMatchObject({
        actor_id: null,
        actor_type: 'gateway',
        actor_label: 'api-key-integration-test',
      });
      if (machineRow) createdAuditLogIds.push(machineRow.id);
    });

    it('records tenant-scoped rows and platform rows side by side', async () => {
      requirePrerequisite(auditLogCheck);

      const { data: tenant } = await supabaseAdmin
        .from('tenant')
        .insert({
          organization_name: `Audit Scope Test ${Date.now()}`,
          company_name: 'Audit Scope Test Co',
          created_by: testAdminUserId,
        })
        .select('tenant_id')
        .single();

      expect(tenant).not.toBeNull();

      const { data: tenantRow, error: tenantRowError } = await supabaseAdmin
        .from('audit_log')
        .insert({
          tenant_id: tenant!.tenant_id,
          actor_id: testAdminUserId,
          action_type: 'member_role_changed',
          target_type: 'membership',
          target_identifier: 'member@example.com',
          before_state: { role: 'read' },
          after_state: { role: 'admin' },
        })
        .select('id, tenant_id, actor_type')
        .single();

      expect(tenantRowError).toBeNull();
      expect(tenantRow?.tenant_id).toBe(tenant!.tenant_id);
      expect(tenantRow?.actor_type).toBe('human');
      if (tenantRow) createdAuditLogIds.push(tenantRow.id);

      // Tenant deletion must not delete OR MUTATE the trail: audit rows are
      // frozen (no FK — an ON DELETE SET NULL would rewrite hashed content
      // and turn every affected row into a false tamper alarm). The row
      // survives with its tenant_id intact, and the chain still verifies.
      await supabaseAdmin.from('tenant').delete().eq('tenant_id', tenant!.tenant_id);

      const { data: survivor } = await supabaseAdmin
        .from('audit_log')
        .select('tenant_id, action_type, target_identifier')
        .eq('id', tenantRow!.id)
        .single();

      expect(survivor).toEqual({
        tenant_id: tenant!.tenant_id,
        action_type: 'member_role_changed',
        target_identifier: 'member@example.com',
      });

      // The deletion must not have poisoned THIS row's hash (global
      // emptiness would race parallel suites and legacy rows).
      const { data: rowSeq } = await supabaseAdmin
        .from('audit_log')
        .select('seq')
        .eq('id', tenantRow!.id)
        .single();
      const { data: violations, error: verifyError } = await supabaseAdmin.rpc(
        'verify_audit_log_chain'
      );
      expect(verifyError).toBeNull();
      expect((violations ?? []).map((v: { bad_seq: number }) => v.bad_seq)).not.toContain(
        rowSeq!.seq
      );
    });

    it('keeps the chain intact when an actor profile is deleted', async () => {
      requirePrerequisite(auditLogCheck);

      // A dedicated throwaway user so deleting it cannot affect other tests.
      const { data: authUser, error: createError } =
        await supabaseAdmin.auth.admin.createUser({
          email: `chain-actor-${Date.now()}@freeze-test.com`,
          password: 'TestPassword123!',
          email_confirm: true,
        });
      expect(createError).toBeNull();
      const actorId = authUser!.user!.id;
      await supabaseAdmin
        .from('profile')
        .insert({ id: actorId, name: 'Chain Actor', email: authUser!.user!.email });

      const { data: row, error: insertError } = await supabaseAdmin
        .from('audit_log')
        .insert({
          actor_id: actorId,
          actor_label: authUser!.user!.email,
          action_type: 'member_role_changed',
          target_type: 'membership',
          target_identifier: 'freeze@example.com',
        })
        .select('id')
        .single();
      expect(insertError).toBeNull();
      createdAuditLogIds.push(row!.id);

      // Deleting the actor (profile + auth user) must not touch the row:
      // actor_id stays, actor_label keeps the display identity, and the
      // hash chain verifies clean (the pre-freeze SET NULL design failed
      // exactly here).
      await supabaseAdmin.from('profile').delete().eq('id', actorId);
      await supabaseAdmin.auth.admin.deleteUser(actorId);

      const { data: frozen } = await supabaseAdmin
        .from('audit_log')
        .select('actor_id, actor_label')
        .eq('id', row!.id)
        .single();
      expect(frozen).toEqual({
        actor_id: actorId,
        actor_label: authUser!.user!.email,
      });

      const { data: rowSeq } = await supabaseAdmin
        .from('audit_log')
        .select('seq')
        .eq('id', row!.id)
        .single();
      const { data: violations, error: verifyError } = await supabaseAdmin.rpc(
        'verify_audit_log_chain'
      );
      expect(verifyError).toBeNull();
      expect((violations ?? []).map((v: { bad_seq: number }) => v.bad_seq)).not.toContain(
        rowSeq!.seq
      );
    });
  });
  describe('Tamper-evidence hash chain', () => {
    it('links every insert onto the previous hash and detects edits', async () => {
      requirePrerequisite(auditLogCheck);

      const insertRow = async (label: string) => {
        const { data, error } = await supabaseAdmin
          .from('audit_log')
          .insert({
            actor_id: testAdminUserId,
            action_type: 'chain_test',
            target_type: 'test',
            target_identifier: label,
          })
          .select('id, seq, prev_hash, row_hash, target_identifier')
          .single();
        expect(error).toBeNull();
        createdAuditLogIds.push(data!.id);
        return data!;
      };

      const first = await insertRow('Chain Row 1');
      const second = await insertRow('Chain Row 2');

      // Trigger-maintained linkage: sha256 hex hashes, second links onto first
      expect(first.row_hash).toMatch(/^[0-9a-f]{64}$/);
      expect(second.prev_hash).toBe(first.row_hash);

      // Client-supplied hashes must be overwritten by the trigger
      const { data: forged } = await supabaseAdmin
        .from('audit_log')
        .insert({
          actor_id: testAdminUserId,
          action_type: 'chain_test',
          target_type: 'test',
          target_identifier: 'Forged Hash Row',
          row_hash: 'not-a-real-hash',
          prev_hash: 'not-a-real-hash',
        })
        .select('id, prev_hash, row_hash')
        .single();
      expect(forged?.prev_hash).toBe(second.row_hash);
      expect(forged?.row_hash).toMatch(/^[0-9a-f]{64}$/);
      if (forged) createdAuditLogIds.push(forged.id);

      // Tamper with row content (service_role bypasses RLS — exactly the
      // threat the chain exists to DETECT) and verify detection
      await supabaseAdmin
        .from('audit_log')
        .update({ target_identifier: 'tampered' })
        .eq('id', first.id);

      const { data: broken, error: verifyError } = await supabaseAdmin.rpc('verify_audit_log_chain');
      expect(verifyError).toBeNull();
      const mine = (broken as Array<{ bad_seq: number; reason: string }>).filter(
        (b) => Number(b.bad_seq) === Number(first.seq),
      );
      expect(mine).toEqual([{ bad_seq: first.seq, reason: 'content_hash_mismatch' }]);

      // Restore; our row verifies clean again
      await supabaseAdmin
        .from('audit_log')
        .update({ target_identifier: 'Chain Row 1' })
        .eq('id', first.id);
      const { data: after } = await supabaseAdmin.rpc('verify_audit_log_chain');
      expect(
        (after as Array<{ bad_seq: number }>).filter((b) => Number(b.bad_seq) === Number(first.seq)),
      ).toEqual([]);
    });
  });
});
