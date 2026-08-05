/**
 * Pure entitlement resolution shared by the gateway, the dashboard, and
 * any future caller that needs to compute an effective boolean or
 * numeric entitlement for a tenant.
 *
 * Resolution order (matches the cron's batch evaluation, the dashboard's
 * `EntitlementService`, and the gateway's middleware):
 *
 *   1. `tenant_entitlement_override` row — if the override value's `v`
 *      field has a value of the expected type (boolean for boolean
 *      keys, finite number for numeric keys), use it. Type-mismatched
 *      overrides are ignored: the override table is dual-typed
 *      (`{ v: <boolean | number | string> }`) without per-key schema,
 *      so a row of the wrong shape must NOT silently coerce. `true`
 *      becoming `1` on a numeric quota would shrink it to nothing; a
 *      number on a boolean key would otherwise be truthy.
 *
 *   2. `billing.tier_id` → caller-supplied `tierMatrix[tier]`. The
 *      matrix is passed by the consumer because the dashboard owns
 *      display-only entitlement keys (`git_integration`, `custom_sso`,
 *      etc.) that aren't in `@repo/tier-config`'s shared matrix. Keeping
 *      the resolver matrix-agnostic lets both consumers use the same
 *      override + tier-read logic without forcing tier-config to track
 *      dashboard-only keys.
 *
 *   3. Default to `'hobby'` when no billing row exists. New tenants
 *      that haven't completed checkout fall here. Matches the cron's
 *      behaviour so all paths agree on "what does a fresh tenant get?"
 *
 * Failure semantics:
 *
 *   - Errors from the override read are logged (via the supplied
 *     logger, if any) and the resolver falls through to the tier
 *     matrix — an outage on the override table must not block every
 *     request.
 *   - Errors from the billing read are logged and the resolver falls
 *     through to the hobby default — same reason.
 *   - The resolver itself throws ONLY if the Supabase client throws.
 *     PostgREST surfaces query errors via `.error` on the response;
 *     network errors typically throw at the `.from()` call site. The
 *     middleware catches that throw and surfaces a real 500.
 *
 * Consumer responsibility: pass the appropriate Supabase client. The
 * gateway uses its admin client (cross-tenant by design — the request
 * may not have authenticated yet for read-table scoping). The dashboard
 * uses its admin client too. RLS isn't reached in either case because
 * both clients run with the service role.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@repo/db-types';
import {
  BOOLEAN_ENTITLEMENTS,
  NUMERIC_ENTITLEMENTS,
  UNLIMITED,
  type TierId,
  type BooleanEntitlementKey,
  type NumericEntitlementKey,
} from '@repo/tier-config';

/**
 * Strongly-typed Supabase client expected by the resolver. Re-exported
 * so consumers can write `SupabaseEntitlementClient` instead of
 * `SupabaseClient<Database>` and stay decoupled from `@repo/db-types`
 * if they only consume this package.
 */
export type SupabaseEntitlementClient = SupabaseClient<Database>;

export interface EntitlementResolverLogger {
  info?: (message: string, fields: Record<string, unknown>) => void;
  warn?: (message: string, fields: Record<string, unknown>) => void;
  error?: (message: string, fields: Record<string, unknown>) => void;
}

/** Shape of the `tenant_entitlement_override.value` column. */
type EntitlementOverrideValue = { v: unknown } | null;

/** Per-tier values for a single entitlement key. */
export type TierMatrix<T> = Record<TierId, T>;

/** A single override row as returned by `readAllOverrides`. */
export interface EntitlementOverrideRow {
  entitlementKey: string;
  value: boolean | number | string;
}

// ---------------------------------------------------------------------------
// Low-level reads (package-internal; not exported)
// ---------------------------------------------------------------------------

/**
 * Read the `tenant_entitlement_override` row for one tenant+key and
 * return the unwrapped `v` value (or `undefined` if no row exists, the
 * value is malformed, or the read errored).
 */
