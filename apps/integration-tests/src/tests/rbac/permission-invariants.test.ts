/**
 * Permission-system CI invariants.
 *
 * (a) Seed completeness. Every app_permission enum value is granted to the owner
 *     role OR is declared intentionally_unseeded (with a reason) in the seed. A
 *     new enum value that reaches no role — the class that left environment.*
 *     grantable only through the gateway path — fails here instead of silently
 *     shipping as dead authorization surface.
 *
 * (b) Minted-claim policies. Every JWT claim read by an RLS policy or an authz
 *     function must be a claim the token actually carries (minted by
 *     custom_access_token_hook, or a standard GoTrue claim). This catches the
 *     dead-claim class: a policy branch keyed on a claim nothing mints reads as
 *     a working grant but silently never fires — e.g. a top-level `tenant_id`,
 *     when the tenant is carried at app_metadata.tenant_id. The allowlist is
 *     data — request-header/GUC reads are a separate axis and are not JWT claims,
 *     so a later dual-source tenant_id() that reads X-Tenant-Id does not trip this.
 */

import { Client } from 'pg';
import { describe, it, beforeAll, afterAll, expect } from 'vitest';
import {
  APP_PERMISSIONS,
  BUILT_IN_ROLE_PERMISSIONS,
  INTENTIONALLY_UNSEEDED,
} from '@repo/db-types/permissions';

const DATABASE_URL =
  process.env.DATABASE_URL || 'postgresql://postgres:postgres@127.0.0.1:54332/postgres';

// Every claim path an RLS policy or authz function may legitimately read from
// the access token. Minted by custom_access_token_hook: user_role,
// custom_role_id, platform_role, impersonating_tenant_id. The tenant is carried
// in app_metadata.tenant_id (GoTrue user metadata, rewritten by set_claim on org
// switch). The rest are standard registered/GoTrue claims present on every token.
// Note: top-level `tenant_id` is deliberately NOT here — nothing mints it.
const ALLOWED_CLAIM_PATHS = new Set<string>([
  'user_role',
  'custom_role_id',
  'platform_role',
  'impersonating_tenant_id',
  'app_metadata.tenant_id',
  'app_metadata',
  'user_metadata',
  'sub',
  'aud',
  'role',
  'email',
  'phone',
  'exp',
  'iat',
  'iss',
  'session_id',
  'aal',
  'is_anonymous',
  // Minted by Supabase's OAuth server on connector access tokens, not
  // custom_access_token_hook; private.is_connector_token reads it only to
  // detect a connector token, never to authorize on its value.
  'client_id',
]);

/**
 * Extract every JWT-claim access PATH from a SQL expression.
 *
 * The recognized claim-read shapes are a CLOSED LIST: a chain of `->`/`->>`
 * single-key steps and/or `#>`/`#>>` path-array steps (`'{a,b}'`), rooted at
 * `auth.jwt()` or `current_setting('request.jwt.claims', …)`. These cover the
 * forms that occur here:
 *   - a function body:  `auth.jwt() ->> 'a'`, `auth.jwt() -> 'a' ->> 'b'`
 *   - a policy qual:    `( SELECT auth.jwt() AS jwt) ->> 'a'::text` (the SELECT
 *                       alias + type cast PostgREST wraps a policy in)
 *   - the tenant_id fn: `(current_setting('request.jwt.claims',true)::jsonb ->>
 *                       'a')::jsonb ->> 'b'`
 *   - a path form:      `auth.jwt() #>> '{app_metadata,tenant_id}'`
 * The between-operator noise (`AS <alias>`, `::<type>`, closing parens) is
 * skipped, so the chain is followed to the leaf. Any OTHER claim-read spelling
 * (jsonb_path_query, a cast to a different accessor, …) is a KNOWN
 * false-negative class, not a silently-handled one — extend this list if the
 * schema grows one. Returns dotted paths, e.g. 'user_role',
 * 'app_metadata.tenant_id'.
 */
function extractClaimPaths(body: string): string[] {
  const paths: string[] = [];
  const rootRe = /auth\.jwt\(\)|current_setting\(\s*'request\.jwt\.claims'[^)]*\)/g;
  // One chain step: skip between-operator noise, then match either a `->`/`->>`
  // single key (group 1) or a `#>`/`#>>` '{a,b,…}' path array (group 2).
  const chainStep =
    /^\s*(?:(?:AS\s+"?\w+"?|::\s*\w+|\))\s*)*(?:->>?\s*'([a-z_]+)'|#>>?\s*'\{([a-z_,\s]+)\}')/;
  let root: RegExpExecArray | null;
  while ((root = rootRe.exec(body)) !== null) {
    let rest = body.slice(rootRe.lastIndex);
    const keys: string[] = [];
    let step: RegExpMatchArray | null;
    while ((step = rest.match(chainStep)) !== null) {
      if (step[1] !== undefined) {
        keys.push(step[1]);
      } else if (step[2] !== undefined) {
        for (const k of step[2].split(',')) keys.push(k.trim());
      }
      rest = rest.slice(step[0].length);
    }
    if (keys.length > 0) paths.push(keys.join('.'));
  }
  return paths;
}

