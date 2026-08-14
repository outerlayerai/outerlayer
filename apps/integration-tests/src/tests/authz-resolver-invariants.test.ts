/**
 * Authz resolver — structural-invariant regression pins.
 *
 * The equivalence matrix pins that the consolidated resolver did not drift on
 * the behavior it preserves. THIS suite pins the behavior the consolidation
 * deliberately CORRECTED, so a future edit that reintroduces either fall-through
 * fails loudly rather than silently re-widening access:
 *
 *   Tenant closure. effective_app_permissions is closed over the actor's
 *      active tenant. An app in a DIFFERENT tenant is out of the domain — empty
 *      set, false boolean, absent from authorized_app_ids — for EVERY actor
 *      shape, owner included (an owner of tenant T holds no reach into tenant O).
 *   State gate. A disabled membership yields no effective role, so a per-app
 *      override has nothing to attach to: empty set + false boolean even with an
 *      app_member_role row present.
 *   Single resolution, owner top. An owner ignores a restrictive per-app
 *      override within its own tenant — its effective set for the app is exactly
 *      the org owner set.
 *   authorized_app_ids per-app replacement. An org-admin whose per-app override
 *      is a read-only role is NOT returned by authorized_app_ids for a write-class
 *      permission on that app, while an unoverridden app in the same tenant (org
 *      fallback) IS — the override REPLACES, it does not merely add.
 *
 * Mechanism mirrors authz-equivalence-matrix: seed production-shaped rows as the
 * postgres superuser (the private.* bodies are SECURITY DEFINER, unexposed over
 * PostgREST), mint each actor's JWT via the real custom_access_token_hook, pin it
 * into request.jwt.claims inside a transaction, and call the private resolver.
 */

import { randomUUID } from 'crypto';
import { Client } from 'pg';
import { describe, it, beforeAll, afterAll, expect } from 'vitest';
import { APP_PERMISSIONS } from '@repo/db-types/permissions';

const DATABASE_URL =
  process.env.DATABASE_URL || 'postgresql://postgres:postgres@127.0.0.1:54332/postgres';

let client: Client;

interface Fixture {
  homeTenantId: string;
  otherTenantId: string;
  appHome1: string; // per-app override target (each actor's row is seeded below)
  appHome2: string; // no per-app row → org fallback
  appOther: string; // app in the OTHER tenant
  ownerId: string;
  adminId: string;
  writeId: string;
  readId: string;
  disabledId: string;
  ownerOrgSet: string[]; // role_permissions['owner'], the expected owner effective set
}

// Every app_permission is granted to the owner role (the seed-completeness
// invariant: a value is either seeded to owner or does not exist), so no
// "owner-absent" permission can exist to probe additive escalation with. The
// override-ignoring invariant is proven the other way around: the owner's
// per-app override points at a deliberately RESTRICTIVE custom role, and the
// owner must still resolve to the full org owner set — the override neither
// restricts nor adds.
const APP_CUSTOM_PERMS = ['app.read'] as const;