async function readOverrideValue(
  supabase: SupabaseEntitlementClient,
  tenantId: string,
  key: string,
  logger?: EntitlementResolverLogger,
): Promise<unknown> {
  const result = await supabase
    .from('tenant_entitlement_override')
    .select('value')
    .eq('tenant_id', tenantId)
    .eq('entitlement_key', key)
    .maybeSingle();

  if (result.error) {
    logger?.warn?.('entitlements override lookup failed', {
      tenantId,
      key,
      message: result.error.message,
    });
    return undefined;
  }
  if (!result.data) return undefined;

  const override = (result.data as { value: EntitlementOverrideValue }).value;
  return override?.v;
}

/**
 * Read `billing.tier_id` for one tenant. Returns `'hobby'` when no
 * billing row exists (matches the cron's pre-checkout default) and on
 * read errors (fail closed — pricing decisions should never silently
 * grant access on an infrastructure blip).
 */
async function readTenantTier(
  supabase: SupabaseEntitlementClient,
  tenantId: string,
  logger?: EntitlementResolverLogger,
): Promise<TierId> {
  const result = await supabase
    .from('billing')
    .select('tier_id')
    .eq('tenant_id', tenantId)
    .maybeSingle();

  if (result.error) {
    logger?.warn?.('entitlements billing lookup failed', {
      tenantId,
      message: result.error.message,
    });
  }

  return (result.data?.tier_id as TierId | undefined) ?? 'hobby';
}

// ---------------------------------------------------------------------------
// Composed resolvers
// ---------------------------------------------------------------------------

/**
 * Matrix-agnostic boolean resolver. Override (boolean only) wins over
 * `tierMatrix[tier]`. Use this from the dashboard, where the matrix
 * comes from the dashboard's own ENTITLEMENTS registry.
 */
export async function resolveBoolean(
  supabase: SupabaseEntitlementClient,
  tenantId: string,
  key: string,
  tierMatrix: TierMatrix<boolean>,
  logger?: EntitlementResolverLogger,
): Promise<boolean> {
  const overrideValue = await readOverrideValue(supabase, tenantId, key, logger);
  if (typeof overrideValue === 'boolean') return overrideValue;
  const tier = await readTenantTier(supabase, tenantId, logger);
  return tierMatrix[tier];
}

/**
 * Matrix-agnostic numeric resolver. Override (finite number only) wins
 * over `tierMatrix[tier]`. `-1` (UNLIMITED) is a valid override value;
 * callers comparing a count against the result must use `quotaCheck()`
 * or short-circuit on UNLIMITED themselves.
 */
export async function resolveNumeric(
  supabase: SupabaseEntitlementClient,
  tenantId: string,
  key: string,
  tierMatrix: TierMatrix<number>,
  logger?: EntitlementResolverLogger,
): Promise<number> {
  const overrideValue = await readOverrideValue(supabase, tenantId, key, logger);
  // Accept finite numbers OR the explicit UNLIMITED sentinel. Reject
  // booleans (the dual-typed override schema lets either land here)
  // because a `true` would coerce to 1 and silently shrink the quota.
  if (typeof overrideValue === 'number' && Number.isFinite(overrideValue)) {
    return overrideValue;
  }
  const tier = await readTenantTier(supabase, tenantId, logger);
  return tierMatrix[tier];
}

// ---------------------------------------------------------------------------
// Bulk overrides — used by `getEffectiveEntitlements` to render the
// full entitlement panel without per-key round trips.
// ---------------------------------------------------------------------------

/**
 * Read every override row for one tenant and return them with the
 * `value.v` field unwrapped. Skips rows where `value.v` is not a
 * primitive (boolean/number/string) — the override schema is
 * dual-typed but only those three types are meaningful as entitlement
 * values.
 *
 * Returns `[]` on read errors (logged) so the caller can still render
 * the tier defaults without an override list.
 */
