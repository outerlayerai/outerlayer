import {
  getSupabaseAdmin,
  checkTableExists,
  requirePrerequisite,
  createAuthenticatedUser,
  cleanupTestUsers,
  type PrerequisiteCheck,
} from '../../lib/test-utils';
import {
  createCustomRole,
  assignCustomRole,
  cleanupCustomRoles,
} from '../custom-roles/helpers';

/**
 * Integration tests for the atomic membership-lifecycle audit transactions.
 *
 * change_member_role_transaction / remove_member_transaction /
 * invite_existing_user_transaction write the mutation AND its audit row in
 * one database transaction: they commit together or not at all.
 */

describe('Membership audit transactions (atomicity)', () => {
  const supabaseAdmin = getSupabaseAdmin();
  let tableCheck: PrerequisiteCheck;

  beforeAll(async () => {
    tableCheck = await checkTableExists('audit_log');
  });

  afterAll(async () => {
    await cleanupTestUsers();
  });

  /** Creates a second, plain member inside the owner's tenant. */
  async function seedMember(tenantId: string, role = 'read') {
    const { randomUUID } = require('crypto');
    const userId = randomUUID();
    const email = `member-${userId.slice(0, 8)}@transaction-test.com`;

    const { error: authError } = await supabaseAdmin.auth.admin.createUser({
      email,
      password: 'TestPassword123!',
      email_confirm: true,
    });
    // createUser assigns its own id; look it up by email instead of assuming
    expect(authError).toBeNull();
    const { data: users } = await supabaseAdmin.auth.admin.listUsers();
    const authUser = users.users.find((u) => u.email === email)!;

    await supabaseAdmin.from('profile').insert({ id: authUser.id, name: 'Txn Member', email });
    const { data: membership } = await supabaseAdmin
      .from('membership')
      .insert({ user_id: authUser.id, tenant_id: tenantId, role, status: 'active', accepted_at: new Date().toISOString() })
      .select('id')
      .single();

    return { userId: authUser.id, email, membershipId: membership!.id };
  }

  it('change_member_role_transaction mutates and audits atomically, with request context', async () => {
    requirePrerequisite(tableCheck);
    const owner = await createAuthenticatedUser('owner');
    const member = await seedMember(owner.tenantId);

    const { data: result, error } = await supabaseAdmin.rpc('change_member_role_transaction', {
      p_tenant_id: owner.tenantId,
      p_target_user_id: member.userId,
      p_actor_id: owner.id,
      p_new_role: 'write',
      p_custom_role_id: null,
      p_ip_address: '198.51.100.7',
      p_user_agent: 'integration-test',
      p_request_id: 'req-atomic-1',
    });

    expect(error).toBeNull();
    expect(result).toEqual({
      membership_id: member.membershipId,
      before_role: 'read',
      after_role: 'write',
    });

    const { data: membership } = await supabaseAdmin
      .from('membership')
      .select('role')
      .eq('id', member.membershipId)
      .single();
    expect(membership?.role).toBe('write');

    const { data: auditRows } = await supabaseAdmin
      .from('audit_log')
      .select('actor_id, actor_label, action_type, target_identifier, before_state, after_state, ip_address, user_agent, request_id, tenant_id')
      .eq('target_id', member.membershipId)
      .eq('action_type', 'member_role_changed');

    expect(auditRows).toEqual([
      {
        actor_id: owner.id,
        // Denormalized in the transaction function: display identity
        // survives actor profile deletion (actor_id is frozen, no FK).
        actor_label: owner.email,
        action_type: 'member_role_changed',
        target_identifier: member.email,
        before_state: { role: 'read', custom_role_id: null },
        after_state: { role: 'write', custom_role_id: null },
        ip_address: '198.51.100.7',
        user_agent: 'integration-test',
        request_id: 'req-atomic-1',
        tenant_id: owner.tenantId,
      },
    ]);
  });

  it('rolls back BOTH the mutation and the audit row on failure', async () => {
    requirePrerequisite(tableCheck);
    const owner = await createAuthenticatedUser('owner');
    const member = await seedMember(owner.tenantId);

    const { error } = await supabaseAdmin.rpc('change_member_role_transaction', {
      p_tenant_id: owner.tenantId,
      p_target_user_id: member.userId,
      p_actor_id: owner.id,
      p_new_role: 'superadmin', // invalid enum value -> the whole transaction fails
      p_custom_role_id: null,
    });

    expect(error).not.toBeNull();

    // No audit row for THIS membership landed (a global row count would
    // race audit writes from parallel suites).
    const { data: orphanAudit } = await supabaseAdmin
      .from('audit_log')
      .select('id')
      .eq('target_id', member.membershipId);
    expect(orphanAudit).toEqual([]);

    const { data: membership } = await supabaseAdmin
      .from('membership')
      .select('role')
      .eq('id', member.membershipId)
      .single();
    expect(membership?.role).toBe('read');
  });

  it('remove_member_transaction deletes and audits atomically', async () => {
    requirePrerequisite(tableCheck);
    const owner = await createAuthenticatedUser('owner');
    const member = await seedMember(owner.tenantId);

    const { error } = await supabaseAdmin.rpc('remove_member_transaction', {
      p_tenant_id: owner.tenantId,
      p_target_user_id: member.userId,
      p_actor_id: owner.id,
    });
    expect(error).toBeNull();

    const { data: gone } = await supabaseAdmin
      .from('membership')
      .select('id')
      .eq('id', member.membershipId);
    expect(gone).toEqual([]);

    const { data: auditRows } = await supabaseAdmin
      .from('audit_log')
      .select('action_type, target_identifier, before_state')
      .eq('target_id', member.membershipId)
      .eq('action_type', 'member_removed');
    expect(auditRows).toEqual([
      {
        action_type: 'member_removed',
        target_identifier: member.email,
        before_state: { role: 'read', status: 'active' },
      },
    ]);
  });

  it('rejects a read-role actor with actor_not_authorized', async () => {
    requirePrerequisite(tableCheck);
    const owner = await createAuthenticatedUser('owner');
    const readActor = await seedMember(owner.tenantId, 'read');
    const target = await seedMember(owner.tenantId, 'read');

    const { error } = await supabaseAdmin.rpc('change_member_role_transaction', {
      p_tenant_id: owner.tenantId,
      p_target_user_id: target.userId,
      p_actor_id: readActor.userId,
      p_new_role: 'write',
      p_custom_role_id: null,
    });

    expect(error?.message).toContain('actor_not_authorized');

    const { data: membership } = await supabaseAdmin
      .from('membership')
      .select('role')
      .eq('id', target.membershipId)
      .single();
    expect(membership?.role).toBe('read');
  });

  it('rejects an owner targeting their own role with cannot_change_own_role', async () => {
    requirePrerequisite(tableCheck);
    const owner = await createAuthenticatedUser('owner');

    const { error } = await supabaseAdmin.rpc('change_member_role_transaction', {
      p_tenant_id: owner.tenantId,
      p_target_user_id: owner.id,
      p_actor_id: owner.id,
      p_new_role: 'admin',
      p_custom_role_id: null,
    });

    expect(error?.message).toContain('cannot_change_own_role');
  });

  it('rejects a non-owner admin promoting a member to owner', async () => {
    requirePrerequisite(tableCheck);
    const owner = await createAuthenticatedUser('owner');
    const adminActor = await seedMember(owner.tenantId, 'admin');
    const target = await seedMember(owner.tenantId, 'read');

    const { error } = await supabaseAdmin.rpc('change_member_role_transaction', {
      p_tenant_id: owner.tenantId,
      p_target_user_id: target.userId,
      p_actor_id: adminActor.userId,
      p_new_role: 'owner',
      p_custom_role_id: null,
    });

    expect(error?.message).toContain('only_owner_can_promote_to_owner');
  });

  // Regression test for the actor-authority guard reading the LIVE permission
  // set rather than a hardcoded owner/admin role check: assigning a custom
  // role pins the membership row's `role` column to the 'read' built-in
  // fallback (see change_member_role_transaction above), so a role-name check
  // on that pinned column would deny this actor even though they hold
  // membership.update.
  it('allows a custom-role actor holding membership.update to change roles', async () => {
    requirePrerequisite(tableCheck);
    const owner = await createAuthenticatedUser('owner');
    const customRole = await createCustomRole(supabaseAdmin, owner.tenantId, 'Member Manager', [
      'membership.update',
    ]);
    const customActor = await seedMember(owner.tenantId, 'read');
    await assignCustomRole(supabaseAdmin, customActor.membershipId, customRole.id);
    const target = await seedMember(owner.tenantId, 'read');

    const { error } = await supabaseAdmin.rpc('change_member_role_transaction', {
      p_tenant_id: owner.tenantId,
      p_target_user_id: target.userId,
      p_actor_id: customActor.userId,
      p_new_role: 'write',
      p_custom_role_id: null,
    });

    expect(error).toBeNull();

    const { data: membership } = await supabaseAdmin
      .from('membership')
      .select('role')
      .eq('id', target.membershipId)
      .single();
    expect(membership?.role).toBe('write');

    await cleanupCustomRoles(supabaseAdmin, owner.tenantId);
  });

  it('invite_existing_user_transaction writes the member_invited row in-transaction', async () => {
    requirePrerequisite(tableCheck);
    const owner = await createAuthenticatedUser('owner');
    const invitee = await createAuthenticatedUser('read'); // separate tenant; will be invited into owner's

    const invitedAt = new Date();
    const expiresAt = new Date(invitedAt.getTime() + 7 * 24 * 60 * 60 * 1000);

    const { data: membershipId, error } = await supabaseAdmin.rpc('invite_existing_user_transaction', {
      p_user_id: invitee.id,
      p_tenant_id: owner.tenantId,
      p_invited_by: owner.id,
      p_role: 'read',
      p_invited_at: invitedAt.toISOString(),
      p_expires_at: expiresAt.toISOString(),
      p_ip_address: '203.0.113.11',
      p_user_agent: 'integration-test',
      p_request_id: 'req-invite-1',
    });

    expect(error).toBeNull();
    expect(typeof membershipId).toBe('string');

    const { data: auditRows } = await supabaseAdmin
      .from('audit_log')
      .select('actor_id, action_type, target_identifier, after_state, ip_address')
      .eq('target_id', membershipId as string)
      .eq('action_type', 'member_invited');
    expect(auditRows).toEqual([
      {
        actor_id: owner.id,
        action_type: 'member_invited',
        target_identifier: invitee.email,
        after_state: { role: 'read', status: 'pending' },
        ip_address: '203.0.113.11',
      },
    ]);
  });
});
