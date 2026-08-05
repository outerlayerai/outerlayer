/**
 * Environment resolver — Environments & Promotion.
 *
 * Resolves the environment bound to an API key so the trace/score ingest
 * paths can stamp `(Environment, EnvironmentVersion, CommitSha)` onto every
 * row.
 *
 * The binding is `api_key.environment_id` (NOT NULL post-migration — see
 * `apps/tenant-dashboard/supabase/schemas/23-api-key.sql`). The gateway only
 * ever sees the Unkey
 * `keyId`, which equals `api_key.api_key_id`. This module looks that row up,
 * joins `environment`, and returns the env's name + pin state.
 *
 * --------------------------------------------------------------------------
 * WORKER-LEVEL LRU CACHE (best-effort revocation propagation)
 * --------------------------------------------------------------------------
 * Resolution results are cached in a module-level `Map` with a bounded TTL
 * (~60s), by design: when an environment is deleted its API keys are
 * CASCADE-revoked, but a key already in the resolver cache keeps resolving
 * to the (now stale) env until the TTL expires. After
 * expiry the next lookup hits the DB, the `api_key` row is gone, and the
 * resolver returns the {@link NO_ENVIRONMENT} sentinel — stamping then falls
 * back to empty string / zero. No new dependency: a plain `Map` keyed by
 * `api_key_id` with timestamp eviction.
 *
 * Transient errors are NOT cached for the full TTL: a `NO_ENVIRONMENT` result
 * derived from a Supabase error (rather than a genuine row-absent miss) gets a
 * short ~2s TTL so a 1s DB blip cannot degrade env stamping for a full minute
 * — the next span re-queries.
 *
 * Tenant safety: every lookup is scoped by `tenant_id` in addition to the
 * `api_key_id`. The caller passes the JWT-verified `tenantId` from
 * `c.get('user')`; a forged/foreign key id can never resolve another tenant's
 * env because the `.eq('tenant_id', ...)` filter is always present.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { asServiceClient } from './system-client';
import { envTargetOf, type EnvTargetKind } from '@repo/env-kind';

/**
 * The environment bound to an API key, in the shape the stamping paths need.
 * `pinned_version` / `pinned_commit_sha` are both NULL for a no-pin env and
 * both set for a pinned env (the DB enforces this coherence — see
 * `chk_environment_pin_coherence`).
 */
export interface ResolvedEnvironment {
  /** Environment UUID — FK value from `api_key.environment_id`. Used by
   *  snapshot-serving routes to look up snapshot rows by `environment_id`
   *  without a secondary DB lookup. */
  id: string;
  /** Environment name — stamped onto `Environment`. */
  name: string;
  /** True when this is the app's default environment. Drives the legacy-row
   *  branch of `buildEnvironmentWhereClause`: a default-env caller must also
   *  see untagged rows stamped with `Environment = ''`. */
  isDefault: boolean;
  /** Pinned version — stamped onto `EnvironmentVersion` (via `?? 0`). NULL = no-pin. */
  pinned_version: number | null;
  /** Pinned commit — authoritative `CommitSha` source when pinned. NULL = no-pin. */
  pinned_commit_sha: string | null;
  /** The env's target bucket ('development' | 'preview' | 'promoted'), or null
   *  if it can't be classified. Used to authorize a key's `allowed_env_kinds`
   *  against a per-request env selection. */
  targetKind: EnvTargetKind | null;
}

/**
 * Sentinel returned when an API key has no resolvable environment binding:
 * legacy keys whose `environment_id` is somehow NULL (should not happen
 * post-migration), bearer-auth requests (no API key at all), revoked keys
 * whose row has been CASCADE-deleted, or any lookup error. Callers treat this
 * as "no env" — stamping falls back to `''` / `0` and the SDK-supplied
 * `CommitSha` flows through unchanged.
 */
export const NO_ENVIRONMENT: null = null;

/** Cache TTL — best-effort revocation propagation window. */
const CACHE_TTL_MS = 60_000;

/**
 * Short TTL applied when a lookup fails with a transient error (DB threw)
 * rather than returning a genuine row-absent miss. A 1s Supabase blip must NOT
 * degrade env stamping for the full 60s window — the next span re-queries.
 */
