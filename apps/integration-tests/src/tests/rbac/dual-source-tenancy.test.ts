/**
 * Dual-source tenancy — claim/header equivalence, spoof fail-closed, cross-tenant role.
 *
 * The DB scopes a request by a validated X-Tenant-Id header when one is present
 * and by the claim otherwise. These are TRANSITION pins (while the app still
 * sends only claims); they are deleted when the claim fallback is removed.
 *
 * Three properties, evaluated against the real resolver via raw pg (the
 * private.* bodies are SECURITY DEFINER and unexposed, so they cannot be reached
 * through supabase-js). Claims are minted by the real custom_access_token_hook
 * and pinned into request.jwt.claims; the header is pinned into request.headers.
 *
 *  (1) Equivalence: for the SAME tenant, a claim-sourced request and a
 *      header-sourced request resolve identically across authorize / app_authorize
 *      / effective set / authorized_app_ids. Any surface where the two arms
 *      diverge fails here.
 *  (2) Spoof fail-closed: a header for a tenant the caller is not an active member
 *      of (and a malformed header) resolves tenant_id() to NULL — resolver empty,
 *      authorized_app_ids empty, and a set_tenant_id()-stamped INSERT fails rather
 *      than silently stamping the claim tenant.
 *  (3) Cross-tenant role: an actor who is admin in T1 and read in T2, whose claims
 *      are minted for T1, gets T2's READ answers under a T2 header — not T1's
 *      admin. This is the confusion resolving the org role from membership kills.
 */

import { randomUUID } from 'crypto';
import { Client } from 'pg';
import { describe, it, beforeAll, afterAll, expect } from 'vitest';

const DATABASE_URL =
  process.env.DATABASE_URL || 'postgresql://postgres:postgres@127.0.0.1:54332/postgres';

let client: Client;

interface Fixture {
  t1: string;
  t2: string;
  t3NonMember: string;
  appT1: string;
  appT2: string;
  orgCustomRole: string;
  uOwner: string;
  uAdmin: string; // admin in T1, read in T2
  uWrite: string;
  uRead: string;
  uOrgCustom: string; // read membership carrying an org custom role in T1
  uPending: string; // status='pending' membership in T1 (invited, not yet a member)
  uDisabled: string; // role='disabled' membership in T1
  uRemoved: string; // membership in T1 was DELETED after the claim was minted
  sys: string; // fixture owner for created_by FKs
}

let fx: Fixture;

/** The claims the auth server would mint for (user, tenant), via the real hook. */
async function mintClaims(userId: string, tenantId: string): Promise<string> {
  const res = await client.query<{ claims: unknown }>(
    `SELECT public.custom_access_token_hook(
        jsonb_build_object(
          'user_id', $1::text,
          'claims', jsonb_build_object(
            'sub', $1::text, 'role', 'authenticated', 'aud', 'authenticated',
            'app_metadata', jsonb_build_object('tenant_id', $2::text)
          )
        )
     ) -> 'claims' AS claims`,
    [userId, tenantId],
  );
  return JSON.stringify(res.rows[0]!.claims);
}

/**
 * Run body inside a transaction with request.jwt.claims (claim tenant) and,
 * optionally, request.headers x-tenant-id (header value) set, then roll back so
 * no GUC or role leaks. asRole toggles SET LOCAL ROLE for the RLS-sensitive pins.
 */
async function inRequest<T>(
  opts: { claims: string; header?: string | null; asRole?: string },
  body: () => Promise<T>,
): Promise<T> {
  await client.query('BEGIN');
  try {
    await client.query('SELECT set_config($1,$2,true)', ['request.jwt.claims', opts.claims]);
    if (opts.header !== undefined && opts.header !== null) {
      await client.query('SELECT set_config($1,$2,true)', [
        'request.headers',
        JSON.stringify({ 'x-tenant-id': opts.header }),
      ]);
    }
    if (opts.asRole) await client.query(`SET LOCAL ROLE ${opts.asRole}`);
    return await body();
  } finally {
    await client.query('ROLLBACK');
  }
}

/** authorize() over every app_permission, as a perm→boolean map. */
async function authorizeVector(): Promise<Record<string, boolean>> {
  const r = await client.query<{ perm: string; b: boolean }>(
    `SELECT p.perm::text AS perm, private.authorize(p.perm) AS b
       FROM unnest(enum_range(NULL::public.app_permission)) AS p(perm)`,
  );
  return Object.fromEntries(r.rows.map((x) => [x.perm, x.b]));
}

