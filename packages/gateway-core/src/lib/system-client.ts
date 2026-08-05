/**
 * System-client helpers — the sanctioned callers of createSupabaseAdminClient.
 *
 * This file is the ONE exception to the admin-client ESLint ban
 * (apps/gateway/eslint.config.mjs). Any other file that needs to bypass
 * RLS must route through a helper here. Adding a new export requires
 * justifying why scoped-client can't work.
 *
 * Two shapes of caller legitimately exist:
 *
 * 1. Payload-derivable tenant — inbound webhook, async callback, any path
 *    that lacks an API-key user context but carries a unique identifier
 *    (run_id, incident_id, ...) that pins down a single tenant. Use
 *    `resolveTenantAndScope` — it runs one admin lookup to resolve the
 *    tenant, then returns a scoped Supabase client for all subsequent
 *    operations. The admin-client exposure is confined to the lookup
 *    callback, and RLS enforces tenant isolation for the rest of the
 *    request.
 *
 * 2. Cross-tenant by design — scheduled jobs that iterate across every
 *    tenant's alert configs, platform-level maintenance scripts, and so
 *    on. These paths have no single "current tenant" by construction.
 *    Use `createSystemAdminClient` — it's literally `createSupabaseAdminClient`
 *    exposed under a name that documents the intent. Consumers should
 *    comment why their use is genuinely cross-tenant; a reviewer seeing
 *    `createSystemAdminClient` in a tenant-scoped handler should push
 *    back and route it through `resolveTenantAndScope` instead.
 *
 * End state: the raw `createSupabaseAdminClient` export in `admin-client.ts`
 * is imported ONLY from this file.
 * The ESLint rule enforces that; future consumers go through the two
 * helpers above.
 */

import { createSupabaseAdminClient } from './admin-client';
import { createTenantScopedClient } from './scoped-client';
import type { Env } from '../types';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '../db';

/** Short-lived admin client used by resolveTenantAndScope's lookup callback. */
export type SystemAdminClient = ReturnType<typeof createSupabaseAdminClient>;

/**
 * The Supabase client surface the gateway's shared service layer accepts —
 * deliberately the UNTYPED `SupabaseClient` (no `Database` generic).
 *
 * This is the canonical name for the untyped client surface the gateway's
 * shared service layer needs, so the same client is not spelled three
 * divergent ways across the codebase. Dropping the `Database` generic is
 * intentional, for three reasons:
 *
 *  - **Workers bundle.** The shared service layer (`@repo/environments-service`'s
 *    env writers, git providers) is Workers-bundled; the full
 *    `SupabaseClient<Database>` generic bloats the bundle and hits TS
 *    instantiation limits.
 *  - **Cross-package identity.** Even where both sides nominally use
 *    `SupabaseClient<Database>`, gateway-core and `@repo/environments-service`
 *    each resolve their own copy of `@supabase/supabase-js`, so the client
 *    types are structurally incompatible across the package boundary — a
 *    direct assignment fails typecheck.
 *  - **DB-types gaps.** Some queries hit tables the generated `Database` type
 *    doesn't model yet (e.g. feature-054's `environment`), which only the
 *    untyped surface can express.
 *
 * The eventual fix is a narrow structural `Pick<>` interface of just the
 * `from` / `rpc` / `storage` surface the service layer uses (the
 * `@repo/entitlements` pattern) — typed AND bundle-light AND cross-package
 * stable. Until then, this one seam is where that change lands.
 */
export type ServiceSupabaseClient = SupabaseClient;

/**
 * Adapt a concrete Supabase client handle to the {@link ServiceSupabaseClient}
 * seam. This is the ONE sanctioned `as unknown as` for the gateway service
 * layer: keeping every such cast behind this single function means the
 * intent lives in one audited place rather than at each call site. See
 * {@link ServiceSupabaseClient} for why the cast is needed at all.
 */
export function asServiceClient(client: object): ServiceSupabaseClient {
  return client as unknown as ServiceSupabaseClient;
}

/**
 * Run an admin-client lookup to resolve a tenant from a payload identifier,
 * then return a scoped Supabase client for subsequent operations.
 *
 * The lookup callback receives a short-lived admin client. Return
 * `{ tenantId, extras? }` if the identifier resolves, or `null` if it
 * doesn't — the caller typically maps `null` to a 404.
 *
 * Example (webhook callback resolving tenant from run_id):
 *
 *     const resolved = await resolveTenantAndScope(env, async (admin) => {
 *       const { data, error } = await admin
 *         .from('worker_run')
 *         .select('tenant_id')
 *         .eq('id', runId)
 *         .single();
 *       if (error || !data) return null;
 *       return { tenantId: data.tenant_id };
 *     });
 *     if (!resolved) return notFound();
 *     // subsequent DB ops use resolved.supabase — scoped, RLS-enforced
 */
export async function resolveTenantAndScope<T = undefined>(
  env: Env,
  lookup: (admin: SystemAdminClient) => Promise<{ tenantId: string; extras?: T } | null>,
): Promise<{
  tenantId: string;
  supabase: SupabaseClient<Database>;
  extras: T | undefined;
} | null> {
  const admin = createSupabaseAdminClient(env);
  const result = await lookup(admin);
  if (!result) return null;

  // The tenant id doubles as the JWT `sub` because nothing reads it:
  // set_created_columns() and set_updated_columns() own created_by/updated_by
  // for the gateway role, and RLS keys on the tenant_id claim. That avoids
  // having to provision a per-tenant gateway system user just to have a sub.
  const supabase = await createTenantScopedClient(
    env,
    result.tenantId,
    result.tenantId,
    // No gateway_permissions — system paths authenticate via shared secret
    // (webhooks) or scheduler (jobs). The gateway-role RLS policies only
    // check tenant_id; they don't consult the permissions claim.
    [],
  );

  return {
    tenantId: result.tenantId,
    supabase,
    extras: result.extras,
  };
}