const ERROR_CACHE_TTL_MS = 2_000;

/** Cap the cache so a key-enumeration burst cannot grow it unbounded. */
const CACHE_MAX_ENTRIES = 5_000;

interface CacheEntry {
  /** The resolved value (or the no-env sentinel) captured at `storedAt`. */
  value: ResolvedEnvironment | null;
  /** Epoch ms the entry was written — used for TTL eviction. */
  storedAt: number;
  /** Per-entry TTL. Genuine hits/misses use {@link CACHE_TTL_MS}; entries
   *  stored after a transient lookup error use the short
   *  {@link ERROR_CACHE_TTL_MS} so a DB blip does not degrade stamping for a
   *  full minute. */
  ttlMs: number;
  /** True when this entry was derived from a transient lookup error (DB
   *  threw or returned an error result), false for genuine hits/misses.
   *  `failClosed` callers re-throw on cache hits where this is set, so a
   *  fail-open caller cannot silently degrade a subsequent fail-closed
   *  caller via shared cache. */
  transientError: boolean;
}

/**
 * Thrown by {@link resolveEnvironmentFromApiKey} when invoked with
 * `failClosed: true` and the lookup hits a transient error (DB threw or
 * returned an error result). Read-side callers (`resolveEnvScope`) let this
 * propagate to Hono's onError so the request becomes a 500 rather than
 * silently degrading to cross-env access.
 */
export class EnvironmentResolutionError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message);
    this.name = 'EnvironmentResolutionError';
    if (options?.cause !== undefined) {
      (this as Error & { cause?: unknown }).cause = options.cause;
    }
  }
}

/**
 * Module-level cache. A Cloudflare Worker isolate keeps module state alive
 * across requests, so this behaves as a per-worker LRU with TTL eviction.
 */
const resolverCache = new Map<string, CacheEntry>();

/**
 * Compose the cache key — namespaced by tenant AND by resolution path so the
 * two strategies never cross-contaminate. `kind: 'env'` keys the meta path
 * (env id from the token); `kind: 'key'` keys the legacy `api_key` fallback.
 */
function cacheKey(tenantId: string, id: string, kind: 'env' | 'key'): string {
  return `${tenantId}:${kind}:${id}`;
}

/** Read a non-expired cache entry, evicting it if stale. */
function readCache(key: string): CacheEntry | undefined {
  const entry = resolverCache.get(key);
  if (!entry) return undefined;
  if (Date.now() - entry.storedAt > entry.ttlMs) {
    resolverCache.delete(key);
    return undefined;
  }
  // Touch for LRU recency — re-insert moves the key to the tail.
  resolverCache.delete(key);
  resolverCache.set(key, entry);
  return entry;
}

/**
 * Write a cache entry, evicting the oldest key when at capacity.
 *
 * `ttlMs` defaults to the normal {@link CACHE_TTL_MS}. Pass
 * {@link ERROR_CACHE_TTL_MS} for results derived from a transient lookup
 * error so the next span re-queries instead of serving a stale empty-env for
 * a full minute.
 */
function writeCache(
  key: string,
  value: ResolvedEnvironment | null,
  ttlMs: number = CACHE_TTL_MS,
  transientError: boolean = false,
): void {
  if (resolverCache.size >= CACHE_MAX_ENTRIES && !resolverCache.has(key)) {
    // Map iteration order is insertion order — the first key is the oldest.
    const oldest = resolverCache.keys().next().value;
    if (oldest !== undefined) {
      resolverCache.delete(oldest);
    }
  }
  resolverCache.set(key, { value, storedAt: Date.now(), ttlMs, transientError });
}

/**
 * Test-only — clears the resolver cache so tests do not leak state.
 * Not exported through the package index; import directly in tests.
 */
export function __clearEnvironmentResolverCache(): void {
  resolverCache.clear();
}

/**
 * Shape of the `api_key` → `environment` join row. The gateway's generated
 * `Database` types do not yet include the `environment` table or
 * `api_key.environment_id` (codegen pending — same situation as
 * `openapi/routes/environments.ts`), so the query is issued through an
 * `as any`-cast client and the result is narrowed against this interface.
 *
 * The "pinned commit" for trace/score stamping is read straight from
 * `environment.current_commit_sha` — the denormalized column advanced by
 * `advanceCommitPointers` on link / push / resync. (The old
 * `latest_deployment_id` FK join was dropped when deployment-row writes
 * were removed from the git-flow path, so that join went stale.)
 */