async function seed(): Promise<Fixture> {
  const homeTenantId = randomUUID();
  const otherTenantId = randomUUID();
  const appHome1 = randomUUID();
  const appHome2 = randomUUID();
  const appOther = randomUUID();
  const appCustomRoleId = randomUUID();
  const ownerId = randomUUID();
  const adminId = randomUUID();
  const writeId = randomUUID();
  const readId = randomUUID();
  const disabledId = randomUUID();
  const sysOwner = randomUUID();
  const suffix = randomUUID().slice(0, 8);

  await client.query("SET session_replication_role = 'replica'");

  await client.query('INSERT INTO auth.users(id) VALUES ($1)', [sysOwner]);
  await client.query('INSERT INTO public.profile(id, name, email) VALUES ($1,$2,$3)', [
    sysOwner,
    'sys-owner',
    `sys-${suffix}@authz-inv.test`,
  ]);
  for (const [tid, name] of [
    [homeTenantId, `home-${suffix}`],
    [otherTenantId, `other-${suffix}`],
  ] as const) {
    await client.query(
      'INSERT INTO public.tenant(tenant_id, company_name, organization_name, created_by) VALUES ($1,$2,$3,$4)',
      [tid, 'co', name, sysOwner],
    );
  }
  for (const [appId, tid, label] of [
    [appHome1, homeTenantId, 'home1'],
    [appHome2, homeTenantId, 'home2'],
    [appOther, otherTenantId, 'other'],
  ] as const) {
    await client.query(
      'INSERT INTO public.app(id, name, tenant_id, created_by) VALUES ($1,$2,$3,$4)',
      [appId, `app-${label}-${suffix}`, tid, sysOwner],
    );
  }

  await client.query(
    'INSERT INTO public.custom_role(id, tenant_id, name, created_by) VALUES ($1,$2,$3,$4)',
    [appCustomRoleId, homeTenantId, `inv-app-custom-${suffix}`, sysOwner],
  );
  for (const p of APP_CUSTOM_PERMS) {
    await client.query(
      'INSERT INTO public.custom_role_permission(custom_role_id, permission) VALUES ($1,$2)',
      [appCustomRoleId, p],
    );
  }

  const mk = async (
    userId: string,
    role: string,
    override: { role: string; customRoleId: string | null },
  ): Promise<string> => {
    await client.query('INSERT INTO auth.users(id) VALUES ($1)', [userId]);
    await client.query('INSERT INTO public.profile(id, name, email) VALUES ($1,$2,$3)', [
      userId,
      role,
      `${role}-${suffix}@authz-inv.test`,
    ]);
    const membershipId = randomUUID();
    await client.query(
      `INSERT INTO public.membership(id, user_id, tenant_id, role, status, is_app_scoped)
       VALUES ($1,$2,$3,$4,'active',false)`,
      [membershipId, userId, homeTenantId, role],
    );
    // A per-app override on appHome1 for every actor — the hook that an owner
    // ignores and a disabled member cannot attach to.
    await client.query(
      `INSERT INTO public.app_member_role(membership_id, app_id, tenant_id, role, custom_role_id)
       VALUES ($1,$2,$3,$4,$5)`,
      [membershipId, appHome1, homeTenantId, override.role, override.customRoleId],
    );
    return membershipId;
  };

  // Owner's override is a deliberately RESTRICTIVE custom role (app.read only)
  // that the resolver must ignore for owners. The built-in role column stays a
  // real 'read' fallback (custom is active via custom_role_id). The others get
  // a restrictive built-in 'read' row. write/read exist to pin the built-in
  // environment.insert answers.
  await mk(ownerId, 'owner', { role: 'read', customRoleId: appCustomRoleId });
  await mk(adminId, 'admin', { role: 'read', customRoleId: null });
  await mk(writeId, 'write', { role: 'read', customRoleId: null });
  await mk(readId, 'read', { role: 'read', customRoleId: null });
  await mk(disabledId, 'disabled', { role: 'read', customRoleId: null });

  await client.query("SET session_replication_role = 'origin'");

  const org = await client.query<{ perms: string[] }>(
    `SELECT array_agg(permission::text ORDER BY permission::text COLLATE "C") AS perms
       FROM public.role_permissions WHERE role = 'owner'`,
  );

  return {
    homeTenantId,
    otherTenantId,
    appHome1,
    appHome2,
    appOther,
    ownerId,
    adminId,
    writeId,
    readId,
    disabledId,
    ownerOrgSet: org.rows[0]!.perms,
  };
}

async function teardown(fx: Fixture): Promise<void> {
  await client.query("SET session_replication_role = 'replica'");
  await client.query('DELETE FROM public.tenant WHERE tenant_id = ANY($1)', [
    [fx.homeTenantId, fx.otherTenantId],
  ]);
  await client.query('DELETE FROM public.profile WHERE email LIKE $1', ['%@authz-inv.test']);
  await client.query('DELETE FROM auth.users WHERE id = ANY($1)', [
    [fx.ownerId, fx.adminId, fx.writeId, fx.readId, fx.disabledId],
  ]);
  await client.query("SET session_replication_role = 'origin'");
}

