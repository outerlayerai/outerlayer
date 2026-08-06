import { Cache } from "@unkey/cache";
import { z } from "zod";
import type { GatewayContext } from "./runtime/gateway-context";
import type {
  ExecutionCtx,
  QueueBatchProducer,
  BlobBucket,
  CronEvent,
} from "./runtime";

/**
 * The environment bound to an API key, resolved by
 * `lib/environment-resolver.ts`. Stamped onto every ingested
 * trace / score row. `undefined` for legacy / bearer-auth / no-binding
 * ingest — stamping then falls back to `''` / `0`.
 */
export type ResolvedEnvironmentMeta = {
  /** Environment UUID (snapshot-serving routes). Populated when
   *  resolved from `api_key.environment_id`; may be absent on legacy / bearer-auth
   *  paths or in older tests that predate environment resolution. */
  id?: string;
  name: string;
  pinned_version: number | null;
  pinned_commit_sha: string | null;
};

export type UserMeta = {
  appId: string;
  stripeCustomerId: string;
  stripeSubscriptionId: string;
  tenantId: string;
  appName: string;
  branchId: string;
  gatewayUserId?: string;
  permissions?: string[];
  /**
   * The Unkey `keyId` of the API key used to authenticate this request —
   * equals `api_key.api_key_id`. Populated only on the api-key auth path;
   * `undefined` for bearer auth. The env resolver looks the bound
   * environment up by this id.
   */
  apiKeyId?: string;
  /**
   * Developer-seat attribution (actor-scoped keys). The membership id
   * the key is bound to; the agent-session sync endpoint stamps it onto every
   * ingested row as ActorId. Absent on shared/app keys and bearer auth.
   */
  actorMembershipId?: string;
  /**
   * The environment id the key is bound to, read straight from the Unkey token
   * meta at auth time (feature: env-binding-in-token). This is the resolver's
   * INPUT — distinct from {@link resolvedEnv}, the resolved OUTPUT. `undefined`
   * for bearer auth and for legacy keys minted before env was carried in meta
   * (those resolve via the `api_key`-row fallback).
   */
  environmentId?: string;
  /**
   * The environment KINDS this key may target when a request selects an env by
   * name/PR (feature: env-kind-scoped keys). Read from the Unkey token meta at
   * auth time. Absent on a legacy pinned key — its env comes from
   * {@link environmentId} / the `api_key` row instead.
   */
  allowedEnvKinds?: string[];
  /**
   * The environment bound to {@link apiKeyId}, resolved + attached by the
   * trace/score ingest routes. Not set by auth — the ingest
   * handler resolves it and attaches it before converting spans/scores.
   */
  resolvedEnv?: ResolvedEnvironmentMeta;
};

/**
 * Schema for validating required environment variables.
 * This ensures all required secrets are configured in Cloudflare.
 *
 * Configure at: Cloudflare Dashboard → Workers & Pages → gateway → Settings → Variables
 */
/**
 * The slice of a Cloudflare KV namespace the pricing refresh needs. Declared
 * structurally rather than importing @cloudflare/workers-types so gateway-core
 * stays runtime-agnostic (it also builds for node self-host and tests).
 */
export interface ModelRegistryKV {
  get(key: string, type?: "text"): Promise<string | null>;
}

