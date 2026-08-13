/**
 * Shared helpers for custom-roles integration tests.
 *
 * Follows the same pattern as app-level-roles/helpers.ts:
 * multiple users in the SAME tenant, with helper functions for
 * creating, assigning, and cleaning up custom roles.
 */

import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { createSupabaseAdminClient, SupabaseAdminClient } from '../../lib/supabase-admin';
import { retryOnTransientError } from '../../lib/retry';
import type { Database } from 'tenant-dashboard/src/types/db';
import { randomUUID } from 'crypto';

type MembershipRole = Database['public']['Tables']['membership']['Insert']['role'];
type AppMemberRole = Database['public']['Tables']['app_member_role']['Insert']['role'];
type CustomRolePermission =
  Database['public']['Tables']['custom_role_permission']['Insert']['permission'];

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface SameTenantUser {
  id: string;
  email: string;
  tenantId: string;
  membershipId: string;
  orgRole: MembershipRole;
  client: SupabaseClient<Database>;
}

export interface CustomRole {
  id: string;
  name: string;
  tenantId: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Connection config
// ─────────────────────────────────────────────────────────────────────────────

const supabaseUrl =
  process.env.NEXT_PUBLIC_SUPABASE_URL || 'http://127.0.0.1:54331';
const supabaseAnonKey =
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0';

// ─────────────────────────────────────────────────────────────────────────────
// Tenant + User Setup (mirrors app-level-roles/helpers.ts)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Create a tenant and owner user. Returns the tenantId and owner user.
 */
export async function createTenantWithOwner(): Promise<SameTenantUser> {
  const admin = createSupabaseAdminClient();
  const tenantId = randomUUID();
  const rid = Math.random().toString(36).substring(2, 8);
  const email = `owner-${Date.now()}-${rid}@test-custom-roles.com`;
  const password = 'TestPassword123!';

  // Create tenant
  const { error: tenantError } = await retryOnTransientError(() =>
    admin.from('tenant').insert({
      tenant_id: tenantId,
      company_name: `custom-roles-test-${rid}`,
      organization_name: `custom-roles-org-${rid}`,
      created_by: randomUUID(), // placeholder, updated below
    })
  );
  if (tenantError) throw new Error(`Tenant create: ${tenantError.message}`);

  // Create auth user
  const { data: authData, error: authError } =
    await admin.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
    });
  if (authError || !authData?.user)
    throw new Error(`Auth user create: ${authError?.message}`);
  const userId = authData.user.id;

  // Update tenant created_by
  await admin.from('tenant').update({ created_by: userId }).eq('tenant_id', tenantId);

  // Create profile
  const { error: profileError } = await retryOnTransientError(() =>
    admin.from('profile').insert({
      id: userId,
      name: `Owner ${rid}`,
      email,
    })
  );
  if (profileError) throw new Error(`Profile create: ${profileError.message}`);

  // Create membership as owner
  const { data: membershipData, error: membershipError } = await retryOnTransientError(() =>
    admin
      .from('membership')
      .insert({
        user_id: userId,
        tenant_id: tenantId,
        role: 'owner',
        status: 'active',
      })
      .select('id')
      .single()
  );
  if (membershipError)
    throw new Error(`Membership create: ${membershipError.message}`);

  // Set JWT claims
  await admin.rpc('set_claim', {
    claim: 'tenant_id',
    uid: userId,
    value: tenantId,
  });
  await admin.rpc('set_claim', {
    claim: 'role',
    uid: userId,
    value: 'owner',
  });

  // Sign in
  const client = createClient(supabaseUrl, supabaseAnonKey);
  const { error: signInError } = await client.auth.signInWithPassword({
    email,
    password,
  });
  if (signInError) throw new Error(`Sign in: ${signInError.message}`);
  await client.auth.refreshSession();

  return {
    id: userId,
    email,
    tenantId,
    membershipId: membershipData.id,
    orgRole: 'owner',
    client,
  };
}

/**
 * Add a user to an existing tenant with a specific org-level role.
 */
