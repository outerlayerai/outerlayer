/**
 * `private.member_tenant_ids()` / `private.member_app_ids()` — the
 * membership-derived scope behind `notification` and `context_sync_event`'s
 * realtime-backed policies. They answer for the caller's whole active
 * tenant/app set; the client filters to the URL org.
 *
 * Evaluated against the real functions and policies via raw pg — the
 * private.* bodies are SECURITY DEFINER and unexposed, so they cannot be
 * reached through supabase-js, and the RLS-scoped SELECT proves what a
 * headerless realtime subscription actually sees, not just what the resolver
 * returns.
 */

import { randomUUID } from 'crypto';
import { Client } from 'pg';
import { describe, it, beforeAll, afterAll, expect } from 'vitest';

const DATABASE_URL =
  process.env.DATABASE_URL || 'postgresql://postgres:postgres@127.0.0.1:54332/postgres';

let client: Client;

interface Fixture {
  tA: string; // active membership, owner
  tB: string; // active membership, app-scoped read with one app_member_role override
  tC: string; // disabled membership — must be excluded
  tD: string; // pending membership — must be excluded
  tNonMember: string; // no membership row at all — must be excluded
  appA1: string;
  appA2: string;
  appB1: string; // app-scoped user has an explicit context.read role here
  appB2: string; // app-scoped user has NO row here — must be excluded
  user: string;
  sys: string;
}

let fx: Fixture;

/** The claims the auth server would mint for (user, tenant), via the real hook. */
async function mintClaims(userId: string, tenantId: string | null): Promise<string> {
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

/** Run body with request.jwt.claims pinned (no header — the realtime shape), then roll back. */
async function asRealtimeRequest<T>(claims: string, body: () => Promise<T>): Promise<T> {
  await client.query('BEGIN');
  try {
    await client.query('SELECT set_config($1,$2,true)', ['request.jwt.claims', claims]);
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
    tA: randomUUID(),
    tB: randomUUID(),
    tC: randomUUID(),
    tD: randomUUID(),
    tNonMember: randomUUID(),
    appA1: randomUUID(),
    appA2: randomUUID(),
    appB1: randomUUID(),
    appB2: randomUUID(),
    user: randomUUID(),
    sys: randomUUID(),
  };

  await client.query("SET session_replication_role = 'replica'");
  await client.query('INSERT INTO auth.users(id) VALUES ($1)', [f.sys]);
  await client.query('INSERT INTO public.profile(id,name,email) VALUES ($1,$2,$3)', [
    f.sys,
    'sys',
    `sys-${suffix}@member-tenant-ids.test`,
  ]);
  for (const [tid, name] of [
    [f.tA, `mti-a-${suffix}`],
    [f.tB, `mti-b-${suffix}`],
    [f.tC, `mti-c-${suffix}`],
    [f.tD, `mti-d-${suffix}`],
    [f.tNonMember, `mti-nonmember-${suffix}`],
  ] as const) {
    await client.query(
      'INSERT INTO public.tenant(tenant_id,company_name,organization_name,created_by) VALUES ($1,$2,$3,$4)',
      [tid, 'co', name, f.sys],
    );
  }
  for (const [appId, tid, name] of [
    [f.appA1, f.tA, `appA1-${suffix}`],
    [f.appA2, f.tA, `appA2-${suffix}`],
    [f.appB1, f.tB, `appB1-${suffix}`],
    [f.appB2, f.tB, `appB2-${suffix}`],
  ] as const) {
    await client.query('INSERT INTO public.app(id,name,tenant_id,created_by) VALUES ($1,$2,$3,$4)', [
      appId,
      name,
      tid,
      f.sys,
    ]);
  }

  await client.query('INSERT INTO auth.users(id) VALUES ($1)', [f.user]);
  await client.query('INSERT INTO public.profile(id,name,email) VALUES ($1,$2,$3)', [
    f.user,
    'member',
    `member-${suffix}@member-tenant-ids.test`,
  ]);

  // Owner in A: org-level context.read applies to every app in A.
  await client.query(
    `INSERT INTO public.membership(id,user_id,tenant_id,role,status,is_app_scoped)
     VALUES ($1,$2,$3,'owner','active',false)`,
    [randomUUID(), f.user, f.tA],
  );
  // App-scoped read in B, restricted to appB1 via an explicit app_member_role row.
  const membershipBId = randomUUID();
  await client.query(
    `INSERT INTO public.membership(id,user_id,tenant_id,role,status,is_app_scoped)
     VALUES ($1,$2,$3,'read','active',true)`,
    [membershipBId, f.user, f.tB],
  );
  await client.query(
    `INSERT INTO public.app_member_role(id,membership_id,app_id,tenant_id,role)
     VALUES ($1,$2,$3,$4,'read')`,
    [randomUUID(), membershipBId, f.appB1, f.tB],
  );
  // Disabled membership in C — excluded from every set.
  await client.query(
    `INSERT INTO public.membership(id,user_id,tenant_id,role,status,is_app_scoped)
     VALUES ($1,$2,$3,'disabled','active',false)`,
    [randomUUID(), f.user, f.tC],
  );
  // Pending (not yet accepted) membership in D — excluded from every set.
  await client.query(
    `INSERT INTO public.membership(id,user_id,tenant_id,role,status,is_app_scoped)
     VALUES ($1,$2,$3,'admin','pending',false)`,
    [randomUUID(), f.user, f.tD],
  );
  await client.query("SET session_replication_role = 'origin'");

  fx = f;
}, 60000);

