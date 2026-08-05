/**
 * Authz Equivalence Matrix — golden baseline harness
 *
 * The dashboard-authz sibling of gateway-rls-matrix.test.ts. Where that suite
 * pins gateway-role RLS isolation, this one pins the SQL authorization resolver
 * itself: `private.authorize(perm)` (org boolean), `private.app_authorize(perm,
 * app)` (per-app boolean), and the set resolvers
 * `private.effective_app_permissions(app)` /
 * `private.get_org_permission_set(...)`.
 *
 * It is an EQUIVALENCE NET, not a correctness oracle. It snapshots the CURRENT
 * resolver behavior verbatim into a committed golden file and fails on any
 * divergence. Later phases that consolidate the resolver must keep it green
 * (old == new). A surprising baseline value is recorded and flagged for review,
 * never "fixed" here.
 *
 * Mechanism: fixtures are seeded via raw pg as the postgres superuser (the
 * `private.*` bodies are SECURITY DEFINER and unexposed over PostgREST, so they
 * cannot be reached through supabase-js). Per actor, we mint the JWT claims by
 * calling the real `public.custom_access_token_hook` — so the GUC reflects the
 * exact token shape the auth server produces today — pin them into
 * `request.jwt.claims` inside a transaction, and evaluate the matrix.
 *
 * Regenerate the golden after an INTENTIONAL, reviewed behavior change:
 *   UPDATE_AUTHZ_GOLDEN=1 vitest run src/tests/authz-equivalence-matrix.test.ts
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { randomUUID } from 'crypto';
import { Client } from 'pg';
import { describe, it, beforeAll, afterAll, expect } from 'vitest';
import { APP_PERMISSIONS } from '@repo/db-types/permissions';

const DATABASE_URL =
  process.env.DATABASE_URL || 'postgresql://postgres:postgres@127.0.0.1:54332/postgres';

const GOLDEN_PATH = join(__dirname, 'authz-equivalence-golden.txt');
const UPDATE_GOLDEN = process.env.UPDATE_AUTHZ_GOLDEN === '1';

// ---------------------------------------------------------------------------
// Fixture definition — every actor shape × permission × app scope.
// Labels are stable; the seeded UUIDs are random per run and never appear in
// the golden, so the output is byte-reproducible across runs and across any
// two DBs built from the same migrations.
// ---------------------------------------------------------------------------

// Custom-role permission subsets. Deliberately non-trivial and DISTINCT so the
// org-custom vs app-custom-override paths produce different sets.
const ORG_CUSTOM_PERMS = [
  'app.read',
  'trace.read',
  'dashboard.read',
  'worker_run.read',
  'environment.read',
] as const;

const APP_CUSTOM_PERMS = ['app.read', 'worker_run.insert', 'environment.promote'] as const;

interface ActorSpec {
  label: string;
  /** membership.role, or null when the actor has NO membership in the home tenant.
   *  Always a real built-in; a custom role is active via custom_role_id, never a
   *  'custom' role sentinel. */
  role: 'owner' | 'admin' | 'write' | 'read' | 'disabled' | null;
  /** true → membership.custom_role_id points at the org custom role. */
  orgCustom?: boolean;
  /** membership.is_app_scoped. */
  appScoped?: boolean;
  /** platform_user_role row minted (platform_role claim present). */
  platformAdmin?: boolean;
  /** false → no membership row at all (non-member / platform-only). */
  member: boolean;
  /** Human note surfaced in the golden header for silent-escalation review. */
  note?: string;
}

const ACTORS: ActorSpec[] = [
  { label: 'owner', role: 'owner', member: true },
  { label: 'admin', role: 'admin', member: true },
  { label: 'write', role: 'write', member: true },
  { label: 'read', role: 'read', member: true },
  { label: 'disabled', role: 'disabled', member: true },
  { label: 'org_custom', role: 'read', orgCustom: true, member: true },
  { label: 'app_scoped_read', role: 'read', appScoped: true, member: true },
  { label: 'platform_admin', role: null, platformAdmin: true, member: false },
  { label: 'non_member', role: null, member: false },
];

// App scopes evaluated for every app_authorize / set call, in golden column order.
const SCOPES = ['override_builtin', 'override_custom', 'org_fallback', 'other_tenant'] as const;
type Scope = (typeof SCOPES)[number];

