/**
 * Acceptance: how an ORG-level custom role resolves for an app-scoped member.
 *
 * These exercise `private.app_authorize` (01a-private-authz.sql) for a member
 * holding an org-level custom role (`membership.custom_role_id`), both
 * app-scoped (`membership.is_app_scoped = true`) and not, and with and without
 * an `app_member_role` row for the target app.
 *
 * What they pin:
 *   1. The claim path: custom_access_token_hook stamps `custom_role_id` into
 *      the JWT and org-level `authorize()` honors it.
 *   2. A NON-app-scoped member's org custom role flows through
 *      `app_authorize` via the Step-6 fallback (control).
 *   3. Flipping ONLY `is_app_scoped` — same session, same JWT claim —
 *      makes `app_authorize` deny an app with no `app_member_role` row
 *      (Step 5). Org-level `authorize()` still grants on the same claim,
 *      isolating the deny to the scoping flag. App-scoping is fail-closed by
 *      design; the deny is not a dropped claim.
 *   4. When a row exists, the row governs and org custom-role perms do NOT
 *      merge in — for both built-in and per-app custom role rows
 *      (resolution order: per-app row wins).
 */

import { describe, it, expect, afterAll } from 'vitest';

import {
  getSupabaseAdmin,
  createAuthenticatedUser,
  cleanupTestUsers,
  type TestUser,
} from '../../lib/test-utils';
import { createTestApp } from '../../lib/app-test-utils';
import { retryOnTransientError } from '../../lib/retry';

// ---------------------------------------------------------------------------
// Helpers (same shapes as app-scoped-custom-role-permissions.test.ts)
// ---------------------------------------------------------------------------

async function getMembershipId(userId: string, tenantId: string): Promise<string> {
  const admin = getSupabaseAdmin();
  const { data, error } = await admin
    .from('membership')
    .select('id')
    .eq('user_id', userId)
    .eq('tenant_id', tenantId)
    .single();
  if (error || !data) throw new Error(`membership lookup failed: ${error?.message}`);
  return data.id;
}

async function createCustomRole(
  tenantId: string,
  name: string,
  permissions: string[],
): Promise<string> {
  const admin = getSupabaseAdmin();
  const { data, error } = await admin
    .from('custom_role')
    .insert({ tenant_id: tenantId, name })
    .select('id')
    .single();
  if (error || !data) throw new Error(`custom_role insert failed: ${error?.message}`);

  const rows = permissions.map((permission) => ({
    custom_role_id: data.id,
    permission: permission as never,
  }));
  const { error: permError } = await retryOnTransientError(() =>
    admin.from('custom_role_permission').insert(rows),
  );
  if (permError) throw new Error(`custom_role_permission insert failed: ${permError.message}`);

  return data.id;
}

async function assignPerAppRole(opts: {
  membershipId: string;
  appId: string;
  tenantId: string;
  role: 'read' | 'write' | 'admin';
  customRoleId?: string | null;
}): Promise<void> {
  const admin = getSupabaseAdmin();
  const { error } = await admin.from('app_member_role').insert({
    membership_id: opts.membershipId,
    app_id: opts.appId,
    tenant_id: opts.tenantId,
    role: opts.role,
    custom_role_id: opts.customRoleId ?? null,
  });
  if (error) throw new Error(`app_member_role insert failed: ${error.message}`);
}

/** Update the scoping flag WITHOUT touching custom_role_id (the flag is read
 *  from the membership table at call time — Step 4 — so no token refresh is
 *  needed, which is what lets the flip-only test hold the JWT constant). */
async function setAppScoped(userId: string, isAppScoped: boolean): Promise<void> {
  const admin = getSupabaseAdmin();
  const { error } = await admin
    .from('membership')
    .update({ is_app_scoped: isAppScoped })
    .eq('user_id', userId);
  if (error) throw new Error(`is_app_scoped update failed: ${error.message}`);
}

async function setOrgCustomRole(userId: string, customRoleId: string | null): Promise<void> {
  const admin = getSupabaseAdmin();
  const { error } = await admin
    .from('membership')
    .update({ custom_role_id: customRoleId })
    .eq('user_id', userId);
  if (error) throw new Error(`membership custom_role_id update failed: ${error.message}`);
}

async function orgAuthorize(user: TestUser, permission: string): Promise<boolean> {
  const { data, error } = await retryOnTransientError(() =>
    user.client.rpc('authorize', { requested_permission: permission as never }),
  );
  if (error) throw new Error(`authorize(${permission}) failed: ${error.message}`);
  return data === true;
}

async function appAuthorize(user: TestUser, permission: string, appId: string): Promise<boolean> {
  const { data, error } = await retryOnTransientError(() =>
    user.client.rpc('app_authorize', {
      requested_permission: permission as never,
      target_app_id: appId,
    }),
  );
  if (error) throw new Error(`app_authorize(${permission}) failed: ${error.message}`);
  return data === true;
}

async function appPerms(user: TestUser, appId: string): Promise<Set<string>> {
  const { data, error } = await retryOnTransientError(() =>
    user.client.rpc('get_current_user_app_permissions', { target_app_id: appId }),
  );
  if (error) throw new Error(`get_current_user_app_permissions failed: ${error.message}`);
  return new Set((data ?? []) as string[]);
}

