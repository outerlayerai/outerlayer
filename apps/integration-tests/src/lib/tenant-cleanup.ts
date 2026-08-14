/**
 * Shared tenant/user teardown for integration-test fixtures.
 *
 * `membership.user_id` cascades from `auth.users`, so deleting a user's auth
 * record directly cascades into the same membership delete a raw `tenant`
 * delete does. For a tenant with a single active owner (every
 * `createTenantWithOwner`/`createAuthenticatedUser('owner')` fixture),
 * either delete trips the `protect_last_owner` trigger and fails.
 * `platform_admin_delete_tenant` (SECURITY DEFINER) sets the compensating
 * flag that trigger checks for before it deletes the tenant, so tenants
 * must go first — clearing every owner membership before any auth-user
 * delete below can reach it. `profile.id` carries its own
 * `ON DELETE CASCADE` from `auth.users`, so the auth-user delete alone
 * covers the profile row too.
 */

export interface CleanupUser {
  id: string;
  email?: string;
}

interface CleanupOutcome {
  succeededTenantIds: string[];
  succeededUserIds: string[];
}

export class TenantCleanupError extends Error {
  readonly succeededTenantIds: string[];
  readonly succeededUserIds: string[];

  constructor(message: string, outcome: CleanupOutcome) {
    super(message);
    this.name = 'TenantCleanupError';
    this.succeededTenantIds = outcome.succeededTenantIds;
    this.succeededUserIds = outcome.succeededUserIds;
  }
}

// Structural rather than the concrete `SupabaseAdminClient` type: a couple of
// callers hold a client cast to `SupabaseClient` for tables codegen
// hasn't caught up to yet, and this function only needs `.rpc` + auth admin.
// `fn` is narrowed to the exact RPC name this module calls (rather than
// `string`) because the generated `SupabaseAdminClient.rpc` only accepts its
// known function-name union — a `string`-typed slot here would reject it.
interface AdminClientLike {
  rpc: (
    fn: 'platform_admin_delete_tenant',
    args: { p_tenant_id: string },
  ) => PromiseLike<{ error: { message: string } | null }>;
  auth: {
    admin: {
      deleteUser: (
        id: string,
      ) => PromiseLike<{ error: { message: string; code?: string } | null }>;
    };
  };
}

/**
 * Deletes every tenant in `tenantIds` (via the RPC above), then every user
 * in `users` — in that order, never the reverse.
 *
 * Every tenant and every user is attempted regardless of earlier failures:
 * a bad delete must never stop a later delete in the same cleanup from
 * running, so one leaked fixture doesn't cascade into leaking the rest of
 * the batch. An already-deleted auth user (`user_not_found`) counts as
 * success, not failure, so a retried cleanup is idempotent; a re-run of the
 * tenant RPC against an already-deleted tenant is a no-op for the same
 * reason (`DELETE ... WHERE tenant_id = $1` matches zero rows, no error).
 *
 * Collected errors are thrown together at the end as one
 * `TenantCleanupError`, which carries which tenants/users DID succeed —
 * a caller tracking mutable cleanup state (e.g. a shared `testUsers` array)
 * prunes exactly those before rethrowing, instead of retrying work that's
 * already done.
 */
export async function deleteTenantsAndUsers(
  admin: AdminClientLike,
  tenantIds: readonly string[],
  users: readonly CleanupUser[],
): Promise<void> {
  const errors: string[] = [];
  const succeededTenantIds: string[] = [];
  const succeededUserIds: string[] = [];

  for (const tenantId of tenantIds) {
    const { error } = await admin.rpc('platform_admin_delete_tenant', {
      p_tenant_id: tenantId,
    });
    if (error) errors.push(`tenant ${tenantId}: ${error.message}`);
    else succeededTenantIds.push(tenantId);
  }

  for (const user of users) {
    const { error } = await admin.auth.admin.deleteUser(user.id);
    if (error && error.code !== 'user_not_found') {
      errors.push(`auth user ${user.email ?? user.id}: ${error.message}`);
    } else {
      succeededUserIds.push(user.id);
    }
  }

  if (errors.length > 0) {
    throw new TenantCleanupError(`Tenant/user cleanup failed:\n${errors.join('\n')}`, {
      succeededTenantIds,
      succeededUserIds,
    });
  }
}