export async function addUserToTenant(
  tenantId: string,
  role: 'admin' | 'write' | 'read'
): Promise<SameTenantUser> {
  const admin = createSupabaseAdminClient();
  const rid = Math.random().toString(36).substring(2, 8);
  const email = `${role}-${Date.now()}-${rid}@test-custom-roles.com`;
  const password = 'TestPassword123!';

  // Create auth user
  const { data: authData, error: authError } =
    await admin.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
    });
  if (authError || !authData?.user)
    throw new Error(`Auth user create: ${authError?.message}`);
  const userId = authData.user.id;

  // Create profile
  const { error: profileError } = await retryOnTransientError(() =>
    admin.from('profile').insert({
      id: userId,
      name: `${role} user ${rid}`,
      email,
    })
  );
  if (profileError) throw new Error(`Profile create: ${profileError.message}`);

  // Create membership in the SAME tenant
  const { data: membershipData, error: membershipError } = await retryOnTransientError(() =>
    admin
      .from('membership')
      .insert({
        user_id: userId,
        tenant_id: tenantId,
        role,
        status: 'active',
      })
      .select('id')
      .single()
  );
  if (membershipError)
    throw new Error(`Membership create: ${membershipError.message}`);

  // Set JWT claims to point at the shared tenant
  await admin.rpc('set_claim', {
    claim: 'tenant_id',
    uid: userId,
    value: tenantId,
  });
  await admin.rpc('set_claim', {
    claim: 'role',
    uid: userId,
    value: role,
  });

  // Sign in
  const client = createClient(supabaseUrl, supabaseAnonKey);
  const { error: signInError } = await client.auth.signInWithPassword({
    email,
    password,
  });
  if (signInError) throw new Error(`Sign in: ${signInError.message}`);
  await client.auth.refreshSession();

  return {
    id: userId,
    email,
    tenantId,
    membershipId: membershipData.id,
    orgRole: role,
    client,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Custom Role Helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Create a custom role with the given permissions via the admin client.
 * Returns the custom role record.
 */
export async function createCustomRole(
  adminClient: SupabaseAdminClient,
  tenantId: string,
  name: string,
  permissions: CustomRolePermission[]
): Promise<CustomRole> {
  const { data, error } = await retryOnTransientError(() =>
    adminClient
      .from('custom_role')
      .insert({
        tenant_id: tenantId,
        name,
      })
      .select('id, name, tenant_id')
      .single()
  );
  if (error) throw new Error(`Custom role create: ${error.message}`);

  // Insert permissions if any
  if (permissions.length > 0) {
    const permRows = permissions.map((perm) => ({
      custom_role_id: data.id,
      permission: perm,
    }));
    const { error: permError } = await retryOnTransientError(() =>
      adminClient.from('custom_role_permission').insert(permRows)
    );
    if (permError)
      throw new Error(`Custom role permission insert: ${permError.message}`);
  }

  return {
    id: data.id,
    name: data.name,
    tenantId: data.tenant_id,
  };
}

/**
 * Assign a custom role to a membership and set the JWT claim.
 * Refreshes the user's session so the JWT includes the custom_role_id.
 */
export async function assignCustomRole(
  adminClient: SupabaseAdminClient,
  membershipId: string,
  customRoleId: string | null
): Promise<void> {
  const { error } = await retryOnTransientError(() =>
    adminClient
      .from('membership')
      .update({ custom_role_id: customRoleId })
      .eq('id', membershipId)
  );
  if (error)
    throw new Error(`Assign custom role: ${error.message}`);
}

/**
 * Set the custom_role_id JWT claim for a user and refresh their session.
 * This is needed because the authorize() function reads custom_role_id from the JWT.
 */
export async function setCustomRoleClaim(
  adminClient: SupabaseAdminClient,
  userId: string,
  customRoleId: string | null,
  userClient: SupabaseClient
): Promise<void> {
  await adminClient.rpc('set_claim', {
    claim: 'custom_role_id',
    uid: userId,
    value: customRoleId,
  });
  await userClient.auth.refreshSession();
}

/**
 * Delete all custom_role rows for a tenant.
 * CASCADE on custom_role_permission handles permission cleanup.
 * Also NULLs membership.custom_role_id via ON DELETE SET NULL.
 */
export async function cleanupCustomRoles(
  adminClient: SupabaseAdminClient,
  tenantId: string
): Promise<void> {
  await adminClient.from('custom_role').delete().eq('tenant_id', tenantId);
}

/**
 * Create an app in a tenant via admin client. Returns the app record.
 */
export async function createTestApp(
  adminClient: SupabaseAdminClient,
  tenantId: string,
  name?: string,
): Promise<{ id: string; name: string }> {
  const rid = Math.random().toString(36).substring(2, 8);
  const { data, error } = await retryOnTransientError(() =>
    adminClient
      .from('app')
      .insert({
        tenant_id: tenantId,
        name: name || `test-app-${rid}`,
      })
      .select('id, name')
      .single()
  );
  if (error) throw new Error(`App create: ${error.message}`);
  return data;
}

/**
 * Create a billing record for a tenant with a specific tier.
 */
export async function createBillingRecord(
  adminClient: SupabaseAdminClient,
  tenantId: string,
  tierId: string,
  createdBy?: string,
): Promise<void> {
  const rid = Math.random().toString(36).substring(2, 8);
  const { error } = await retryOnTransientError(() =>
    adminClient.from('billing').insert({
      tenant_id: tenantId,
      stripe_customer_id: `cus_test_${Date.now()}_${rid}`,
      tier_id: tierId,
      created_by: createdBy || null,
    })
  );
  if (error) throw new Error(`Billing create: ${error.message}`);
}

/**
 * Update the billing tier for a tenant.
 */
export async function updateBillingTier(
  adminClient: SupabaseAdminClient,
  tenantId: string,
  tierId: string,
): Promise<void> {
  const { data, error } = await retryOnTransientError(() =>
    adminClient
      .from('billing')
      .update({ tier_id: tierId })
      .eq('tenant_id', tenantId)
      .select('tenant_id')
      .single()
  );
  if (error) throw new Error(`Billing update: ${error.message}`);
  if (!data) throw new Error(`Billing update: no row matched for tenant ${tenantId}`);
}

/**
 * Clean up billing record for a tenant.
 */
export async function cleanupBilling(
  adminClient: SupabaseAdminClient,
  tenantId: string,
): Promise<void> {
  await adminClient.from('billing').delete().eq('tenant_id', tenantId);
}

/**
 * Insert an app_member_role record via admin client.
 */
export async function createAppMemberRole(
  adminClient: SupabaseAdminClient,
  opts: {
    membershipId: string;
    appId: string;
    tenantId: string;
    role: AppMemberRole;
    customRoleId?: string | null;
    createdBy?: string;
  },
): Promise<{ id: string }> {
  const insertData: Database['public']['Tables']['app_member_role']['Insert'] = {
    membership_id: opts.membershipId,
    app_id: opts.appId,
    tenant_id: opts.tenantId,
    role: opts.role,
  };
  if (opts.customRoleId !== undefined) insertData.custom_role_id = opts.customRoleId;
  if (opts.createdBy) insertData.created_by = opts.createdBy;

  const { data, error } = await retryOnTransientError(() =>
    adminClient
      .from('app_member_role')
      .insert(insertData)
      .select('id')
      .single()
  );
  if (error) throw new Error(`app_member_role create: ${error.message}`);
  return data;
}

/**
 * Clean up all users and tenant data created by the helpers above.
 *
 * `createTenantWithOwner` always leaves the tenant with exactly one active
 * owner membership. `membership.user_id` cascades from `auth.users`, so
 * deleting the auth user directly would cascade into the same membership
 * delete a raw `tenant` delete does — tripping the `protect_last_owner`
 * trigger either way. The tenant must go first, via the
 * `platform_admin_delete_tenant` RPC (SECURITY DEFINER; sets the
 * compensating flag `protect_last_owner` checks for), so its cascade
 * (app_member_role, api_key, app, tenant_entitlement_override, billing,
 * custom_role, membership, …) removes the owner membership before the auth
 * user delete below ever reaches it. Every step throws on error instead of
 * swallowing it, so a failed cleanup fails the suite loudly rather than
 * leaking a tenant.
 */
export async function cleanupTenantAndUsers(
  tenantId: string,
  users: SameTenantUser[]
): Promise<void> {
  const admin = createSupabaseAdminClient();

  const { error: tenantError } = await admin.rpc('platform_admin_delete_tenant', {
    p_tenant_id: tenantId,
  });
  if (tenantError) throw new Error(`Tenant delete: ${tenantError.message}`);

  for (const user of users) {
    const { error: profileError } = await admin.from('profile').delete().eq('id', user.id);
    if (profileError)
      throw new Error(`Profile delete for ${user.email}: ${profileError.message}`);

    const { error: authError } = await admin.auth.admin.deleteUser(user.id);
    if (authError) throw new Error(`Auth user delete for ${user.email}: ${authError.message}`);
  }
}