interface EnvironmentRow {
  id: string;
  name: string;
  is_default: boolean;
  current_version: number | null;
  is_ephemeral: boolean | null;
  current_commit_sha: string | null;
}

interface ApiKeyEnvironmentJoinRow {
  environment_id: string | null;
  environment: EnvironmentRow | null;
}

/** Columns selected for an environment row in both resolution paths. */
const ENVIRONMENT_SELECT =
  'id, name, is_default, current_version, is_ephemeral, current_commit_sha';

/** Map a raw `environment` row to the resolver's public shape. */
function mapEnvironmentRow(env: EnvironmentRow): ResolvedEnvironment {
  return {
    id: env.id,
    name: env.name,
    isDefault: env.is_default,
    // current_version is the monotonic saga counter; 0 means "no successful
    // saga deployment yet", which is the same state callers read as an
    // absent pin. Translate 0 → null so callers that check
    // `pinned_version != null` to distinguish pinned vs unpinned still work.
    pinned_version: env.current_version || null,
    pinned_commit_sha: env.current_commit_sha ?? null,
    targetKind: envTargetOf({
      current_version: env.current_version ?? 0,
      is_ephemeral: env.is_ephemeral,
    }),
  };
}

/**
 * Resolve the environment bound to an API key.
 *
 * @param params.supabase  A Supabase client. The gateway passes its
 *   service-role admin client — this lookup needs to read `api_key` /
 *   `environment` regardless of the request's gateway-role grants, and tenant
 *   safety is enforced by the explicit `tenant_id` filter below rather than by
 *   RLS.
 * @param params.apiKeyId  The Unkey `keyId` — equals `api_key.api_key_id`.
 *   `undefined` for bearer-auth requests (no API key); resolves to the
 *   {@link NO_ENVIRONMENT} sentinel.
 * @param params.tenantId  The JWT-verified tenant id from `c.get('user')`.
 *   Always applied as a filter so a key id cannot resolve a foreign env.
 *
 * @returns The {@link ResolvedEnvironment}, or {@link NO_ENVIRONMENT} (`null`)
 *   for legacy / no-binding / revoked / error cases.
 */