/**
 * Sanctioned admin client for paths that are cross-tenant by design.
 *
 * Use cases:
 *   * Scheduled jobs that iterate across every tenant's configs
 *     (e.g. jobs/alert-handler.ts evaluates all enabled alert configs)
 *   * Platform-level maintenance hooks
 *   * Betterstack incident webhooks (match runs across all configs before
 *     one tenant is identified) — narrowly, the lookup phase only.
 *
 * Not a general-purpose escape hatch. If you find yourself using this for
 * a tenant-scoped handler, switch to `resolveTenantAndScope` or (if the
 * tenant is already known) `createTenantScopedClient` from '../supabase'.
 *
 * Functionally identical to `createSupabaseAdminClient` — the rename
 * exists so every call site reads "yes, I know this is cross-tenant and
 * I've considered the alternatives."
 */
export function createSystemAdminClient(env: Env): SystemAdminClient {
  return createSupabaseAdminClient(env);
}


/** One environment row, as much of it as the kind classification needs. */
export interface AppEnvironmentRow {
  name: string | null;
  current_version: number | null;
  is_ephemeral: boolean | null;
}

/**
 * Every environment of one app, for resolving a kind-scoped API key's read
 * scope.
 *
 * Lives here rather than at the call site because that is this module's whole
 * contract: an admin-client read belongs behind a named helper, not inlined. The
 * caller is the `gateway` role, whose `environment` policy is tenant-wide, so
 * scoping is applied explicitly — `tenant_id` AND `app_id`, both taken from the
 * verified user context and never from request input.
 *
 * THROWS on a query failure rather than returning an empty list. An empty list
 * legitimately means "this key may read no environment"; conflating that with a
 * transient error would turn a Supabase blip into a silent scope change.
 */
export async function listAppEnvironments(
  env: Env,
  tenantId: string,
  appId: string,
): Promise<AppEnvironmentRow[]> {
  const admin = createSupabaseAdminClient(env);
  const { data, error } = await admin
    .from('environment')
    .select('name, current_version, is_ephemeral')
    .eq('tenant_id', tenantId)
    .eq('app_id', appId);

  if (error) {
    console.error('[system-client] listAppEnvironments failed, failing closed:', error.message);
    throw new Error('environment kind resolution failed');
  }
  return (data ?? []) as AppEnvironmentRow[];
}

/** Narrow storage interface returned by createStorageClient. Exposes only
 *  the operations tenant-scoped handlers legitimately need, with the
 *  tenantId prefix invariant enforced at the client boundary. */
export interface TenantScopedStorage {
  /**
   * Mint a short-lived signed URL for a storage object. `path` MUST
   * start with `${tenantId}/` — the client throws otherwise. Returns
   * null if the object does not exist or storage-api returns an error
   * (the underlying error is logged, not swallowed silently).
   */
  createSignedUrl: (
    bucket: string,
    path: string,
    expiresSec: number,
  ) => Promise<{ signedUrl: string } | null>;
}

/**
 * Sanctioned storage client for tenant-scoped handlers.
 *
 * The gateway Postgres role cannot reach storage.objects through the
 * designed scoped-JWT chain. Supabase migrations run as `postgres`,
 * which has USAGE on the `storage` schema but NOT USAGE WITH GRANT
 * OPTION — only `supabase_admin` (the schema owner) does, and it is
 * not accessible from migrations. Any `GRANT USAGE ON SCHEMA storage
 * TO gateway` from a migration silently no-ops with the warning
 * `no privileges were granted for "storage"`. Without that schema
 * grant, every `SET ROLE gateway; SELECT ... FROM storage.objects`
 * fails at schema visibility ("relation objects does not exist")
 * before the RLS engine is consulted.
 *
 * Tenant isolation is enforced at this helper's boundary: the
 * returned client closes over `tenantId` and rejects any path that
 * does not start with `${tenantId}/`. Callers cannot reach the
 * underlying service-role Supabase client, so there is no path by
 * which a misused call could touch another tenant's objects.
 * `tenantId` must be the JWT-verified claim from the auth middleware
 * (`c.get('user').tenantId`), not a value pulled from request input.
 *
 * Paired with an ESLint allowlist that restricts imports of this
 * helper to specific call sites (see apps/gateway/eslint.config.mjs).
 */
export function createStorageClient(env: Env, tenantId: string): TenantScopedStorage {
  const admin = createSupabaseAdminClient(env);
  const prefix = `${tenantId}/`;

  return {
    createSignedUrl: async (bucket, path, expiresSec) => {
      // A prefix test alone is not a scope check: a relative segment after the
      // prefix still resolves outside the tenant's folder. Reject any relative
      // or empty segment first, then apply the prefix test. This store is
      // separate from the blob store, so it carries its own guard rather than
      // relying on `assertSafeBlobKey`.
      const traversal = path
        .split('/')
        .some((segment) => segment === '' || segment === '.' || segment === '..');
      if (traversal || !path.startsWith(prefix)) {
        throw new Error(
          `Refusing to sign storage path "${path}": not scoped to tenant ${tenantId}`,
        );
      }
      const { data, error } = await admin.storage
        .from(bucket)
        .createSignedUrl(path, expiresSec);
      if (error) {
        // Surface the underlying storage-api error so debugging doesn't
        // require direct DB inspection. Returning null preserves the
        // caller's existing 404 mapping for the "object missing" case.
        console.error("[storage] createSignedUrl failed:", {
          bucket,
          path,
          error: error.message,
        });
      }
      return data;
    },
  };
}
