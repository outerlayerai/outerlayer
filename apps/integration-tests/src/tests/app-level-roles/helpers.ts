/**
 * Shared helpers for app-level-roles integration tests.
 *
 * Key difference from standard createAuthenticatedUser: these helpers create
 * multiple users in the SAME tenant, which is required to test per-app role
 * scoping within a single org.
 */

import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { createSupabaseAdminClient } from '../../lib/supabase-admin';
import { retryOnTransientError } from '../../lib/retry';
import { deleteTenantsAndUsers } from '../../lib/tenant-cleanup';
import { randomUUID } from 'crypto';

export interface SameTenantUser {
  id: string;
  email: string;
  tenantId: string;
  membershipId: string;
  orgRole: string;
  client: SupabaseClient;
}

const supabaseUrl =
  process.env.NEXT_PUBLIC_SUPABASE_URL || 'http://127.0.0.1:54331';
const supabaseAnonKey =
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0';

/**
 * Create a tenant and owner user. Returns the tenantId and owner user.
 */
export async function createTenantWithOwner(): Promise<SameTenantUser> {
  const admin = createSupabaseAdminClient();
  const tenantId = randomUUID();
  const rid = Math.random().toString(36).substring(2, 8);
  const email = `owner-${Date.now()}-${rid}@test-app-roles.com`;
  const password = 'TestPassword123!';

  // Create tenant
  const { error: tenantError } = await retryOnTransientError(() =>
    admin.from('tenant').insert({
      tenant_id: tenantId,
      company_name: `app-roles-test-${rid}`,
      organization_name: `app-roles-org-${rid}`,
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
  const email = `${role}-${Date.now()}-${rid}@test-app-roles.com`;
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

/**
 * Clean up all users and tenant data created by the helpers above.
 * `createTenantWithOwner` always leaves the tenant with exactly one active
 * owner membership — see `deleteTenantsAndUsers` for why the delete order
 * and attempt-all-then-aggregate-throw behavior matter here.
 */
export async function cleanupTenantAndUsers(
  tenantId: string,
  users: SameTenantUser[]
): Promise<void> {
  const admin = createSupabaseAdminClient();
  await deleteTenantsAndUsers(admin, [tenantId], users);
}