export const EnvSchema = z.object({
  // Unkey — root key for the burst rate limiter (ratelimit API only); key
  // verify/create/revoke live in the Postgres key-store.
  UNKEY_API_KEY: z.string().min(1, "Unkey API key is required"),

  // ClickHouse (analytics)
  CLICKHOUSE_HOST: z.string().min(1, "ClickHouse host is required"),
  // Empty string is allowed: the local integration-tests ClickHouse
  // container (apps/integration-tests/clickhouse/docker-compose.yml)
  // runs with no password set — the `default` user accepts empty auth.
  // Hosted CH deployments (staging/production) always set a non-empty
  // value via `wrangler secret put`; that's the enforcement path for
  // real deployments.
  CLICKHOUSE_PASSWORD: z.string(),
  // Read-path identity for row-policy tenant isolation (clickhouse
  // migration 29). Optional: when unset, analytics reads fall
  // back to the writer identity and the policy layer is inert (the
  // analytics factory warns once per isolate). Set both for staging/prod
  // via `wrangler secret put`; local/CI users are provisioned by
  // ensure-read-user.mjs / setup-clickhouse.ts.
  CLICKHOUSE_READ_USER: z.string().optional(),
  CLICKHOUSE_READ_PASSWORD: z.string().optional(),
  // Self-host escape hatch: when NODE_ENV is production and the read user is
  // unset, the analytics factory throws rather than silently downgrading to
  // the writer identity. Set this to accept app-layer-only tenant isolation.
  CLICKHOUSE_ALLOW_UNSCOPED_READS: z.string().optional(),
  // Write-path identity for least-privilege ingest / mutation / server reads
  // (clickhouse migration 47 — role `analytics_writer`, data-plane DML only).
  // Optional: when unset, writes fall back to the historical `default`
  // superuser identity via CLICKHOUSE_PASSWORD (bare self-host, local dev /
  // CI before the user is provisioned). Set both for staging/prod via
  // `wrangler secret put`; local/CI users are provisioned by
  // ensure-write-user.mjs / setup-clickhouse.ts.
  CLICKHOUSE_WRITE_USER: z.string().optional(),
  CLICKHOUSE_WRITE_PASSWORD: z.string().optional(),

  // Stripe — optional in the shared schema because billing is a property of the
  // ENTRYPOINT, not an env flag: the Cloudflare Worker root always injects
  // `StripeBillingService` (metering + storage-cap), the node self-host root
  // always injects `SelfHostBillingService` (a no-op). The node runtime shares
  // this schema and must not require Stripe secrets, so the "hosted requires
  // Stripe" assertion lives at the Worker entrypoint, not here.
  STRIPE_SPAN_METER_KEY: z.string().optional(),
  STRIPE_STORAGE_METER_KEY: z.string().optional(),
  STRIPE_STORAGE_METER_ID: z.string().optional(),
  STRIPE_SECRET_KEY: z.string().optional(),

  // Cloudflare
  CLOUDFLARE_ZONE_ID: z.string().min(1, "Cloudflare zone ID is required"),
  CLOUDFLARE_API_KEY: z.string().min(1, "Cloudflare API key is required"),
  CLOUDFLARE_CACHE_DOMAIN: z.string().min(1, "Cloudflare cache domain is required"),

  // Supabase
  SUPABASE_API_BASE_URL: z.string().url("Supabase API URL must be a valid URL"),
  // Opaque `sb_secret_…` key — runs as service_role (BYPASSRLS). Deliberately
  // no `sb_`-format assertion: a self-hoster may still pass a legacy
  // service_role value. Both key names are accepted at the env boundary via
  // `withSupabaseKeyAliases`.
  SUPABASE_SECRET_KEY: z.string().min(1, "Supabase secret key is required"),
  SUPABASE_JWT_SECRET: z.string().min(1, "Supabase JWT secret is required for gateway JWT minting"),
  // Opaque `sb_publishable_…` key — runs as anon/authenticated. Used to build
  // scoped/authenticated clients where a JWT rides the Authorization header.
  SUPABASE_PUBLISHABLE_KEY: z.string().min(1, "Supabase publishable key is required for scoped clients"),

  // App config
  DASHBOARD_BASE_URL: z.string().url("Dashboard base URL must be a valid URL"),

  /**
   * Self-host deployment flag — the exact string `'true'`, set by the
   * self-host compose/runbook and never by the Cloud worker. When set,
   * entitlement resolution skips billing entirely: numeric quotas unlimited,
   * non-EE booleans on (lib/entitlements.ts + @repo/ee-license). Anything
   * else — unset, `'1'`, `'TRUE'` — resolves as Cloud, so a typo can never
   * grant unlimited entitlements.
   */
  OUTERLAYER_SELF_HOSTED: z.string().optional(),

  // GitHub App
  GITHUB_APP_ID: z.string().min(1, "GitHub App ID is required"),
  GITHUB_APP_PRIVATE_KEY: z.string().min(1, "GitHub App private key is required"),
  // NB: the App's public *slug* (github.com/apps/<slug>) is intentionally
  // NOT an env var — it's derived at runtime from GET /app so it can't
  // drift from the real App. See lib/github-app-slug.ts.

  /**
   * HMAC key for signing the git-connect OAuth state token. Verified by
   * the dashboard OAuth callback before persisting the connection.
   * `wrangler secret put OAUTH_STATE_SECRET`. Used by
   * `POST /v1/apps/:appId/git/connect`. The dashboard's OAuth callback
   * (a separate change) reads the same secret to verify the signature.
   */
  OAUTH_STATE_SECRET: z.string().min(32, "OAuth state secret must be at least 32 characters"),

  // Security
  TOKEN_ENCRYPTION_KEY: z.string().min(32, "Token encryption key must be at least 32 characters"),

  // Environment & Observability
  NODE_ENV: z.enum(["development", "staging", "production"]),
  // Log shipping (BetterStack/Logtail). Optional: the logger ships structured
  // logs to BetterStack only when BOTH are set (see services/logger.ts), and
  // falls back to console-only otherwise — so a self-host deploy with no logs
  // vendor still boots and passes /health. Always log to console regardless;
  // BetterStack is operator convenience, not a runtime dependency.
  BETTERSTACK_LOGS_TOKEN: z.string().optional(),
  BETTERSTACK_INGESTING_URL: z.string().optional(),
  // Error reporting (Sentry-compatible DSN). Optional so reporting can be turned
  // off (no-op) or pointed at a self-hosted backend. Prefer the vendor-neutral
  // ERROR_REPORTING_* names; BETTERSTACK_ERRORS_DSN is honored as a deprecated
  // fallback. Resolved by resolveErrorReportingConfig (@repo/error-reporting-core).
  ERROR_REPORTING_DSN: z.string().optional(),
  ERROR_REPORTING_ENABLED: z.string().optional(),
  ERROR_REPORTING_BACKEND: z.string().optional(),
  /** @deprecated Use ERROR_REPORTING_DSN. Kept as a fallback for one release. */
  BETTERSTACK_ERRORS_DSN: z.string().optional(),
  // Insights (trace-topics) enrichment. Default OFF — the
  // every-minute cron returns immediately unless TOPICS_ENRICHMENT_ENABLED="true".
  // All optional so existing deploys keep validating unchanged.
  TOPICS_ENRICHMENT_ENABLED: z.string().optional(),
  /** Comma-separated TenantIds allowed to enrich; empty/unset = all tenants (when enabled). */
  TOPICS_TENANT_ALLOWLIST: z.string().optional(),
  /**
   * Platform-owned Gemini API key for facet summarization + embeddings
   * (called direct from the worker). When unset — or when TOPICS_MOCK_MODEL
   * is "true" — the deterministic mock client runs instead.
   */
  GEMINI_API_KEY: z.string().optional(),
  TOPICS_MOCK_MODEL: z.string().optional(),
  /** Minutes a trace must be quiet before enrichment picks it up (completion debounce). Default 5. */
  TOPICS_DEBOUNCE_MINUTES: z.string().optional(),
  /** Max traces enriched per cron tick. Default 25 — bounds Workers CPU/IO per tick. */
  TOPICS_BATCH_LIMIT: z.string().optional(),

  // Entitlement-driven physical retention. Default OFF — the
  // daily retention cron returns immediately unless RETENTION_SWEEP_ENABLED
  // is "true". Hosted-only: the sweep resolves per-tenant
  // `data_retention_days` from billing + overrides and physically deletes
  // expired ClickHouse rows and R2 payload blobs.
  RETENTION_SWEEP_ENABLED: z.string().optional(),
  /** Max R2 objects examined per run (backlog drains across runs). Default 50000. */
  RETENTION_SWEEP_MAX_BLOB_OBJECTS: z.string().optional(),

  // Postgres API-key store pepper. HMAC-SHA256 secret the gateway
  // uses to hash an incoming key and look up its digest in private.api_key_secret.
  // Optional in the shared schema — the node self-host runtime never verifies key
  // values (SelfHostAuthResolver is perimeter-trust), so it must not require this.
  // The hosted (Cloudflare) entrypoint asserts its presence at startup; mirrors
  // the same optional-in-schema, required-at-hosted-startup pattern used for
  // the logs var.
  API_KEY_PEPPER: z.string().optional(),

  // Cloud workers — Fly Machines API credentials.
  /**
   * Fly API token for launching worker machines. Optional, and only read when
   * `CLOUD_WORKER_APP` is also set: an environment provisions no
   * infrastructure, so a deployment that never runs cloud workers needs no Fly
   * credentials at all and must not fail its `/health` probe for one.
   */
  FLY_API_TOKEN: z.string().optional(),
  /**
   * Cloud workers: the Fly app hosting worker machines. Optional
   * — when unset, /v1/workers launch routes return 503 (dispatch unconfigured);
   * reads still work. Shares FLY_API_TOKEN above.
   */
  CLOUD_WORKER_APP: z.string().optional(),
  /** Full worker image ref; defaults to the worker app's :latest registry image. */
  CLOUD_WORKER_IMAGE: z.string().optional(),
  /** Region for worker machines + persistent volumes. */
  CLOUD_WORKER_REGION: z.string().optional(),

  // PostHog (product analytics) — activation funnel events, optional
  POSTHOG_PROJECT_API_KEY: z.string().optional(),

  // Cloudflare Worker bindings (injected by runtime, not string env vars)
  /**
   * Queue producer for the Stripe usage-meter fan-out (arch #4). OPTIONAL:
   * absent on self-host (no Stripe metering at all) and in local dev without
   * queues — the cron then falls back to the inline per-customer loop.
   */
  USAGE_METER_QUEUE: z.custom<QueueBatchProducer<unknown>>().optional(),
  /**
   * Queue producer for topics-enrichment candidates (one message per newly
   * ingested trace root). OPTIONAL: absent on self-host / local dev without
   * queues — enrichment then runs purely on the scheduled scan, which stays
   * behind this queue as gap repair either way.
   */
  TOPICS_QUEUE: z.custom<QueueBatchProducer<unknown>>().optional(),
  /** R2 bucket for oversized span payloads lifted out at ingest (blob-offload) */
  TRACE_BLOBS: z.custom<BlobBucket>(),
  /**
   * KV namespace holding the model price registry (`models.json`,
   * `overrides.json`), published by the registry-sync workflow.
   *
   * OPTIONAL: the self-host runtime and local dev have no namespace bound, and
   * pricing then falls back to the snapshot bundled at build time. An absent
   * namespace is a supported configuration, not a misconfiguration.
   */
  MODEL_REGISTRY: z.custom<ModelRegistryKV>().optional(),

  // --- Self-host API-key auth ---
  // The self-host runtime has no key store: `SelfHostAuthResolver` resolves the
  // tenant from the app row. These two decide whether a caller must also present
  // a secret to do that. Optional in this schema because the hosted Worker uses
  // neither; the self-host boot gate (apps/gateway-node/src/env.ts) requires
  // exactly one of them and refuses to start otherwise.
  /**
   * Shared secret every API-key request must present as its bearer token.
   * Compared in constant time. Set this unless the gateway sits behind ingress
   * that already authenticates its callers.
   */
  SELF_HOST_GATEWAY_SECRET: z.string().optional(),
  /**
   * Explicit acknowledgement that the operator authenticates callers at the
   * network layer, so the gateway should not. `true` uses app-row-only
   * identity, which requires the gateway port to be reachable only by callers
   * the operator has already authenticated. Set SELF_HOST_GATEWAY_SECRET
   * instead to have the gateway require authentication itself. Only meaningful
   * without SELF_HOST_GATEWAY_SECRET.
   */
  SELF_HOST_TRUST_PERIMETER: z.string().optional(),

  // --- Blob storage backend (OSS migration: R2 → S3/MinIO seam) ---
  // All optional. Absent ⇒ the hosted default (R2 binding above). Self-hosters
  // with no Cloudflare account set BLOB_STORAGE_BACKEND=s3 and the BLOB_S3_*
  // connection to point at MinIO / any S3-compatible store. Resolved by
  // resolveBlobStorageConfig (src/lib/blob-storage-config.ts); the S3 adapter
  // that consumes it lands in the follow-up "R2 → MinIO adapter" PR.
  /** Selects the blob store: `r2` (default) or `s3`. */
  BLOB_STORAGE_BACKEND: z.string().optional(),
  /** S3 endpoint URL (e.g. http://127.0.0.1:9300 for local MinIO). */
  BLOB_S3_ENDPOINT: z.string().optional(),
  /** S3 region; defaults to `us-east-1` when unset. */
  BLOB_S3_REGION: z.string().optional(),
  BLOB_S3_ACCESS_KEY_ID: z.string().optional(),
  BLOB_S3_SECRET_ACCESS_KEY: z.string().optional(),
  /** Target bucket (the local/CI MinIO provisions `trace-blobs`). */
  BLOB_S3_BUCKET: z.string().optional(),
  /** Path-style addressing ("true"/"false"); defaults to true (MinIO needs it). */
  BLOB_S3_FORCE_PATH_STYLE: z.string().optional(),
});