export async function resolveEnvironmentFromApiKey(params: {
  supabase: SupabaseClient;
  apiKeyId: string | undefined;
  tenantId: string;
  /**
   * The environment id carried in the verified Unkey token meta
   * (`user.environmentId`). When present, the resolver reads the environment
   * directly by id (meta path) and never touches `api_key`. When absent — a
   * legacy key minted before env was carried in meta — it falls back to the
   * `api_key`-by-`api_key_id` join. Always tenant-scoped either way.
   */
  environmentIdFromToken?: string;
  /**
   * Fail CLOSED on transient lookup errors. When true, a DB error or thrown
   * client (network blip) causes the function to throw
   * {@link EnvironmentResolutionError} instead of returning
   * {@link NO_ENVIRONMENT}. Read-side callers (`resolveEnvScope`) pass true
   * so an env-bound key never silently degrades to cross-env access on a
   * transient failure. Write-side callers (span/score ingestion) default to
   * fail-open so a DB blip falls back to empty-env stamping instead of
   * dropping the ingest.
   *
   * Cache semantics: cached transient-error entries (from prior fail-open
   * calls) also cause fail-closed callers to throw — a fail-open caller
   * cannot poison a subsequent fail-closed caller via the shared cache.
   */
  failClosed?: boolean;
}): Promise<ResolvedEnvironment | null> {
  const {
    supabase,
    apiKeyId,
    tenantId,
    environmentIdFromToken,
    failClosed = false,
  } = params;

  // Bearer auth (or any path without a credential) has no env binding. A token
  // carrying an env id always also carries an apiKeyId, so guarding on apiKeyId
  // still admits the meta path.
  if (!apiKeyId || !tenantId) {
    return NO_ENVIRONMENT;
  }

  // Meta path keys the cache by env id; fallback keys by api key id. Namespaced
  // (`env:` vs `key:`) so the two resolution strategies never collide.
  const key = environmentIdFromToken
    ? cacheKey(tenantId, environmentIdFromToken, 'env')
    : cacheKey(tenantId, apiKeyId, 'key');
  const cached = readCache(key);
  if (cached) {
    if (cached.transientError && failClosed) {
      throw new EnvironmentResolutionError(
        'cached transient env-resolution error; fail-closed caller cannot use stale empty-env',
      );
    }
    return cached.value;
  }

  let resolved: ResolvedEnvironment | null = NO_ENVIRONMENT;
  // Distinguishes a genuine miss (row absent — cache for the full TTL, this is
  // the revocation steady state) from a transient error (DB threw —
  // cache only briefly so the next span re-queries instead of serving a stale
  // empty-env for a full minute).
  let transientError = false;
  let lookupCause: unknown = undefined;
  try {
    // The generated types lack feature-054's `environment` table /
    // `api_key.environment_id`, so the client is cast loose for both queries.
    const client = asServiceClient(supabase);
    let envRow: EnvironmentRow | null = null;
    let lookupError: unknown = null;

    if (environmentIdFromToken) {
      // META PATH — env id from the verified token. Resolve the environment
      // directly; no `api_key` row required. Tenant-scoped so a forged token
      // env id cannot resolve another tenant's environment.
      const { data, error } = await client
        .from('environment')
        .select(ENVIRONMENT_SELECT)
        .eq('id', environmentIdFromToken)
        .eq('tenant_id', tenantId)
        .maybeSingle();
      lookupError = error;
      envRow = (data as EnvironmentRow | null) ?? null;
    } else {
      // FALLBACK PATH — legacy key with no env in meta. Resolve via the
      // `api_key.environment_id` join, keyed by the Unkey keyId. `environment`
      // is an embedded resource via the FK.
      const { data, error } = await client
        .from('api_key')
        .select(
          `environment_id, environment:environment_id ( ${ENVIRONMENT_SELECT} )`,
        )
        .eq('api_key_id', apiKeyId)
        .eq('tenant_id', tenantId)
        .maybeSingle();
      lookupError = error;
      const row = (data as ApiKeyEnvironmentJoinRow | null) ?? null;
      envRow = row?.environment ?? null;
    }

    if (lookupError) {
      console.error('[environment-resolver] env lookup failed', lookupError);
      resolved = NO_ENVIRONMENT;
      transientError = true;
      lookupCause = lookupError;
    } else if (envRow) {
      resolved = mapEnvironmentRow(envRow);
    } else {
      // Legacy / no-binding / revoked key, or a CASCADE-deleted env —
      // a genuine miss, cached normally.
      resolved = NO_ENVIRONMENT;
    }
  } catch (err) {
    console.error('[environment-resolver] unexpected lookup error', err);
    resolved = NO_ENVIRONMENT;
    transientError = true;
    lookupCause = err;
  }

  // Cache hits + genuine misses for the full TTL; cache transient-error
  // results only briefly (~2s) so a momentary DB blip cannot degrade env
  // stamping for the full 60s window. We still cache the transient-error
  // result so fail-open callers don't hammer the DB — but the `transientError`
  // flag lets fail-closed callers re-throw on subsequent cache hits.
  writeCache(
    key,
    resolved,
    transientError ? ERROR_CACHE_TTL_MS : CACHE_TTL_MS,
    transientError,
  );

  if (transientError && failClosed) {
    throw new EnvironmentResolutionError(
      'env resolution failed for env-bound key',
      { cause: lookupCause },
    );
  }
  return resolved;
}

/** Outcome of a per-request env selection against a kind-scoped key. */
export interface SelectorResolution {
  /** The resolved environment, or null if the selector matched no env. */
  env: ResolvedEnvironment | null;
  /** True only when an env was found AND its kind is in the key's
   *  `allowed_env_kinds`. Callers MUST NOT stamp `env` unless this is true. */
  authorized: boolean;
}