export async function readAllOverrides(
  supabase: SupabaseEntitlementClient,
  tenantId: string,
  logger?: EntitlementResolverLogger,
): Promise<EntitlementOverrideRow[]> {
  const result = await supabase
    .from('tenant_entitlement_override')
    .select('entitlement_key, value')
    .eq('tenant_id', tenantId);

  if (result.error) {
    logger?.warn?.('entitlements bulk override lookup failed', {
      tenantId,
      message: result.error.message,
    });
    return [];
  }
  if (!result.data) return [];

  const rows: EntitlementOverrideRow[] = [];
  for (const raw of result.data as Array<{
    entitlement_key: string;
    value: EntitlementOverrideValue;
  }>) {
    const rawV = raw.value?.v;
    if (
      typeof rawV === 'boolean' ||
      (typeof rawV === 'number' && Number.isFinite(rawV)) ||
      typeof rawV === 'string'
    ) {
      rows.push({ entitlementKey: raw.entitlement_key, value: rawV });
      continue;
    }
    // The `tenant_entitlement_override.value` column is `jsonb` with no
    // per-key schema enforcement. A row with a non-primitive `v` is
    // dropped here (otherwise the dashboard's entitlement panel would
    // render `[object Object]` and the resolver would silently return
    // garbage). Surface it so operators see the bad data.
    logger?.warn?.('skipping malformed override row', {
      tenantId,
      entitlementKey: raw.entitlement_key,
      valueType: rawV === null ? 'null' : typeof rawV,
    });
  }
  return rows;
}

// ---------------------------------------------------------------------------
// Batch resolution — every tenant at once, for cross-tenant cron paths.
// ---------------------------------------------------------------------------

/** Result of {@link resolveNumericLimitForAllTenants}. */
export interface TenantNumericLimits {
  /**
   * Effective value per tenant that has a billing row and/or a typed
   * override for the key. Tenants absent from the map resolve to
   * `fallback`.
   */
  byTenant: Map<string, number>;
  /**
   * The hobby-tier value — what a tenant with no billing row and no
   * override gets, matching the per-tenant resolver's default.
   */
  fallback: number;
}

/** PostgREST caps responses at 1000 rows; page in that unit. */
const BATCH_PAGE_SIZE = 1000;

/**
 * Resolve one numeric entitlement for EVERY tenant in two table scans
 * (billing + overrides for the key), applying the same precedence as
 * {@link resolveNumeric}: typed override (finite number) → tier matrix →
 * hobby default. Malformed override values (non-finite / wrong type) are
 * skipped with a warn, exactly like the per-tenant path.
 *
 * Failure semantics are deliberately OPPOSITE to the per-tenant
 * resolvers: any read error THROWS instead of falling through to a
 * default. The callers of this function are batch jobs whose actions
 * fan out across all tenants (e.g. the retention sweep physically
 * deleting expired rows) — silently degrading every tenant to the hobby
 * default on a billing-table outage would turn an infrastructure blip
 * into a mass data deletion. A cron tick that throws simply runs later.
 *
 * Both scans paginate past PostgREST's 1000-row cap with a stable
 * primary-key order, so tenant counts beyond one page resolve fully.
 */
export async function resolveNumericLimitForAllTenants(
  supabase: SupabaseEntitlementClient,
  key: NumericEntitlementKey,
  logger?: EntitlementResolverLogger,
): Promise<TenantNumericLimits> {
  const matrix = NUMERIC_ENTITLEMENTS[key];
  const byTenant = new Map<string, number>();

  // Tier defaults first, override pass second, so an override always wins.
  for await (const page of paginate(
    (from, to) =>
      supabase
        .from('billing')
        .select('tenant_id, tier_id')
        .order('tenant_id', { ascending: true })
        .range(from, to),
    'billing',
  )) {
    for (const row of page as Array<{ tenant_id: string; tier_id: string | null }>) {
      const tier = (row.tier_id ?? 'hobby') as TierId;
      byTenant.set(row.tenant_id, matrix[tier] ?? matrix.hobby);
    }
  }

  for await (const page of paginate(
    (from, to) =>
      supabase
        .from('tenant_entitlement_override')
        .select('id, tenant_id, value')
        .eq('entitlement_key', key)
        .order('id', { ascending: true })
        .range(from, to),
    'tenant_entitlement_override',
  )) {
    for (const row of page as Array<{
      id: string;
      tenant_id: string;
      value: EntitlementOverrideValue;
    }>) {
      const v = row.value?.v;
      if (typeof v === 'number' && Number.isFinite(v)) {
        byTenant.set(row.tenant_id, v);
        continue;
      }
      // Same rule as `resolveNumeric`: a wrong-typed override must not
      // coerce (a boolean `true` would become a 1-day quota). Fall back
      // to the tier value already in the map (or the hobby fallback).
      logger?.warn?.('skipping malformed numeric override in batch resolve', {
        tenantId: row.tenant_id,
        key,
        valueType: v === null ? 'null' : typeof v,
      });
    }
  }

  return { byTenant, fallback: matrix.hobby };
}