/** app_authorize(perm, app) over every app_permission, as a perm→boolean map. */
async function appAuthVector(appId: string): Promise<Record<string, boolean>> {
  const r = await client.query<{ perm: string; b: boolean }>(
    `SELECT p.perm::text AS perm, private.app_authorize(p.perm, $1::uuid) AS b
       FROM unnest(enum_range(NULL::public.app_permission)) AS p(perm)`,
    [appId],
  );
  return Object.fromEntries(r.rows.map((x) => [x.perm, x.b]));
}

async function effectiveSet(appId: string): Promise<string[]> {
  const r = await client.query<{ perm: string }>(
    `SELECT p::text AS perm FROM private.effective_app_permissions($1::uuid) AS p ORDER BY p::text COLLATE "C"`,
    [appId],
  );
  return r.rows.map((x) => x.perm);
}

async function authorizedApps(perm: string): Promise<string[]> {
  const r = await client.query<{ id: string }>(
    `SELECT id::text FROM private.authorized_app_ids($1::public.app_permission) AS id ORDER BY id::text`,
    [perm],
  );
  return r.rows.map((x) => x.id).sort();
}

beforeAll(async () => {
  client = new Client({ connectionString: DATABASE_URL });
  await client.connect();

  const suffix = randomUUID().slice(0, 8);
  const f: Fixture = {
    t1: randomUUID(),
    t2: randomUUID(),
    t3NonMember: randomUUID(),
    appT1: randomUUID(),
    appT2: randomUUID(),
    orgCustomRole: randomUUID(),
    uOwner: randomUUID(),
    uAdmin: randomUUID(),
    uWrite: randomUUID(),
    uRead: randomUUID(),
    uOrgCustom: randomUUID(),
    uPending: randomUUID(),
    uDisabled: randomUUID(),
    uRemoved: randomUUID(),
    sys: randomUUID(),
  };

  await client.query("SET session_replication_role = 'replica'");
  const sys = f.sys;
  await client.query('INSERT INTO auth.users(id) VALUES ($1)', [sys]);
  await client.query('INSERT INTO public.profile(id,name,email) VALUES ($1,$2,$3)', [
    sys,
    'sys',
    `sys-${suffix}@dual.test`,
  ]);
  for (const [tid, name] of [
    [f.t1, `t1-${suffix}`],
    [f.t2, `t2-${suffix}`],
    [f.t3NonMember, `t3-${suffix}`],
  ] as const) {
    await client.query(
      'INSERT INTO public.tenant(tenant_id,company_name,organization_name,created_by) VALUES ($1,$2,$3,$4)',
      [tid, 'co', name, sys],
    );
  }
  await client.query('INSERT INTO public.app(id,name,tenant_id,created_by) VALUES ($1,$2,$3,$4)', [
    f.appT1,
    `appT1-${suffix}`,
    f.t1,
    sys,
  ]);
  await client.query('INSERT INTO public.app(id,name,tenant_id,created_by) VALUES ($1,$2,$3,$4)', [
    f.appT2,
    `appT2-${suffix}`,
    f.t2,
    sys,
  ]);

  // An org custom role in T1 with a distinct, non-trivial permission subset, so
  // the custom-role branch of authorize() resolves a set different from any
  // built-in role.
  await client.query(
    'INSERT INTO public.custom_role(id,tenant_id,name,created_by) VALUES ($1,$2,$3,$4)',
    [f.orgCustomRole, f.t1, `dual-org-custom-${suffix}`, sys],
  );
  for (const p of ['app.read', 'trace.read', 'worker_run.read']) {
    await client.query(
      'INSERT INTO public.custom_role_permission(custom_role_id,permission) VALUES ($1,$2)',
      [f.orgCustomRole, p],
    );
  }

  const addMember = async (
    userId: string,
    tenantId: string,
    role: string,
    label: string,
    opts: { customRoleId?: string | null; status?: string } = {},
  ) => {
    await client.query('INSERT INTO auth.users(id) VALUES ($1) ON CONFLICT DO NOTHING', [userId]);
    await client.query(
      'INSERT INTO public.profile(id,name,email) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING',
      [userId, label, `${label}-${suffix}@dual.test`],
    );
    await client.query(
      `INSERT INTO public.membership(id,user_id,tenant_id,role,status,is_app_scoped,custom_role_id)
       VALUES ($1,$2,$3,$4,$5,false,$6)`,
      [randomUUID(), userId, tenantId, role, opts.status ?? 'active', opts.customRoleId ?? null],
    );
  };
  await addMember(f.uOwner, f.t1, 'owner', 'owner');
  await addMember(f.uAdmin, f.t1, 'admin', 'admin');
  await addMember(f.uAdmin, f.t2, 'read', 'admin'); // same user, read in T2
  await addMember(f.uWrite, f.t1, 'write', 'write');
  await addMember(f.uRead, f.t1, 'read', 'read');
  await addMember(f.uOrgCustom, f.t1, 'read', 'orgcustom', { customRoleId: f.orgCustomRole });
  // Non-permission-bearing memberships: a PENDING invite (status gate) and a
  // DISABLED member (role gate). Both must resolve to NO tenant under a header
  // and NO permissions under their claim — the two predicates authorize() and
  // resolve_header_tenant apply.
  await addMember(f.uPending, f.t1, 'admin', 'pending', { status: 'pending' });
  await addMember(f.uDisabled, f.t1, 'disabled', 'disabled');
  // Seeded as a real active member, then removed — the product's own removal
  // shape. The claim minted below still names T1; only the row is gone.
  await addMember(f.uRemoved, f.t1, 'admin', 'removed');
  await client.query("SET session_replication_role = 'origin'");

  fx = f;
}, 60000);