async function mintClaims(userId: string, tenantId: string): Promise<string> {
  const res = await client.query<{ claims: unknown }>(
    `SELECT public.custom_access_token_hook(
        jsonb_build_object(
          'user_id', $1::text,
          'claims', jsonb_build_object(
            'sub', $1::text,
            'role', 'authenticated',
            'aud', 'authenticated',
            'app_metadata', jsonb_build_object('tenant_id', $2::text)
          )
        )
     ) -> 'claims' AS claims`,
    [userId, tenantId],
  );
  return JSON.stringify(res.rows[0]!.claims);
}

/** Pin the actor's JWT into the txn, run reads, always roll back. */
async function asActor<T>(userId: string, tenantId: string, fn: () => Promise<T>): Promise<T> {
  await client.query('BEGIN');
  try {
    const claims = await mintClaims(userId, tenantId);
    await client.query('SELECT set_config($1, $2, true)', ['request.jwt.claims', claims]);
    return await fn();
  } finally {
    await client.query('ROLLBACK');
  }
}

async function effectiveSet(appId: string): Promise<string[]> {
  const r = await client.query<{ perms: string[] | null }>(
    `SELECT array_agg(p::text ORDER BY p::text COLLATE "C") AS perms
       FROM private.effective_app_permissions($1::uuid) AS p`,
    [appId],
  );
  return r.rows[0]!.perms ?? [];
}

async function appAuth(perm: string, appId: string): Promise<boolean> {
  const r = await client.query<{ b: boolean }>(
    `SELECT private.app_authorize($1::public.app_permission, $2::uuid) AS b`,
    [perm, appId],
  );
  return r.rows[0]!.b;
}

async function authorizedAppIds(perm: string): Promise<string[]> {
  const r = await client.query<{ ids: string[] | null }>(
    `SELECT array_agg(id::text ORDER BY id::text COLLATE "C") AS ids
       FROM private.authorized_app_ids($1::public.app_permission) AS id`,
    [perm],
  );
  return r.rows[0]!.ids ?? [];
}

let fx: Fixture;

