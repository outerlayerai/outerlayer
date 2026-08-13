/**
 * Shared fixtures for the billing + org-settings acceptance suites. Billing
 * and org-rename actions authorize against the request-resolved tenant, not
 * the JWT claim, so the scoping bug these suites pin only shows up for a
 * user who holds a role in MORE THAN ONE tenant — the JWT claim names one of
 * them, the URL/header names another. The one fixture both suites need is a
 * single actor with two real memberships, not two independent single-tenant
 * users like the simpler helper files (`custom-roles/helpers.ts`,
 * `app-level-roles/helpers.ts`) provide.
 */

import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { createSupabaseAdminClient, type SupabaseAdminClient } from '../../lib/supabase-admin';
import { retryOnTransientError, retryCreateAuthUser } from '../../lib/retry';
import { deleteTenantsAndUsers } from '../../lib/tenant-cleanup';
import type { Database } from 'tenant-dashboard/src/types/db';
import { randomUUID } from 'crypto';

type MembershipRole = Database['public']['Tables']['membership']['Insert']['role'];

export interface TenantUser {
  id: string;
  email: string;
  tenantId: string;
  membershipId: string;
  orgRole: MembershipRole;
  client: SupabaseClient<Database>;
}

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || 'http://127.0.0.1:54331';
const supabaseAnonKey =
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0';

/** Create a fresh tenant with an owner user. Mirrors custom-roles/helpers.ts. */
export async function createTenantWithOwner(): Promise<TenantUser> {
  const admin = createSupabaseAdminClient();
  const tenantId = randomUUID();
  const rid = Math.random().toString(36).substring(2, 8);
  const email = `owner-${Date.now()}-${rid}@test-billing-org.com`;
  const password = 'TestPassword123!';

  const { error: tenantError } = await retryOnTransientError(() =>
    admin.from('tenant').insert({
      tenant_id: tenantId,
      company_name: `billing-org-test-${rid}`,
      organization_name: `billing-org-org-${rid}`,
      created_by: randomUUID(),
    }),
  );
  if (tenantError) throw new Error(`Tenant create: ${tenantError.message}`);

  const { data: authData, error: authError } = await retryCreateAuthUser(() =>
    admin.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
    }),
  );
  if (authError || !authData?.user) throw new Error(`Auth user create: ${authError?.message}`);
  const userId = authData.user.id;

  await admin.from('tenant').update({ created_by: userId }).eq('tenant_id', tenantId);

  const { error: profileError } = await retryOnTransientError(() =>
    admin.from('profile').insert({ id: userId, name: `Owner ${rid}`, email }),
  );
  if (profileError) throw new Error(`Profile create: ${profileError.message}`);

  const { data: membershipData, error: membershipError } = await retryOnTransientError(() =>
    admin
      .from('membership')
      .insert({ user_id: userId, tenant_id: tenantId, role: 'owner', status: 'active' })
      .select('id')
      .single(),
  );
  if (membershipError) throw new Error(`Membership create: ${membershipError.message}`);

  await admin.rpc('set_claim', { claim: 'tenant_id', uid: userId, value: tenantId });
  await admin.rpc('set_claim', { claim: 'role', uid: userId, value: 'owner' });

  const client = createClient<Database>(supabaseUrl, supabaseAnonKey);
  const { error: signInError } = await client.auth.signInWithPassword({ email, password });
  if (signInError) throw new Error(`Sign in: ${signInError.message}`);
  await client.auth.refreshSession();

  return { id: userId, email, tenantId, membershipId: membershipData.id, orgRole: 'owner', client };
}

/**
 * Create a user who holds a DIFFERENT role in each of two existing tenants:
 * a JWT claim (`memberships[0]`, the "home"/signup tenant) that names one
 * org, a real membership row in another. `tenantId`/`orgRole` on the
 * returned record describe the home (claim) membership; both memberships
 * are real rows a header-scoped request can resolve.
 */
export async function createCrossTenantUser(
  memberships: [{ tenantId: string; role: MembershipRole }, { tenantId: string; role: MembershipRole }],
  emailTag: string,
): Promise<TenantUser> {
  const admin = createSupabaseAdminClient();
  const rid = Math.random().toString(36).substring(2, 8);
  const email = `${emailTag}-${Date.now()}-${rid}@test-billing-org.com`;
  const password = 'TestPassword123!';

  const { data: authData, error: authError } = await retryCreateAuthUser(() =>
    admin.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
    }),
  );
  if (authError || !authData?.user) throw new Error(`Auth user create: ${authError?.message}`);
  const userId = authData.user.id;

  const { error: profileError } = await retryOnTransientError(() =>
    admin.from('profile').insert({ id: userId, name: emailTag, email }),
  );
  if (profileError) throw new Error(`Profile create: ${profileError.message}`);

  let homeMembershipId = '';
  for (const [index, membership] of memberships.entries()) {
    const { data, error } = await retryOnTransientError(() =>
      admin
        .from('membership')
        .insert({
          user_id: userId,
          tenant_id: membership.tenantId,
          role: membership.role,
          status: 'active',
        })
        .select('id')
        .single(),
    );
    if (error) throw new Error(`Membership create (${membership.tenantId}): ${error.message}`);
    if (index === 0) homeMembershipId = data.id;
  }

  const [home] = memberships;
  await admin.rpc('set_claim', { claim: 'tenant_id', uid: userId, value: home.tenantId });
  await admin.rpc('set_claim', { claim: 'role', uid: userId, value: home.role });

  const client = createClient<Database>(supabaseUrl, supabaseAnonKey);
  const { error: signInError } = await client.auth.signInWithPassword({ email, password });
  if (signInError) throw new Error(`Sign in: ${signInError.message}`);
  await client.auth.refreshSession();

  return {
    id: userId,
    email,
    tenantId: home.tenantId,
    membershipId: homeMembershipId,
    orgRole: home.role,
    client,
  };
}

/** Insert a `billing` row. `tenant_id` is the primary key and IS the tenant id. */
export async function createBillingRecord(
  admin: SupabaseAdminClient,
  tenantId: string,
  tierId: string,
  createdBy: string,
  opts: { stripeCustomerId?: string | null; stripeSubscriptionId?: string | null } = {},
): Promise<void> {
  const rid = Math.random().toString(36).substring(2, 8);
  const { error } = await retryOnTransientError(() =>
    admin.from('billing').insert({
      tenant_id: tenantId,
      stripe_customer_id: opts.stripeCustomerId === undefined ? `cus_test_${Date.now()}_${rid}` : opts.stripeCustomerId,
      stripe_subscription_id: opts.stripeSubscriptionId ?? null,
      tier_id: tierId,
      created_by: createdBy,
    }),
  );
  if (error) throw new Error(`Billing create: ${error.message}`);
}

/**
 * `createTenantWithOwner` leaves each tenant with exactly one active owner
 * membership, and `createCrossTenantUser` can add another — see
 * `deleteTenantsAndUsers` for why the delete order and
 * attempt-all-then-aggregate-throw behavior matter here.
 */
export async function cleanupTenantsAndUsers(
  tenantIds: string[],
  users: TenantUser[],
): Promise<void> {
  const admin = createSupabaseAdminClient();
  await deleteTenantsAndUsers(admin, tenantIds, users);
}
