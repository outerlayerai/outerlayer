/**
 * Tenant resolution at the database boundary: request-header scoping on a
 * tenant_id()-scoped table (`app`), membership-derived scoping on
 * `notification`, invite pending-state isolation, and the exact query shape
 * `getAppByName` runs.
 *
 * Evaluated via raw pg — mints claims through the real
 * custom_access_token_hook and pins `request.headers` / `request.jwt.claims`
 * directly, mirroring `dual-source-tenancy.test.ts`.
 */

import { randomUUID } from 'crypto';
import { Client } from 'pg';
import { describe, it, beforeAll, afterAll, expect } from 'vitest';

const DATABASE_URL =
  process.env.DATABASE_URL || 'postgresql://postgres:postgres@127.0.0.1:54332/postgres';

let client: Client;

interface Fixture {
  tenantA: string;
  tenantB: string;
  appA: string;
  appB: string;
  appBName: string;
  user: string;
  sys: string;
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

async function inRequest<T>(
  opts: { claims: string; header?: string },
  body: () => Promise<T>,
): Promise<T> {
  await client.query('BEGIN');
  try {
    await client.query('SELECT set_config($1,$2,true)', ['request.jwt.claims', opts.claims]);
    if (opts.header !== undefined) {
      await client.query('SELECT set_config($1,$2,true)', [
        'request.headers',
        JSON.stringify({ 'x-tenant-id': opts.header }),
      ]);
    }
    await client.query("SET LOCAL ROLE authenticated");
    return await body();
  } finally {
    await client.query('ROLLBACK');
  }
}

beforeAll(async () => {
  client = new Client({ connectionString: DATABASE_URL });
  await client.connect();

  const suffix = randomUUID().slice(0, 8);
  const f: Fixture = {
    tenantA: randomUUID(),
    tenantB: randomUUID(),
    appA: randomUUID(),
    appB: randomUUID(),
    appBName: `appB-${suffix}`,
    user: randomUUID(),
    sys: randomUUID(),
  };

  await client.query("SET session_replication_role = 'replica'");
  await client.query('INSERT INTO auth.users(id) VALUES ($1)', [f.sys]);
  await client.query('INSERT INTO public.profile(id,name,email) VALUES ($1,$2,$3)', [
    f.sys,
    'sys',
    `sys-${suffix}@claim-retirement.test`,
  ]);
  for (const [tid, name] of [
    [f.tenantA, `cr-a-${suffix}`],
    [f.tenantB, `cr-b-${suffix}`],
  ] as const) {
    await client.query(
      'INSERT INTO public.tenant(tenant_id,company_name,organization_name,created_by) VALUES ($1,$2,$3,$4)',
      [tid, 'co', name, f.sys],
    );
  }
  await client.query('INSERT INTO public.app(id,name,tenant_id,created_by) VALUES ($1,$2,$3,$4)', [
    f.appA,
    `appA-${suffix}`,
    f.tenantA,
    f.sys,
  ]);
  await client.query('INSERT INTO public.app(id,name,tenant_id,created_by) VALUES ($1,$2,$3,$4)', [
    f.appB,
    `appB-${suffix}`,
    f.tenantB,
    f.sys,
  ]);

  await client.query('INSERT INTO auth.users(id) VALUES ($1)', [f.user]);
  await client.query('INSERT INTO public.profile(id,name,email) VALUES ($1,$2,$3)', [
    f.user,
    'user',
    `user-${suffix}@claim-retirement.test`,
  ]);
  // Active membership in A only — the fixture caller belongs to A and
  // never to B.
  await client.query(
    `INSERT INTO public.membership(id,user_id,tenant_id,role,status,is_app_scoped)
     VALUES ($1,$2,$3,'owner','active',false)`,
    [randomUUID(), f.user, f.tenantA],
  );

  await client.query(
    'INSERT INTO public.notification(id,tenant_id,message) VALUES ($1,$2,$3),($4,$5,$6)',
    [randomUUID(), f.tenantA, 'in A', randomUUID(), f.tenantB, 'in B'],
  );
  await client.query("SET session_replication_role = 'origin'");

  fx = f;
}, 60000);

afterAll(async () => {
  if (!client) return;
  await client.query("SET session_replication_role = 'replica'");
  await client.query('DELETE FROM public.notification WHERE tenant_id = ANY($1)', [
    [fx.tenantA, fx.tenantB],
  ]);
  await client.query('DELETE FROM public.tenant WHERE tenant_id = ANY($1)', [
    [fx.tenantA, fx.tenantB],
  ]);
  await client.query('DELETE FROM public.profile WHERE email LIKE $1', [
    '%@claim-retirement.test',
  ]);
  await client.query('DELETE FROM auth.users WHERE id = ANY($1)', [[fx.user, fx.sys]]);
  await client.query("SET session_replication_role = 'origin'");
  await client.end();
});

describe('header precedence on a tenant_id()-scoped table', () => {
  it('a header naming A resolves A\'s app, even though the claim names B', async () => {
    const claims = await mintClaims(fx.user, fx.tenantB);

    const ids = await inRequest({ claims, header: fx.tenantA }, async () => {
      const r = await client.query<{ id: string }>('SELECT id::text FROM public.app ORDER BY id::text');
      return r.rows.map((x) => x.id);
    });

    expect(ids).toEqual([fx.appA]);
  });

  it('a header naming a tenant the caller is not an active member of resolves nothing, even though the claim names a real membership', async () => {
    const claims = await mintClaims(fx.user, fx.tenantA);

    const ids = await inRequest({ claims, header: fx.tenantB }, async () => {
      const r = await client.query<{ id: string }>('SELECT id::text FROM public.app ORDER BY id::text');
      return r.rows.map((x) => x.id);
    });

    expect(ids).toEqual([]);
  });
});

describe('headerless requests on notification', () => {
  it('a headerless request with the claim naming a non-member tenant sees no notifications from that tenant', async () => {
    const claims = await mintClaims(fx.user, fx.tenantB);

    const ids = await inRequest({ claims }, async () => {
      const r = await client.query<{ id: string; tenant_id: string }>(
        'SELECT id::text, tenant_id::text FROM public.notification ORDER BY id::text',
      );
      return r.rows;
    });

    // Positional, not .every()/.some(): those pass vacuously on an empty
    // result, which is exactly what a dropped predicate in
    // member_tenant_ids() would produce.
    expect(ids.map((row) => row.tenant_id)).toEqual([fx.tenantA]);
  });
});

describe('inviting a member to another tenant does not move their active tenant', () => {
  it('a pending invite to B leaves raw_app_meta_data, last_active_tenant_id, and headerless visibility untouched', async () => {
    // Seed the pre-invite state: user active in A, with a claim and a
    // preference already pointing at A.
    await client.query(
      `UPDATE auth.users SET raw_app_meta_data = COALESCE(raw_app_meta_data, '{}'::jsonb) || jsonb_build_object('tenant_id', $2::text) WHERE id = $1`,
      [fx.user, fx.tenantA],
    );
    await client.query('UPDATE public.profile SET last_active_tenant_id = $2 WHERE id = $1', [
      fx.user,
      fx.tenantA,
    ]);

    const before = await client.query<{
      last_active_tenant_id: string | null;
      claim_tenant_id: string | null;
    }>(
      `SELECT p.last_active_tenant_id::text, u.raw_app_meta_data->>'tenant_id' AS claim_tenant_id
       FROM public.profile p JOIN auth.users u ON u.id = p.id WHERE p.id = $1`,
      [fx.user],
    );
    expect(before.rows[0]).toEqual({ last_active_tenant_id: fx.tenantA, claim_tenant_id: fx.tenantA });

    await client.query(
      `SELECT public.invite_existing_user_transaction($1, $2, $3, 'read', now(), now() + interval '7 days')`,
      [fx.user, fx.tenantB, fx.sys],
    );

    const after = await client.query<{
      last_active_tenant_id: string | null;
      claim_tenant_id: string | null;
    }>(
      `SELECT p.last_active_tenant_id::text, u.raw_app_meta_data->>'tenant_id' AS claim_tenant_id
       FROM public.profile p JOIN auth.users u ON u.id = p.id WHERE p.id = $1`,
      [fx.user],
    );
    expect(after.rows[0]).toEqual(before.rows[0]);

    // The invite is 'pending', not 'active' — member_tenant_ids() must
    // still admit only A, never B, until acceptance.
    const claims = await mintClaims(fx.user, fx.tenantB);
    const ids = await inRequest({ claims }, async () => {
      const r = await client.query<{ tenant_id: string }>(
        'SELECT tenant_id::text FROM public.notification',
      );
      return r.rows.map((row) => row.tenant_id);
    });
    // Positional, not .every(): passes vacuously on [], which is exactly
    // what a dropped predicate in member_tenant_ids() would produce.
    expect(ids).toEqual([fx.tenantA]);
  });
});

describe('a cross-tenant app is unreadable at the getAppByName query shape', () => {
  // `getAppByName` (src/utils/get-app-by-name.ts) runs exactly this query
  // shape — SELECT ... FROM app WHERE name = $1 .single() — under a
  // request-tenant-scoped client; this proves the row-read itself, not the
  // mocked guard.
  it('a request scoped to A cannot read B\'s app by name, even under a header naming A', async () => {
    const claims = await mintClaims(fx.user, fx.tenantA);

    const rows = await inRequest({ claims, header: fx.tenantA }, async () => {
      const r = await client.query<{ id: string }>(
        'SELECT id::text FROM public.app WHERE name = $1',
        [fx.appBName],
      );
      return r.rows;
    });

    expect(rows).toEqual([]);
  });
});