describe('Authz resolver — structural invariants (corrected-behavior pins)', () => {
  beforeAll(async () => {
    client = new Client({ connectionString: DATABASE_URL });
    await client.connect();
    fx = await seed();
  }, 60000);

  afterAll(async () => {
    if (fx) await teardown(fx);
    if (client) await client.end();
  }, 60000);

  it('an app in another tenant is out of range for a non-owner (empty set, deny, absent from set)', async () => {
    await asActor(fx.adminId, fx.homeTenantId, async () => {
      expect(await effectiveSet(fx.appOther)).toEqual([]);
      expect(await appAuth('app.read', fx.appOther)).toBe(false);
      expect(await authorizedAppIds('app.read')).not.toContain(fx.appOther);
    });
  });

  it('an app in another tenant is out of range for an OWNER too (no cross-tenant owner reach)', async () => {
    await asActor(fx.ownerId, fx.homeTenantId, async () => {
      expect(await effectiveSet(fx.appOther)).toEqual([]);
      expect(await appAuth('app.read', fx.appOther)).toBe(false);
      expect(await appAuth('tenant.update', fx.appOther)).toBe(false);
      expect(await authorizedAppIds('app.read')).not.toContain(fx.appOther);
    });
  });

  it('an id owned by NO tenant resolves as a prospective app of the actor tenant (INSERT WITH CHECK path)', async () => {
    // app INSERT policies call app_authorize(perm, NEW.id) before the row
    // exists; the resolver must resolve the org fallback for such ids (their
    // tenancy is pinned by the policy tenant check + set_tenant_id trigger),
    // while an id owned by another tenant stays out of range.
    const unclaimedId = randomUUID();
    await asActor(fx.adminId, fx.homeTenantId, async () => {
      expect(await appAuth('app.insert', unclaimedId)).toBe(true); // org-admin may create
      expect(await appAuth('app.insert', fx.appOther)).toBe(false); // foreign id never resolves
    });
    await asActor(fx.disabledId, fx.homeTenantId, async () => {
      // The state gate still precedes the prospective-app branch.
      expect(await effectiveSet(unclaimedId)).toEqual([]);
      expect(await appAuth('app.insert', unclaimedId)).toBe(false);
    });
  });

  it('a disabled member with a per-app override gets nothing (override cannot attach to a disabled role)', async () => {
    await asActor(fx.disabledId, fx.homeTenantId, async () => {
      // appHome1 carries a built-in 'read' app_member_role row for this member.
      expect(await effectiveSet(fx.appHome1)).toEqual([]);
      expect(await appAuth('app.read', fx.appHome1)).toBe(false);
      expect(await authorizedAppIds('app.read')).toEqual([]);
    });
  });

  it('an owner ignores a per-app override in its own tenant (full owner set, no additive escalation)', async () => {
    await asActor(fx.ownerId, fx.homeTenantId, async () => {
      // appHome1 overrides the owner to a custom role holding ONLY app.read;
      // the owner still resolves to exactly the org owner set — the override
      // neither restricts nor adds.
      expect(await effectiveSet(fx.appHome1)).toEqual(fx.ownerOrgSet);
      // A perm the restrictive override does NOT carry: the owner must keep it
      // through the org role (proving the override cannot restrict).
      expect(await appAuth('app.delete', fx.appHome1)).toBe(true);
      expect(APP_CUSTOM_PERMS).not.toContain('app.delete');
      // environment.insert, by contrast, IS in the org owner set now, so the
      // owner holds it here via the org role — not via the override, which does
      // not carry it.
      expect(await appAuth('environment.insert', fx.appHome1)).toBe(true);
      expect(fx.ownerOrgSet).toContain('environment.insert');
    });
  });

  it('owner consistency — app_authorize equals membership of effective_app_permissions for EVERY permission (no override fall-through)', async () => {
    await asActor(fx.ownerId, fx.homeTenantId, async () => {
      const set = new Set(await effectiveSet(fx.appHome1));
      // Boolean for every app_permission in one pass, on the app whose override
      // is the one a two-copies resolver leaks environment.insert through.
      const res = await client.query<{ perm: string; b: boolean }>(
        `SELECT p.perm::text AS perm,
                private.app_authorize(p.perm, $1::uuid) AS b
           FROM unnest(enum_range(NULL::public.app_permission)) AS p(perm)`,
        [fx.appHome1],
      );
      expect(res.rows.length).toBe(APP_PERMISSIONS.length);
      // The boolean is exactly the set-membership predicate — no perm is true
      // that is not in the resolved set, and none in the set reads false.
      const mismatches = res.rows
        .filter((r) => r.b !== set.has(r.perm))
        .map((r) => r.perm);
      expect(mismatches).toEqual([]);
      // Pin one row explicitly: a perm the restrictive override lacks reads
      // true for the owner — the boolean does not fall through to the override.
      expect(res.rows.find((r) => r.perm === 'app.delete')!.b).toBe(true);
    });
  });

  it('environment.insert is held by owner/admin/write and denied to read (per built-in role)', async () => {
    // appHome2 has no per-app override for any actor → each resolves to its org
    // role set. Pins the built-in matrix for environment.insert so a future
    // reseed that drops it from a write-capable role, or adds it to read, fails.
    const expected: Array<[string, boolean]> = [
      [fx.ownerId, true],
      [fx.adminId, true],
      [fx.writeId, true],
      [fx.readId, false],
    ];
    for (const [userId, want] of expected) {
      await asActor(userId, fx.homeTenantId, async () => {
        expect(await appAuth('environment.insert', fx.appHome2)).toBe(want);
      });
    }
    // A disabled member holds it nowhere (state gate precedes role resolution).
    await asActor(fx.disabledId, fx.homeTenantId, async () => {
      expect(await appAuth('environment.insert', fx.appHome2)).toBe(false);
    });
  });

  it('authorized_app_ids — a read-only per-app override REPLACES the org role: excluded for a write-class perm, present for read', async () => {
    await asActor(fx.adminId, fx.homeTenantId, async () => {
      // app.update: org-admin holds it; the 'read' override on appHome1 does not.
      // appHome2 (no override → org fallback) does. So appHome1 is REPLACED out.
      expect(await authorizedAppIds('app.update')).toEqual([fx.appHome2]);
      // app.read: both apps grant it.
      expect(await authorizedAppIds('app.read')).toEqual(
        [fx.appHome1, fx.appHome2].sort(),
      );
    });
  });
});