/**
 * Environment variables and Cloudflare bindings derived from EnvSchema.
 */
export type Env = z.infer<typeof EnvSchema>;

/**
 * Accept either name for each Supabase API key secret.
 *
 * Supabase has two generations of API key: the JWT-format `anon` /
 * `service_role` pair, and the opaque `sb_publishable_…` / `sb_secret_…` pair
 * that replaced it. Deployments exist on both, so a deploy whose secrets are
 * named `SUPABASE_ANON_KEY` / `SUPABASE_SERVICE_ROLE_KEY` must keep working.
 * This copies a legacy-named value into its new field when the new name is
 * empty, so every downstream reader sees only `SUPABASE_PUBLISHABLE_KEY` /
 * `SUPABASE_SECRET_KEY` and no other code has to know both names exist.
 *
 * The fallback is falsy-tolerant, not just nullish: an empty-string placeholder
 * on the new name must not mask a populated legacy secret — a deploy that scaffolds
 * the new var as `""` while the real value still rides the legacy name resolves to
 * the legacy value. A non-empty new value always wins. Applied at each runtime's
 * env boundary (the Worker entrypoints and the Node boot loader) before validation.
 */
export function withSupabaseKeyAliases<T extends object>(env: T): T {
  const raw = env as Record<string, unknown>;
  if (!raw.SUPABASE_PUBLISHABLE_KEY && raw.SUPABASE_ANON_KEY) {
    raw.SUPABASE_PUBLISHABLE_KEY = raw.SUPABASE_ANON_KEY;
  }
  if (!raw.SUPABASE_SECRET_KEY && raw.SUPABASE_SERVICE_ROLE_KEY) {
    raw.SUPABASE_SECRET_KEY = raw.SUPABASE_SERVICE_ROLE_KEY;
  }
  return env;
}