// (actor, scope) combos that are the silent-escalation cases the program cares
// about — an org-admin whose per-app override RESTRICTS it below its org role.
// Flagged in the golden header + asserted in the anomaly report, never altered.
const DOWNWARD_OVERRIDES: Array<{ actor: string; scope: Scope; note: string }> = [
  {
    actor: 'admin',
    scope: 'override_builtin',
    note: 'org-admin restricted to a built-in app-read override on one app',
  },
  {
    actor: 'admin',
    scope: 'override_custom',
    note: 'org-admin restricted to an app-scoped custom-role subset on one app',
  },
];

// ---------------------------------------------------------------------------
// Seeded-fixture handles (resolved in beforeAll)
// ---------------------------------------------------------------------------

interface SeededActor extends ActorSpec {
  userId: string;
}

interface Fixture {
  homeTenantId: string;
  otherTenantId: string;
  orgCustomRoleId: string;
  appCustomRoleId: string;
  apps: Record<Scope, string>;
  actors: SeededActor[];
}

let client: Client;
let fixture: Fixture;

async function seedFixture(): Promise<Fixture> {
  const homeTenantId = randomUUID();
  const otherTenantId = randomUUID();
  const orgCustomRoleId = randomUUID();
  const appCustomRoleId = randomUUID();
  const suffix = randomUUID().slice(0, 8);

  const apps: Record<Scope, string> = {
    override_builtin: randomUUID(),
    override_custom: randomUUID(),
    org_fallback: randomUUID(),
    other_tenant: randomUUID(),
  };

  const actors: SeededActor[] = ACTORS.map((a) => ({ ...a, userId: randomUUID() }));

  // Disable triggers during seeding so set_tenant_id / default-env seeding
  // cannot rewrite the exact production-shaped rows we set.
  await client.query("SET session_replication_role = 'replica'");

  // Two tenants + a system owner user for created_by FKs.
  const sysOwner = randomUUID();
  await client.query('INSERT INTO auth.users(id) VALUES ($1)', [sysOwner]);
  await client.query('INSERT INTO public.profile(id, name, email) VALUES ($1,$2,$3)', [
    sysOwner,
    'sys-owner',
    `sys-${suffix}@authz-equiv.test`,
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

  // Custom roles + their permission subsets.
  await client.query(
    'INSERT INTO public.custom_role(id, tenant_id, name, created_by) VALUES ($1,$2,$3,$4)',
    [orgCustomRoleId, homeTenantId, `equiv-org-custom-${suffix}`, sysOwner],
  );
  await client.query(
    'INSERT INTO public.custom_role(id, tenant_id, name, created_by) VALUES ($1,$2,$3,$4)',
    [appCustomRoleId, homeTenantId, `equiv-app-custom-${suffix}`, sysOwner],
  );
  for (const p of ORG_CUSTOM_PERMS) {
    await client.query(
      'INSERT INTO public.custom_role_permission(custom_role_id, permission) VALUES ($1,$2)',
      [orgCustomRoleId, p],
    );
  }
  for (const p of APP_CUSTOM_PERMS) {
    await client.query(
      'INSERT INTO public.custom_role_permission(custom_role_id, permission) VALUES ($1,$2)',
      [appCustomRoleId, p],
    );
  }

  // Apps: three under the home tenant (override_builtin / override_custom /
  // org_fallback) + one under the other tenant (other_tenant deny scope).
  for (const scope of SCOPES) {
    const tid = scope === 'other_tenant' ? otherTenantId : homeTenantId;
    await client.query(
      'INSERT INTO public.app(id, name, tenant_id, created_by) VALUES ($1,$2,$3,$4)',
      [apps[scope], `app-${scope}-${suffix}`, tid, sysOwner],
    );
  }

  // Actors: auth user + profile + (optional) membership / platform role /
  // per-app overrides.
  for (const actor of actors) {
    await client.query('INSERT INTO auth.users(id) VALUES ($1)', [actor.userId]);
    await client.query('INSERT INTO public.profile(id, name, email) VALUES ($1,$2,$3)', [
      actor.userId,
      actor.label,
      `${actor.label}-${suffix}@authz-equiv.test`,
    ]);

    if (actor.platformAdmin) {
      await client.query(
        'INSERT INTO public.platform_user_role(user_id, role) VALUES ($1,$2)',
        [actor.userId, 'platform_admin'],
      );
    }

    if (!actor.member) continue;

    const membershipId = randomUUID();
    await client.query(
      `INSERT INTO public.membership(id, user_id, tenant_id, role, status, is_app_scoped, custom_role_id)
       VALUES ($1,$2,$3,$4,'active',$5,$6)`,
      [
        membershipId,
        actor.userId,
        homeTenantId,
        actor.role,
        actor.appScoped ?? false,
        actor.orgCustom ? orgCustomRoleId : null,
      ],
    );

    // Per-app overrides for the two override apps. Owner gets them too, to pin
    // that the owner bypass IGNORES per-app overrides. platform_admin /
    // non_member have no membership so no overrides.
    await client.query(
      `INSERT INTO public.app_member_role(membership_id, app_id, tenant_id, role, custom_role_id)
       VALUES ($1,$2,$3,'read',NULL)`,
      [membershipId, apps.override_builtin, homeTenantId],
    );
    await client.query(
      `INSERT INTO public.app_member_role(membership_id, app_id, tenant_id, role, custom_role_id)
       VALUES ($1,$2,$3,'read',$4)`,
      [membershipId, apps.override_custom, homeTenantId, appCustomRoleId],
    );
    // NOTE: no app_member_role row for apps.org_fallback → org-level fallback
    // (an app-scoped member denies here; a non-app-scoped member inherits org).
  }

  await client.query("SET session_replication_role = 'origin'");

  return { homeTenantId, otherTenantId, orgCustomRoleId, appCustomRoleId, apps, actors };
}

async function teardownFixture(fx: Fixture): Promise<void> {
  await client.query("SET session_replication_role = 'replica'");
  // tenant delete cascades app / membership / custom_role / app_member_role.
  await client.query('DELETE FROM public.tenant WHERE tenant_id = ANY($1)', [
    [fx.homeTenantId, fx.otherTenantId],
  ]);
  const userIds = [...fx.actors.map((a) => a.userId)];
  await client.query('DELETE FROM public.platform_user_role WHERE user_id = ANY($1)', [userIds]);
  await client.query('DELETE FROM public.profile WHERE email LIKE $1', [`%@authz-equiv.test`]);
  await client.query('DELETE FROM auth.users WHERE id = ANY($1)', [userIds]);
  await client.query("SET session_replication_role = 'origin'");
}

// ---------------------------------------------------------------------------
// Matrix evaluation
// ---------------------------------------------------------------------------
// Every ordering that feeds the golden is pinned to COLLATE "C": the default
// text collation differs across local stacks (ICU vs C — e.g. 'app.delete' vs
// 'app_connection.*' swap places), and the golden must be byte-reproducible on
// any DB built from the same migrations.

/** All app_permission enum values, sorted alphabetically for a stable golden. */
async function allPermissions(): Promise<string[]> {
  const res = await client.query<{ perm: string }>(
    `SELECT perm FROM (SELECT unnest(enum_range(NULL::public.app_permission))::text AS perm) t ORDER BY perm COLLATE "C"`,
  );
  return res.rows.map((r) => r.perm);
}

/** Mint the request.jwt.claims a given actor would carry, via the real hook. */
async function mintClaims(actor: SeededActor, tenantId: string): Promise<string> {
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
    [actor.userId, tenantId],
  );
  return JSON.stringify(res.rows[0]!.claims);
}

const B = (v: boolean): string => (v ? 't' : 'f');

/**
 * Evaluate the full matrix and return the deterministic golden text.
 */
async function evaluateMatrix(fx: Fixture, perms: string[]): Promise<string> {
  const lines: string[] = [];

  // ---- Header (documentation + fixture shape + flagged rows) ----
  lines.push('# Authz equivalence golden baseline');
  lines.push('# Snapshot of CURRENT resolver behavior — equivalence net, NOT a correctness oracle.');
  lines.push('# Regenerate only after a reviewed, intentional change: UPDATE_AUTHZ_GOLDEN=1.');
  lines.push('#');
  lines.push('# Functions under snapshot:');
  lines.push('#   private.authorize(perm)                        -> org boolean');
  lines.push('#   private.app_authorize(perm, app)               -> per-app boolean');
  lines.push('#   private.effective_app_permissions(app)         -> per-app permission set');
  lines.push('#   private.get_org_permission_set(cr, role, tid)  -> org permission set');
  lines.push('#');
  lines.push('# App scopes (app_authorize / set columns), in order:');
  lines.push('#   override_builtin : home-tenant app, per-app built-in role override = read');
  lines.push('#   override_custom  : home-tenant app, per-app custom-role override (app.read, worker_run.insert, environment.promote)');
  lines.push('#   org_fallback     : home-tenant app, NO per-app row → org-level fallback');
  lines.push('#   other_tenant     : app in a DIFFERENT tenant → expected deny');
  lines.push('#');
  lines.push(`# Org custom-role perms : ${[...ORG_CUSTOM_PERMS].sort().join(', ')}`);
  lines.push(`# App custom-role perms : ${[...APP_CUSTOM_PERMS].sort().join(', ')}`);
  lines.push('#');
  lines.push('# Actors:');
  for (const a of ACTORS) {
    const bits = [
      `role=${a.role ?? 'none'}`,
      a.orgCustom ? 'org_custom_role' : null,
      a.appScoped ? 'is_app_scoped' : null,
      a.platformAdmin ? 'platform_admin' : null,
      a.member ? 'member' : 'NON_member',
    ]
      .filter(Boolean)
      .join(' ');
    lines.push(`#   ${a.label.padEnd(16)} ${bits}`);
  }
  lines.push('#');
  lines.push('# DOWNWARD-OVERRIDE rows (silent-escalation review targets):');
  for (const d of DOWNWARD_OVERRIDES) {
    lines.push(`#   ${d.actor} @ ${d.scope} — ${d.note}`);
  }
  lines.push('#');
  lines.push('# Baseline provenance: regenerated when app_authorize and the per-app permission');
  lines.push('# set collapsed into ONE resolver (private.effective_app_permissions), structured');
  lines.push('# as tenant-closure (I1) → state-gate (I2) → single resolution (I3). The only');
  lines.push('# intended divergences from the pre-consolidation baseline, all within I1/I2/I3:');
  lines.push('#   (a) other_tenant deny — an app outside the actor tenant is out of the resolver');
  lines.push('#       domain (tenant closure), for every actor INCLUDING owner.');
  lines.push('#   (b) disabled deny — a disabled membership yields no effective role, so a per-app');
  lines.push('#       override has nothing to attach to (state gate).');
  lines.push('#   (c) owner BOOL↔SET consistency — owner ignores per-app overrides (I3), so its');
  lines.push('#       answers come from the org owner set, not from an override. environment.');
  lines.push('#       promote is seeded to owner/admin/write in role_permissions, so those roles');
  lines.push('#       hold it via the org role: it appears in the owner/admin/write org sets, in');
  lines.push('#       owner\'s app sets at every in-tenant scope, and for admin/write at');
  lines.push('#       org_fallback. read does not hold it. The app custom-role override already');
  lines.push('#       carries environment.promote, so the override_custom answers are unchanged.');
  lines.push('#');

  // ---- Org-level permission sets (get_org_permission_set) ----
  lines.push('# === ORG PERMISSION SETS (get_org_permission_set) ===');
  for (const actor of orderedActors(fx)) {
    if (!actor.member) continue;
    // Derive the (custom_role_id, role, tenant) the resolver would pass.
    const res = await client.query<{ perms: string[] | null }>(
      `SELECT array_agg(p::text ORDER BY p::text COLLATE "C") AS perms
         FROM private.get_org_permission_set(
                CASE WHEN $1 THEN $2::uuid ELSE NULL END,
                $3::public.app_role,
                $4::uuid
              ) AS p`,
      [!!actor.orgCustom, fx.orgCustomRoleId, actor.role, fx.homeTenantId],
    );
    lines.push(`SETORG ${actor.label} = [${(res.rows[0]!.perms ?? []).join(',')}]`);
  }
  lines.push('#');

  // ---- Per-actor: set claims once per transaction, evaluate booleans + sets ----
  const appSetLines: string[] = ['# === APP PERMISSION SETS (effective_app_permissions) ==='];
  const boolLines: string[] = [
    '# === BOOLEAN MATRIX ===',
    '# BOOL <actor> <perm> org=<t|f> override_builtin=<t|f> override_custom=<t|f> org_fallback=<t|f> other_tenant=<t|f>',
  ];

  for (const actor of orderedActors(fx)) {
    await client.query('BEGIN');
    try {
      const claims = await mintClaims(actor, fx.homeTenantId);
      await client.query('SELECT set_config($1, $2, true)', ['request.jwt.claims', claims]);

      // Per-app permission sets.
      for (const scope of SCOPES) {
        const res = await client.query<{ perms: string[] | null }>(
          `SELECT array_agg(p::text ORDER BY p::text COLLATE "C") AS perms
             FROM private.effective_app_permissions($1::uuid) AS p`,
          [fx.apps[scope]],
        );
        appSetLines.push(`SETAPP ${actor.label} ${scope} = [${(res.rows[0]!.perms ?? []).join(',')}]`);
      }

      // Boolean matrix: one query over every permission × every scope.
      const res = await client.query<{
        perm: string;
        org: boolean;
        ov_builtin: boolean;
        ov_custom: boolean;
        fallback: boolean;
        other: boolean;
      }>(
        `SELECT p.perm::text AS perm,
                private.authorize(p.perm)                       AS org,
                private.app_authorize(p.perm, $1::uuid)         AS ov_builtin,
                private.app_authorize(p.perm, $2::uuid)         AS ov_custom,
                private.app_authorize(p.perm, $3::uuid)         AS fallback,
                private.app_authorize(p.perm, $4::uuid)         AS other
           FROM unnest(enum_range(NULL::public.app_permission)) AS p(perm)
          ORDER BY p.perm::text COLLATE "C"`,
        [
          fx.apps.override_builtin,
          fx.apps.override_custom,
          fx.apps.org_fallback,
          fx.apps.other_tenant,
        ],
      );
      for (const r of res.rows) {
        boolLines.push(
          `BOOL ${actor.label} ${r.perm} org=${B(r.org)} override_builtin=${B(r.ov_builtin)} ` +
            `override_custom=${B(r.ov_custom)} org_fallback=${B(r.fallback)} other_tenant=${B(r.other)}`,
        );
      }
    } finally {
      await client.query('ROLLBACK');
    }
  }

  void perms; // enum is read directly in-query; kept for signature symmetry.
  return [...lines, ...appSetLines, '#', ...boolLines, ''].join('\n');
}

/** Actors in the fixed golden order (matches ACTORS declaration order). */
function orderedActors(fx: Fixture): SeededActor[] {
  const order = ACTORS.map((a) => a.label);
  return [...fx.actors].sort((a, b) => order.indexOf(a.label) - order.indexOf(b.label));
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('Authz equivalence matrix — golden baseline', () => {
  beforeAll(async () => {
    client = new Client({ connectionString: DATABASE_URL });
    await client.connect();
    fixture = await seedFixture();
  }, 60000);

  afterAll(async () => {
    if (fixture) await teardownFixture(fixture);
    if (client) await client.end();
  }, 60000);

  it('current resolver output matches the committed golden baseline', async () => {
    const perms = await allPermissions();
    // Guard the fixture actually covers the whole enum surface — a narrowed
    // enum range would silently shrink the net. Pinned to the generated
    // catalog rather than a floor, so the two cannot drift apart unnoticed.
    expect(perms.length).toBe(APP_PERMISSIONS.length);

    const actual = await evaluateMatrix(fixture, perms);

    if (UPDATE_GOLDEN || !existsSync(GOLDEN_PATH)) {
      writeFileSync(GOLDEN_PATH, actual, 'utf8');
      // A fresh write is not a pass signal — force an explicit re-run to verify
      // the committed file reproduces.
      expect(UPDATE_GOLDEN, 'golden written; re-run without UPDATE_AUTHZ_GOLDEN to verify').toBe(
        true,
      );
      return;
    }

    const golden = readFileSync(GOLDEN_PATH, 'utf8');
    if (actual !== golden) {
      const a = actual.split('\n');
      const g = golden.split('\n');
      const diffs: string[] = [];
      const max = Math.max(a.length, g.length);
      for (let i = 0; i < max && diffs.length < 40; i++) {
        if (a[i] !== g[i]) {
          diffs.push(`  L${i + 1}\n    golden: ${g[i] ?? '<eof>'}\n    actual: ${a[i] ?? '<eof>'}`);
        }
      }
      throw new Error(
        `Authz resolver output diverged from the golden baseline (${diffs.length}+ line(s)).\n` +
          `This is an equivalence failure: either a resolver change is unintended, or it is\n` +
          `intended and the golden must be regenerated (UPDATE_AUTHZ_GOLDEN=1) after review.\n\n` +
          diffs.join('\n'),
      );
    }

    expect(actual).toBe(golden);
  }, 120000);
});