afterAll(async () => {
  if (!client) return;
  await client.query("SET session_replication_role = 'replica'");
  await client.query('DELETE FROM public.tenant WHERE tenant_id = ANY($1)', [
    [fx.t1, fx.t2, fx.t3NonMember],
  ]);
  await client.query('DELETE FROM public.profile WHERE email LIKE $1', ['%@dual.test']);
  await client.query('DELETE FROM auth.users WHERE id = ANY($1)', [
    [
      fx.uOwner,
      fx.uAdmin,
      fx.uWrite,
      fx.uRead,
      fx.uOrgCustom,
      fx.uPending,
      fx.uDisabled,
      fx.uRemoved,
      fx.sys,
    ],
  ]);
  await client.query("SET session_replication_role = 'origin'");
  await client.end();
});

describe('dual-source tenancy', () => {
  describe('claim/header equivalence (same tenant resolves identically)', () => {
    const roles: Array<keyof Fixture> = ['uOwner', 'uAdmin', 'uWrite', 'uRead', 'uOrgCustom'];
    for (const who of roles) {
      it(`${who} in T1: header-sourced == claim-sourced`, async () => {
        const userId = fx[who];
        const claims = await mintClaims(userId, fx.t1);

        const viaClaim = await inRequest({ claims }, async () => ({
          org: await authorizeVector(),
          app: await appAuthVector(fx.appT1),
          set: await effectiveSet(fx.appT1),
          appsAppRead: await authorizedApps('app.read'),
          appsAppDelete: await authorizedApps('app.delete'),
        }));
        const viaHeader = await inRequest({ claims, header: fx.t1 }, async () => ({
          org: await authorizeVector(),
          app: await appAuthVector(fx.appT1),
          set: await effectiveSet(fx.appT1),
          appsAppRead: await authorizedApps('app.read'),
          appsAppDelete: await authorizedApps('app.delete'),
        }));

        // Whole-vector equality: a divergence on any permission or scope fails.
        expect(viaHeader).toEqual(viaClaim);
        // Non-vacuous: the actor actually resolves SOMETHING (not two empty maps).
        expect(Object.values(viaClaim.org).some(Boolean)).toBe(true);
      });
    }
  });

  describe('header spoof fails closed (never falls back to the claim)', () => {
    it('non-member-tenant header → tenant_id NULL, resolver + authorized_app_ids empty', async () => {
      const claims = await mintClaims(fx.uAdmin, fx.t1);
      const out = await inRequest({ claims, header: fx.t3NonMember }, async () => ({
        tenant: (await client.query<{ t: string | null }>('SELECT public.tenant_id() AS t')).rows[0]!
          .t,
        org: await authorizeVector(),
        set: await effectiveSet(fx.appT1),
        apps: await authorizedApps('app.read'),
      }));
      expect(out.tenant).toBeNull();
      expect(Object.values(out.org).every((b) => b === false)).toBe(true);
      expect(out.set).toEqual([]);
      expect(out.apps).toEqual([]);
    });

    it('malformed header → same fail-closed NULL', async () => {
      const claims = await mintClaims(fx.uAdmin, fx.t1);
      const out = await inRequest({ claims, header: 'not-a-uuid' }, async () => ({
        tenant: (await client.query<{ t: string | null }>('SELECT public.tenant_id() AS t')).rows[0]!
          .t,
        canReadApp: (
          await client.query<{ b: boolean }>(`SELECT private.authorize('app.read') AS b`)
        ).rows[0]!.b,
      }));
      expect(out.tenant).toBeNull();
      expect(out.canReadApp).toBe(false);
    });

    it('set_tenant_id INSERT under a spoofed header fails — no silent claim-stamp', async () => {
      const claims = await mintClaims(fx.uOwner, fx.t1);

      // Valid header (member of T1): the trigger stamps T1 and the insert lands.
      const stampedTenant = await inRequest(
        { claims, header: fx.t1, asRole: 'authenticated' },
        async () => {
          const r = await client.query<{ tenant_id: string }>(
            `INSERT INTO public.custom_role(name) VALUES ($1) RETURNING tenant_id`,
            [`dual-ok-${randomUUID().slice(0, 8)}`],
          );
          return r.rows[0]!.tenant_id;
        },
      );
      expect(stampedTenant).toBe(fx.t1);

      // Spoofed header (non-member T3): tenant_id() is NULL, so the insert must
      // fail — it must NOT fall back to stamping the claim tenant (T1).
      await expect(
        inRequest({ claims, header: fx.t3NonMember, asRole: 'authenticated' }, async () => {
          await client.query(`INSERT INTO public.custom_role(name) VALUES ($1)`, [
            `dual-spoof-${randomUUID().slice(0, 8)}`,
          ]);
        }),
      ).rejects.toThrow();
    });
  });

  describe('non-authenticated JWT role never validates its tenant claim (ELSE branch)', () => {
    // public.tenant_id()'s ELSE branch (neither header nor role='authenticated')
    // trusts app_metadata.tenant_id verbatim. service_role and the gateway role
    // need exactly that: their JWTs carry no membership row, so routing them
    // through resolve_member_tenant would resolve every service/gateway request
    // to NULL and stop ingest (see H1 above). anon shares that same branch by
    // construction, not by a separate carve-out — there is no anon-specific
    // predicate here.
    //
    // This is safe against a real request only because Supabase's anon key is a
    // single static, pre-signed JWT that never carries a populated
    // app_metadata.tenant_id — that is an external fact about what the auth
    // server issues, not something this function validates. This test pins the
    // actual behavior of the ELSE branch so a future reader does not mistake it
    // for validated: raw GUC injection (as below) is not a real request path,
    // but the SQL predicate alone does not distinguish it from one.
    it('anon role with a populated tenant claim: tenant_id() trusts it, unvalidated', async () => {
      const claims = JSON.stringify({
        role: 'anon',
        app_metadata: { tenant_id: fx.t1 },
      });
      const tenant = await inRequest(
        { claims },
        async () =>
          (await client.query<{ t: string | null }>('SELECT public.tenant_id() AS t')).rows[0]!.t,
      );
      expect(tenant).toBe(fx.t1);
    });
  });

  describe('non-permission-bearing memberships deny (state gate: status + role)', () => {
    // A pending invite (status <> 'active') and a disabled member (role =
    // 'disabled') hold a membership row but no permissions. BOTH arms of
    // public.tenant_id() now apply the same state gate through
    // private.resolve_member_tenant — status = 'active' AND role <> 'disabled' —
    // so a header AND a claim for their tenant both resolve to NULL.
    //
    // The claim arm carries the weight here: a membership row can go away while
    // the minted JWT keeps naming its tenant, and the header is optional, so the
    // claim has to stand on its own. It is also the only arm Realtime and
    // Storage ever take — they never send the header.
    //
    // Case (b) remains the pin on `status = 'active'` in authorize(): drop it and
    // the invited admin role leaks in.
    const cases: Array<{ who: 'uPending' | 'uDisabled'; label: string }> = [
      { who: 'uPending', label: 'pending invite (status gate)' },
      { who: 'uDisabled', label: 'disabled member (role gate)' },
    ];
    for (const c of cases) {
      it(`${c.label}: header AND claim → tenant_id NULL, no permissions`, async () => {
        const claims = await mintClaims(fx[c.who], fx.t1);

        // (a) A header for their own tenant is rejected — they are not an active
        // member — so the request resolves to no tenant.
        const headerTenant = await inRequest(
          { claims, header: fx.t1 },
          async () =>
            (await client.query<{ t: string | null }>('SELECT public.tenant_id() AS t')).rows[0]!.t,
        );
        expect(headerTenant).toBeNull();

        // (b) Under their claim, with NO header, the tenant no longer resolves
        // either — and the org boolean grants nothing and the resolver is empty.
        const out = await inRequest({ claims }, async () => ({
          tenant: (await client.query<{ t: string | null }>('SELECT public.tenant_id() AS t'))
            .rows[0]!.t,
          org: await authorizeVector(),
          set: await effectiveSet(fx.appT1),
          apps: await authorizedApps('app.read'),
        }));
        expect(out.tenant).toBeNull();
        expect(Object.values(out.org).every((b) => b === false)).toBe(true);
        expect(out.set).toEqual([]);
        expect(out.apps).toEqual([]);
      });
    }

    // The case the claim-arm validation exists for: no membership row at all,
    // but a JWT still carrying the tenant.
    it('removed member (no membership row): claim alone resolves to NULL', async () => {
      // Mint FIRST, while the membership is still live — this is a legitimately
      // issued token, which is the point: removal cannot revoke it, and a plain
      // refresh-token grant re-mints one carrying the same tenant. Then remove the
      // member exactly as remove_member_transaction does and re-resolve.
      const claims = await mintClaims(fx.uRemoved, fx.t1);

      const out = await inRequest({ claims }, async () => {
        await client.query('DELETE FROM public.membership WHERE user_id = $1 AND tenant_id = $2', [
          fx.uRemoved,
          fx.t1,
        ]);
        return {
          tenant: (await client.query<{ t: string | null }>('SELECT public.tenant_id() AS t'))
            .rows[0]!.t,
          org: await authorizeVector(),
          apps: await authorizedApps('app.read'),
        };
      });

      expect(out.tenant).toBeNull();
      expect(Object.values(out.org).every((b) => b === false)).toBe(true);
      expect(out.apps).toEqual([]);
    });
  });

  describe('cross-tenant role (org role follows the header tenant, not the claim)', () => {
    it('admin in T1 / read in T2: a T2 header yields T2 read answers, not T1 admin', async () => {
      const claims = await mintClaims(fx.uAdmin, fx.t1); // minted for T1 (admin)

      const t1 = await inRequest({ claims }, async () => ({
        appDelete: (await client.query<{ b: boolean }>(`SELECT private.authorize('app.delete') AS b`))
          .rows[0]!.b,
        setAppT2: await effectiveSet(fx.appT2),
      }));
      const t2 = await inRequest({ claims, header: fx.t2 }, async () => ({
        appDelete: (await client.query<{ b: boolean }>(`SELECT private.authorize('app.delete') AS b`))
          .rows[0]!.b,
        appRead: (await client.query<{ b: boolean }>(`SELECT private.authorize('app.read') AS b`))
          .rows[0]!.b,
        setAppT2: await effectiveSet(fx.appT2),
      }));

      // T1 context (claim): admin holds app.delete; appT2 is a FOREIGN app (T2),
      // so it is out of T1's resolver domain and yields nothing.
      expect(t1.appDelete).toBe(true);
      expect(t1.setAppT2).toEqual([]);

      // T2 header: the actor is only a READER in T2 — app.delete is denied, and
      // appT2 now resolves to T2's read set (org fallback, non-empty).
      expect(t2.appDelete).toBe(false);
      expect(t2.appRead).toBe(true);
      expect(t2.setAppT2.length).toBeGreaterThan(0);

      // The read set the header produced is exactly the built-in read org set —
      // proving the role came from the T2 membership, not the T1 admin claim.
      const readOrg = (
        await client.query<{ perm: string }>(
          `SELECT p::text AS perm FROM private.get_org_permission_set(NULL, 'read', $1::uuid) AS p ORDER BY p::text COLLATE "C"`,
          [fx.t2],
        )
      ).rows.map((x) => x.perm);
      expect(t2.setAppT2).toEqual(readOrg);
    });
  });
});