// Org custom role: read perms plus writes the built-in "read" role does NOT
// have — so any merge of org perms into a per-app resolution is visible.
const ORG_ROLE_PERMS = ['app.read', 'sso_config.read', 'sso_config.insert', 'sso_config.delete'];

/** Fresh user with an org-level custom role stamped into the JWT. */
async function createOrgCustomRoleUser(): Promise<{
  user: TestUser;
  membershipId: string;
  orgRoleId: string;
}> {
  const user = await createAuthenticatedUser('read');
  const membershipId = await getMembershipId(user.id, user.tenantId);
  const orgRoleId = await createCustomRole(
    user.tenantId,
    `org-editor-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    ORG_ROLE_PERMS,
  );
  // Refresh so custom_access_token_hook repopulates the custom_role_id claim
  // from membership — the production flow.
  await setOrgCustomRole(user.id, orgRoleId);
  await user.client.auth.refreshSession();
  return { user, membershipId, orgRoleId };
}

// ---------------------------------------------------------------------------

describe('app_authorize — app-scoped member holding an ORG-level custom role', () => {
  afterAll(async () => {
    await cleanupTestUsers();
  });

  it('org custom role flows through the JWT and the unrestricted fallback (claim-path control)', async () => {
    const { user } = await createOrgCustomRoleUser();
    const app = await createTestApp(user.tenantId);

    // The hook stamped the claim and org-level authorize() honors it —
    // including a write perm the built-in "read" role lacks.
    expect(await orgAuthorize(user, 'sso_config.insert')).toBe(true);
    expect(await orgAuthorize(user, 'sso_config.update')).toBe(false); // not granted by the org role

    // NOT app-scoped + no app_member_role row → Step-6 fallback carries the
    // org custom role into per-app checks.
    expect(await appAuthorize(user, 'sso_config.insert', app.id)).toBe(true);
    expect(await appAuthorize(user, 'sso_config.delete', app.id)).toBe(true);
    expect(await appAuthorize(user, 'sso_config.update', app.id)).toBe(false);
  });

  it('flipping ONLY is_app_scoped denies an unassigned app while the org claim still grants (fail-closed design)', async () => {
    const { user } = await createOrgCustomRoleUser();
    const app = await createTestApp(user.tenantId);

    // Control: fallback grants before the flip.
    expect(await appAuthorize(user, 'sso_config.insert', app.id)).toBe(true);

    // Flip the flag only — same session, same JWT, custom_role_id untouched.
    await setAppScoped(user.id, true);

    // Org-level authorize() still grants on the very same claim...
    expect(await orgAuthorize(user, 'sso_config.insert')).toBe(true);
    // ...but app_authorize denies EVERY org-role perm for an app with no
    // app_member_role row (Step 5). The deny comes from the scoping flag, not
    // a dropped claim.
    for (const permission of ORG_ROLE_PERMS) {
      expect(await appAuthorize(user, permission, app.id)).toBe(false);
    }
    // The effective-set RPC agrees: empty.
    expect((await appPerms(user, app.id)).size).toBe(0);
  });

  it('with a built-in per-app row, the row governs — org custom-role perms do not merge', async () => {
    const { user, membershipId } = await createOrgCustomRoleUser();
    const app = await createTestApp(user.tenantId);

    await assignPerAppRole({
      membershipId,
      appId: app.id,
      tenantId: user.tenantId,
      role: 'read',
      customRoleId: null,
    });
    await setAppScoped(user.id, true);

    // Built-in "read" grants reads...
    expect(await appAuthorize(user, 'tenant.read', app.id)).toBe(true);
    expect(await appAuthorize(user, 'app.read', app.id)).toBe(true);
    // ...and the org custom role's writes do NOT leak through the row.
    expect(await appAuthorize(user, 'sso_config.insert', app.id)).toBe(false);
    expect(await appAuthorize(user, 'sso_config.delete', app.id)).toBe(false);

    const perms = await appPerms(user, app.id);
    expect(perms.has('sso_config.insert')).toBe(false);
    expect(perms.has('sso_config.delete')).toBe(false);
    expect(perms.has('tenant.read')).toBe(true);
  });

  it('with a per-app custom-role row, the row governs — org custom-role perms do not merge', async () => {
    const { user, membershipId } = await createOrgCustomRoleUser();
    const app = await createTestApp(user.tenantId);

    // Disjoint from the org role's writes so a merge would be visible.
    const perAppRoleId = await createCustomRole(
      user.tenantId,
      `app-updater-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      ['app.read', 'sso_config.update'],
    );
    await assignPerAppRole({
      membershipId,
      appId: app.id,
      tenantId: user.tenantId,
      role: 'read',
      customRoleId: perAppRoleId,
    });
    await setAppScoped(user.id, true);

    // Exactly the per-app set...
    const perms = await appPerms(user, app.id);
    expect([...perms].sort()).toEqual(['app.read', 'sso_config.update']);
    // ...org-role-only perms are denied even though the JWT claim grants them
    // at org level.
    expect(await orgAuthorize(user, 'sso_config.insert')).toBe(true);
    expect(await appAuthorize(user, 'sso_config.insert', app.id)).toBe(false);
    expect(await appAuthorize(user, 'sso_config.delete', app.id)).toBe(false);
    expect(await appAuthorize(user, 'sso_config.update', app.id)).toBe(true);
  });
});