let client: Client;

describe('permission invariants', () => {
  beforeAll(async () => {
    client = new Client({ connectionString: DATABASE_URL });
    await client.connect();
  }, 30000);

  afterAll(async () => {
    if (client) await client.end();
  });

  it('(a) every app_permission is granted to owner or intentionally unseeded', async () => {
    const res = await client.query<{ v: string }>(
      `SELECT unnest(enum_range(NULL::public.app_permission))::text AS v`,
    );
    const enumValues = res.rows.map((r) => r.v);
    // Derived, not a floor: the generated catalog and the enum are the same
    // set, so a value added or pruned on one side alone shows up here.
    expect(enumValues.length).toBe(APP_PERMISSIONS.length);

    const ownerSet = new Set<string>(BUILT_IN_ROLE_PERMISSIONS.owner);
    const unseeded = new Set<string>(INTENTIONALLY_UNSEEDED);

    // The assertion that matters: nothing falls through both nets.
    const uncovered = enumValues.filter((v) => !ownerSet.has(v) && !unseeded.has(v)).sort();
    expect(uncovered, `enum values granted to no role and not intentionally_unseeded`).toEqual([]);

    // No stale intentionally_unseeded entries (every one is a real enum value)…
    const enumSet = new Set(enumValues);
    expect([...INTENTIONALLY_UNSEEDED].filter((p) => !enumSet.has(p))).toEqual([]);
    // …and the two nets are disjoint (a perm is never both).
    expect([...INTENTIONALLY_UNSEEDED].filter((p) => ownerSet.has(p))).toEqual([]);
  });

  it('(b) every JWT claim read by a policy or authz function is a minted/standard claim', async () => {
    const res = await client.query<{ loc: string; body: string }>(
      `SELECT loc, body FROM (
         SELECT schemaname || '.' || tablename || ' [' || policyname || ']' AS loc,
                coalesce(qual, '') || ' ' || coalesce(with_check, '') AS body
           FROM pg_policies WHERE schemaname IN ('public', 'storage')
         UNION ALL
         SELECT n.nspname || '.' || p.proname AS loc, pg_get_functiondef(p.oid) AS body
           FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
          WHERE n.nspname IN ('public', 'private')
            AND p.prokind = 'f' -- normal functions only; pg_get_functiondef errors on aggregates
       ) s`,
    );

    // Sanity: the scan actually reaches the authz functions that read claims,
    // so a green result means "no bad claim", not "scanned nothing".
    const seenClaimReaders = res.rows.filter((r) => extractClaimPaths(r.body).length > 0);
    expect(seenClaimReaders.length).toBeGreaterThan(0);

    const offenders: string[] = [];
    for (const { loc, body } of res.rows) {
      for (const path of extractClaimPaths(body)) {
        if (!ALLOWED_CLAIM_PATHS.has(path)) offenders.push(`${loc}: reads unminted claim '${path}'`);
      }
    }
    expect(offenders.sort()).toEqual([]);
  });
});

// Pins the parser the invariant depends on. No live policy uses the `#>>` path
// form today, so without this its branch would ship unexercised; and a parser
// that silently stopped extracting claims would make invariant (b) pass
// vacuously.
describe('extractClaimPaths (claim-read parser)', () => {
  it('extracts each recognized claim-read shape and nothing outside the closed list', () => {
    // Single key and nested `->`/`->>` chain off auth.jwt().
    expect(extractClaimPaths(`auth.jwt() ->> 'user_role'`)).toEqual(['user_role']);
    expect(extractClaimPaths(`auth.jwt() -> 'app_metadata' ->> 'tenant_id'`)).toEqual([
      'app_metadata.tenant_id',
    ]);
    // The SELECT-alias + cast wrapper PostgREST puts around a policy qual.
    expect(extractClaimPaths(`( SELECT auth.jwt() AS jwt) ->> 'user_role'::text`)).toEqual([
      'user_role',
    ]);
    // current_setting('request.jwt.claims', …) with the nested jsonb casts the
    // tenant_id() function normalizes to.
    expect(
      extractClaimPaths(
        `(current_setting('request.jwt.claims', true)::jsonb ->> 'app_metadata')::jsonb ->> 'tenant_id'`,
      ),
    ).toEqual(['app_metadata.tenant_id']);
    // The `#>>` path-array shape (the newly recognized one) flattens to a dotted path.
    expect(extractClaimPaths(`auth.jwt() #>> '{app_metadata,tenant_id}'`)).toEqual([
      'app_metadata.tenant_id',
    ]);
    // Two independent reads in one expression are both returned, in order.
    expect(
      extractClaimPaths(`auth.jwt() ->> 'user_role' = 'x' AND auth.jwt() ->> 'platform_role' = 'y'`),
    ).toEqual(['user_role', 'platform_role']);
    // A spelling outside the closed list yields no path — the documented,
    // deliberate false-negative rather than a wrong extraction.
    expect(extractClaimPaths(`jsonb_path_query(auth.jwt(), '$.user_role')`)).toEqual([]);
  });
});