/**
 * Resolve a per-request environment SELECTION (by name or PR number) for a
 * kind-scoped key, and authorize it against the key's `allowed_env_kinds`.
 *
 * This is the decoupled path: instead of the key being pinned to one env, the
 * request names the env (or the PR whose preview env it targets) and the
 * gateway checks that env's KIND is one the key is allowed to write to. A
 * preview-only CI key (`['preview']`) selecting `production` resolves the env
 * but comes back `authorized: false`.
 *
 * A selector is only honored when the key carries `allowedEnvKinds`; a purely
 * pinned key returns `{ env: null, authorized: false }` so the caller falls
 * back to {@link resolveEnvironmentFromApiKey} (the pin).
 *
 * Tenant- AND app-scoped: the env must belong to the key's app, so a selector
 * can never reach another app's (or tenant's) environment.
 */
export async function resolveEnvironmentForSelector(params: {
  supabase: SupabaseClient;
  appId: string;
  tenantId: string;
  selector: { envName?: string; prNumber?: number };
  allowedEnvKinds: string[] | undefined;
}): Promise<SelectorResolution> {
  const { supabase, appId, tenantId, selector, allowedEnvKinds } = params;

  if (!allowedEnvKinds || allowedEnvKinds.length === 0) {
    return { env: null, authorized: false };
  }

  const client = asServiceClient(supabase);
  let query = client
    .from('environment')
    .select(ENVIRONMENT_SELECT)
    .eq('app_id', appId)
    .eq('tenant_id', tenantId);

  if (selector.prNumber != null) {
    // The PR's ephemeral preview env. source_pr_number is unique per app.
    query = query
      .eq('source_pr_number', selector.prNumber)
      .eq('is_ephemeral', true);
  } else if (selector.envName) {
    query = query.eq('name', selector.envName);
  } else {
    return { env: null, authorized: false };
  }

  const { data, error } = await query.maybeSingle();
  if (error) {
    console.error('[environment-resolver] selector lookup failed', error);
    return { env: null, authorized: false };
  }
  if (!data) {
    return { env: null, authorized: false };
  }

  const env = mapEnvironmentRow(data as unknown as EnvironmentRow);
  const authorized =
    env.targetKind != null && allowedEnvKinds.includes(env.targetKind);
  return { env, authorized };
}

/**
 * Resolve the environment to stamp on an ingested trace from the request's
 * env-selection headers. A kind-scoped key (carrying `allowedEnvKinds`) that
 * names an env — by name, or by the PR number whose preview env it targets — is
 * authorized against its kinds; an UNAUTHORIZED selection stamps NO env rather
 * than leaking across kinds. A purely pinned key (no selector, or no
 * `allowedEnvKinds`) resolves via {@link resolveEnvironmentFromApiKey}.
 *
 * Framework-agnostic (takes raw header strings, not the request object) so the
 * trace route stays a thin caller and this branch logic stays unit-testable.
 */
export async function resolveIngestEnvironment(params: {
  supabase: SupabaseClient;
  user: {
    appId: string;
    tenantId: string;
    apiKeyId?: string;
    environmentId?: string;
    allowedEnvKinds?: string[];
  };
  envNameHeader?: string;
  prNumberHeader?: string;
}): Promise<ResolvedEnvironment | null> {
  const { supabase, user, envNameHeader, prNumberHeader } = params;
  const selEnvName = envNameHeader || undefined;
  const selPrNumber = prNumberHeader != null ? Number(prNumberHeader) : NaN;
  const hasSelector = selEnvName != null || Number.isFinite(selPrNumber);

  if (hasSelector && user.allowedEnvKinds && user.allowedEnvKinds.length > 0) {
    const sel = await resolveEnvironmentForSelector({
      supabase,
      appId: user.appId,
      tenantId: user.tenantId,
      selector: {
        envName: selEnvName,
        prNumber: Number.isFinite(selPrNumber) ? selPrNumber : undefined,
      },
      allowedEnvKinds: user.allowedEnvKinds,
    });
    if (sel.authorized) return sel.env;
    console.warn(
      '[traces] env selector not authorized for key; stamping no-env',
      { appId: user.appId, selEnvName, selPrNumber },
    );
    return null;
  }

  return resolveEnvironmentFromApiKey({
    supabase,
    apiKeyId: user.apiKeyId,
    tenantId: user.tenantId,
    environmentIdFromToken: user.environmentId,
  });
}