type Context = {
  [key: string]: any;
};

export interface GatewayRequest extends Request {
  user?: UserMeta;
  context?: Context;
}

export type PricingData = {
  [modelName: string]: {
    promptPrice: number;
    completionPrice: number;
  };
};

/**
 * Feature flag data structure (mirrors tenant-dashboard)
 */
export type FeatureFlagData = {
  id: string;
  key: string;
  is_enabled: boolean;
  strategy: 'global' | 'percentage' | 'targeted';
  rollout_percentage: number;
};

/**
 * Cached feature flag with overrides
 */
export type CachedFeatureFlag = {
  flag: FeatureFlagData;
  overrides: Record<string, boolean>; // tenantId -> is_enabled
  cachedAt: number;
};

/**
 * A tenant's billing tier plus the admin override for ONE entitlement key,
 * as resolved by `resolveTierWithOverride`. `overrideLimit` is `null` when no
 * usable override row exists — distinct from `-1` (UNLIMITED), which is an
 * override that grants unlimited.
 */
export type CachedTierResolution = {
  tierId: string;
  overrideLimit: number | null;
};

export type GatewayCache = Cache<{
  userMeta: UserMeta;
  pricingData: PricingData;
  featureFlags: CachedFeatureFlag;
  /** Tier + per-key override, keyed `tenantId:entitlementKey`. */
  tenantEntitlements: CachedTierResolution;
  /** Monthly span count per tenant — the ClickHouse `COUNT(*) FINAL` result. */
  spanUsage: number;
  /** Storage-cap verdict per tenant — the Stripe usage-meter result. */
  storageCap: StorageCapCheckResult;
}>;