/**
 * Async generator over PostgREST pages. Throws on the first error —
 * see `resolveNumericLimitForAllTenants` for why batch reads must not
 * degrade silently.
 */
async function* paginate(
  fetchPage: (
    from: number,
    to: number,
  ) => PromiseLike<{ data: unknown[] | null; error: { message: string } | null }>,
  table: string,
): AsyncGenerator<unknown[]> {
  for (let from = 0; ; from += BATCH_PAGE_SIZE) {
    const { data, error } = await fetchPage(from, from + BATCH_PAGE_SIZE - 1);
    if (error) {
      throw new Error(`entitlements batch read of ${table} failed: ${error.message}`);
    }
    const rows = data ?? [];
    if (rows.length > 0) yield rows;
    if (rows.length < BATCH_PAGE_SIZE) return;
  }
}

// ---------------------------------------------------------------------------
// Quota arithmetic — the UNLIMITED-aware comparison every quota consumer
// needs. Exposed here so future callers don't reinvent the sentinel
// check and accidentally deny every enterprise request.
// ---------------------------------------------------------------------------

export interface QuotaCheckResult {
  allowed: boolean;
  /** Remaining capacity. `Infinity` when the limit is UNLIMITED. */
  remaining: number;
}

/**
 * Compare a count against a tier limit, honouring `UNLIMITED` (-1).
 *
 *   quotaCheck(24, 25)  → { allowed: true, remaining: 1 }
 *   quotaCheck(25, 25)  → { allowed: false, remaining: 0 }
 *   quotaCheck(999, -1) → { allowed: true, remaining: Infinity }
 *
 * `allowed === false` means a write that *adds* one item would exceed
 * the quota. Use `count < limit` semantics: a fresh tenant at 24 keys
 * with a 25-key limit is still allowed; at 25 they're blocked from
 * adding the 26th.
 */
export function quotaCheck(count: number, limit: number): QuotaCheckResult {
  if (limit === UNLIMITED) return { allowed: true, remaining: Infinity };
  const remaining = Math.max(0, limit - count);
  return { allowed: count < limit, remaining };
}

// ---------------------------------------------------------------------------
// Tier-config-narrow convenience wrappers
//
// The gateway gates only keys that exist in `@repo/tier-config`, so it
// uses these narrow-typed entry points — catches typos as compile
// errors. The dashboard reaches for `resolveBoolean` / `resolveNumeric`
// directly with its own matrix because some of its keys are
// display-only and live outside tier-config.
// ---------------------------------------------------------------------------

export async function resolveBooleanEntitlement(
  supabase: SupabaseEntitlementClient,
  tenantId: string,
  key: BooleanEntitlementKey,
  logger?: EntitlementResolverLogger,
): Promise<boolean> {
  return resolveBoolean(supabase, tenantId, key, BOOLEAN_ENTITLEMENTS[key], logger);
}

export async function resolveNumericLimit(
  supabase: SupabaseEntitlementClient,
  tenantId: string,
  key: NumericEntitlementKey,
  logger?: EntitlementResolverLogger,
): Promise<number> {
  return resolveNumeric(supabase, tenantId, key, NUMERIC_ENTITLEMENTS[key], logger);
}