afterAll(async () => {
  if (!client) return;
  await client.query("SET session_replication_role = 'replica'");
  await client.query('DELETE FROM public.tenant WHERE tenant_id = ANY($1)', [
    [fx.tA, fx.tB, fx.tC, fx.tD, fx.tNonMember],
  ]);
  await client.query('DELETE FROM public.profile WHERE email LIKE $1', [
    '%@member-tenant-ids.test',
  ]);
  await client.query('DELETE FROM auth.users WHERE id = ANY($1)', [[fx.user, fx.sys]]);
  await client.query("SET session_replication_role = 'origin'");
  await client.end();
});

describe('private.member_tenant_ids()', () => {
  it('resolves exactly the caller active, non-disabled tenants — not pending, not disabled, not non-member', async () => {
    const claims = await mintClaims(fx.user, fx.tA);

    const ids = await asRealtimeRequest(claims, async () => {
      const r = await client.query<{ id: string }>(
        'SELECT id::text FROM private.member_tenant_ids() AS id ORDER BY id::text',
      );
      return r.rows.map((x) => x.id);
    });

    expect(ids).toEqual([fx.tA, fx.tB].sort());
  });
});

describe('notification — realtime-backed, membership-derived visibility', () => {
  let notifA: string;
  let notifB: string;
  let notifC: string;
  let notifNonMember: string;

  beforeAll(async () => {
    await client.query("SET session_replication_role = 'replica'");
    notifA = randomUUID();
    notifB = randomUUID();
    notifC = randomUUID();
    notifNonMember = randomUUID();
    await client.query(
      'INSERT INTO public.notification(id,tenant_id,message) VALUES ($1,$2,$3),($4,$5,$6),($7,$8,$9),($10,$11,$12)',
      [
        notifA, fx.tA, 'in A',
        notifB, fx.tB, 'in B',
        notifC, fx.tC, 'in C (disabled membership)',
        notifNonMember, fx.tNonMember, 'in a tenant the caller never joined',
      ],
    );
    await client.query("SET session_replication_role = 'origin'");
  });

  afterAll(async () => {
    await client.query("SET session_replication_role = 'replica'");
    await client.query('DELETE FROM public.notification WHERE id = ANY($1)', [
      [notifA, notifB, notifC, notifNonMember],
    ]);
    await client.query("SET session_replication_role = 'origin'");
  });

  it('admits notifications from every active-membership tenant, positionally, and none from disabled/non-member tenants', async () => {
    const claims = await mintClaims(fx.user, fx.tA);

    const ids = await asRealtimeRequest(claims, async () => {
      const r = await client.query<{ id: string }>(
        'SELECT id::text FROM public.notification ORDER BY id::text',
      );
      return r.rows.map((x) => x.id);
    });

    expect(ids).toEqual([notifA, notifB].sort());
  });

  it('yields nothing extra when the claim names a non-member tenant', async () => {
    const claims = await mintClaims(fx.user, fx.tNonMember);

    const ids = await asRealtimeRequest(claims, async () => {
      const r = await client.query<{ id: string }>(
        'SELECT id::text FROM public.notification ORDER BY id::text',
      );
      return r.rows.map((x) => x.id);
    });

    expect(ids).toEqual([notifA, notifB].sort());
  });

  describe('member writes are column-scoped to read', () => {
    it('marks a notification read', async () => {
      const claims = await mintClaims(fx.user, fx.tA);

      const updated = await asRealtimeRequest(claims, async () => {
        const r = await client.query(
          'UPDATE public.notification SET read = true WHERE id = $1',
          [notifA],
        );
        return r.rowCount;
      });

      expect(updated).toBe(1);
    });

    it('rejects updating tenant_id, even to another tenant the caller belongs to', async () => {
      const claims = await mintClaims(fx.user, fx.tA);

      await expect(
        asRealtimeRequest(claims, () =>
          client.query('UPDATE public.notification SET tenant_id = $2 WHERE id = $1', [
            notifA,
            fx.tB,
          ]),
        ),
      ).rejects.toMatchObject({ code: '42501' });
    });

    it('rejects updating message', async () => {
      const claims = await mintClaims(fx.user, fx.tA);

      await expect(
        asRealtimeRequest(claims, () =>
          client.query("UPDATE public.notification SET message = 'edited' WHERE id = $1", [
            notifA,
          ]),
        ),
      ).rejects.toMatchObject({ code: '42501' });
    });
  });
});