export type GatewayRequestContext = {
  request: GatewayRequest;
  env: Env;
  ctx: ExecutionCtx;
  cache: GatewayCache;
  body?: any;
  /** Injected runtime adapters. Optional on the base only because legacy
   * `routes`-object handlers share this type via the generic dispatcher;
   * the app.fetch composition root always supplies it. Direct-call contexts
   * (dispatch/observe) re-declare it as required. */
  gtx?: GatewayContext;
};

/**
 * Context for a legacy `routes`-map handler dispatched by the app.fetch
 * composition root, where `gtx` is REQUIRED. The typed `Routes` map (index.ts)
 * is declared in terms of this so every dispatch call site must thread `gtx` —
 * the "gtx not supplied" 500 becomes a compile error rather than a production
 * regression.
 */
export type LegacyRouteContext = GatewayRequestContext & {
  gtx: GatewayContext;
};

export type GatewayScheduleEvent = CronEvent;

// https://developers.cloudflare.com/workers/runtime-apis/handlers/scheduled/#properties
export type GatewayScheduleContext = {
  event: GatewayScheduleEvent;
  env: Env;
  ctx: {
    waitUntil: ExecutionCtx["waitUntil"];
  };
  cache: GatewayCache;
};

export type GatewayRequestHandler = (
  context: GatewayRequestContext
) => Promise<Response | void>;

// ============================================================
// Span Limit Types (001-tiered-span-limits)
// ============================================================

export type SpanLimitCheckResult = {
  allowed: boolean;
  currentCount: number;
  limit: number;
  remaining: number;
};

export type SpanLimitExceededResponse = {
  error: string;
  code: 'SPAN_LIMIT_EXCEEDED';
  currentCount: number;
  limit: number;
  upgradeUrl: string;
};

// ============================================================
// Storage Cap Types (043-storage-metering)
// ============================================================

export type StorageCapCheckResult = {
  allowed: boolean;
  currentBytes: number;
  limitBytes: number; // -1 for unlimited
  capReached: boolean;
};

export type StorageCapExceededResponse = {
  error: string;
  code: 'STORAGE_CAP_EXCEEDED';
  currentBytes: number;
  limitBytes: number;
  limitGb: number;
  upgradeUrl: string;
};