describe('context_sync_event — realtime-backed, membership+app-permission-derived visibility', () => {
  let eventA1: string;
  let eventA2: string;
  let eventB1: string; // app-scoped member has an explicit context.read role here
  let eventB2: string; // app-scoped member has none here — must be excluded

  beforeAll(async () => {
    await client.query("SET session_replication_role = 'replica'");
    eventA1 = randomUUID();
    eventA2 = randomUUID();
    eventB1 = randomUUID();
    eventB2 = randomUUID();
    for (const [id, appId, tenantId] of [
      [eventA1, fx.appA1, fx.tA],
      [eventA2, fx.appA2, fx.tA],
      [eventB1, fx.appB1, fx.tB],
      [eventB2, fx.appB2, fx.tB],
    ] as const) {
      await client.query(
        `INSERT INTO public.context_sync_event(id,app_id,tenant_id,branch,commit_sha,trigger,status)
         VALUES ($1,$2,$3,'main','deadbeef','push','synced')`,
        [id, appId, tenantId],
      );
    }
    await client.query("SET session_replication_role = 'origin'");
  });

  afterAll(async () => {
    await client.query("SET session_replication_role = 'replica'");
    await client.query('DELETE FROM public.context_sync_event WHERE id = ANY($1)', [
      [eventA1, eventA2, eventB1, eventB2],
    ]);
    await client.query("SET session_replication_role = 'origin'");
  });

  it('admits every app-A sync event (owner) and only the overridden app-B event (app-scoped member)', async () => {
    const claims = await mintClaims(fx.user, fx.tA);

    const ids = await asRealtimeRequest(claims, async () => {
      const r = await client.query<{ id: string }>(
        'SELECT id::text FROM public.context_sync_event ORDER BY id::text',
      );
      return r.rows.map((x) => x.id);
    });

    expect(ids).toEqual([eventA1, eventA2, eventB1].sort());
  });
});
