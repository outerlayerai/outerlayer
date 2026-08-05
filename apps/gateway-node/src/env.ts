/**
 * Self-host boot gate — environment validation for the `gateway-node` runtime.
 *
 * This runs ONCE at process start (before the Hono app or the cron scheduler
 * come up) and fails fast with an exhaustive, human-readable list of every
 * missing/invalid variable, so an operator fixes their `.env` in one pass
 * instead of discovering problems one 500 at a time.
 *
 * It layers self-host requirements on top of the shared `EnvSchema`
 * (`@repo/gateway-core/types`), which is authored for the hosted Cloudflare
 * Worker. Two deliberate differences from that base schema:
 *
 *   1. **S3 blob storage is REQUIRED.** The base schema leaves the blob backend
 *      optional and defaults to the Cloudflare R2 binding (`TRACE_BLOBS`). The
 *      Node runtime has no R2, so self-host MUST set `BLOB_STORAGE_BACKEND=s3`
 *      and point the `BLOB_S3_*` connection at an S3-compatible store (MinIO /
 *      AWS S3 / Supabase Storage). See `apps/gateway-node/minio/docker-compose.yml`.
 *
 *   2. **Hosted-only secrets are NOT required.** Unkey, Stripe, the Cloudflare
 *      account keys/bindings, and GitHub/Fly are all irrelevant to a
 *      self-host deploy: the Node entrypoint injects its own adapters (no
 *      Unkey keystore, no Stripe billing, no Fly machines). We therefore
 *      ignore base-schema failures for those keys and validate only the
 *      subset the self-host runtime actually consumes — the Supabase +
 *      ClickHouse connection, and the S3 blob store.
 */
import type { Env } from "@repo/gateway-core/types";
import { EnvSchema, withSupabaseKeyAliases } from "@repo/gateway-core/types";

/**
 * Keys from the shared `EnvSchema` that the self-host runtime genuinely needs.
 * A base-schema validation issue is surfaced only when it concerns one of these
 * — every other required-in-hosted key (Unkey, Cloudflare, GitHub, Fly,
 * Stripe, builder secrets, …) is intentionally not required here.
 */
const SELF_HOST_BASE_KEYS = new Set<string>([
  // Supabase — Postgres connection + JWT verification + scoped clients.
  "SUPABASE_API_BASE_URL",
  "SUPABASE_SECRET_KEY",
  "SUPABASE_JWT_SECRET",
  "SUPABASE_PUBLISHABLE_KEY",
  // ClickHouse — analytics store the gateway reads/writes traces + scores to.
  // (CLICKHOUSE_READ_USER / CLICKHOUSE_READ_PASSWORD and CLICKHOUSE_WRITE_USER /
  // CLICKHOUSE_WRITE_PASSWORD are supported but OPTIONAL — schema-level
  // optionals flow through this validator without being required. Without the
  // read pair the analytics factory warns that reads run as the writer
  // identity and the row-policy layer is inert; without the write pair the
  // data plane authenticates as the historical `default` identity.)
  "CLICKHOUSE_HOST",
  "CLICKHOUSE_PASSWORD",
]);

/** The four S3 connection vars every self-host deploy must set (non-empty). */
const REQUIRED_S3_KEYS = [
  "BLOB_S3_ENDPOINT",
  "BLOB_S3_ACCESS_KEY_ID",
  "BLOB_S3_SECRET_ACCESS_KEY",
  "BLOB_S3_BUCKET",
] as const;

/**
 * Shortest secret worth calling one. An API-key-equivalent bearer token that a
 * reachable gateway accepts is online-guessable, so a handful of characters is
 * not a control.
 */
const MIN_GATEWAY_SECRET_LENGTH = 32;

/**
 * Validate the process environment for the self-host Node runtime.
 *
 * On any failure this prints one line per problem to stderr and calls
 * `process.exit(1)` — it never throws an opaque error. On success it returns
 * the validated, typed environment.
 */
export function loadEnv(): Env {
  const errors: string[] = [];

  // Accept legacy-named Supabase key secrets until every deploy sets the new
  // names — copy them onto their new fields before validation so a legacy-only
  // .env passes and downstream code reads only the new fields.
  withSupabaseKeyAliases(process.env);

  // 1) Run the shared schema, but keep only the issues that concern the keys
  //    self-host actually uses (Supabase + ClickHouse). Failures for hosted-only
  //    secrets (Unkey/Cloudflare/GitHub/Fly/Stripe/builder) are dropped.
  const parsed = EnvSchema.safeParse(process.env);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      const key = String(issue.path[0] ?? "");
      if (SELF_HOST_BASE_KEYS.has(key)) {
        errors.push(`  - ${key}: ${issue.message}`);
      }
    }
  }

  // 2) Enforce the S3 blob backend on top of the base schema (base leaves it
  //    optional / R2-default; the Node runtime has no R2).
  const backend = process.env.BLOB_STORAGE_BACKEND;
  if (backend !== "s3") {
    const got = backend && backend.length > 0 ? `"${backend}"` : "unset";
    errors.push(
      `  - BLOB_STORAGE_BACKEND: must be "s3" for self-host (got ${got}). ` +
        `The Node runtime has no Cloudflare R2 — use S3-compatible storage ` +
        `(MinIO / AWS S3 / Supabase Storage). ` +
        `See apps/gateway-node/minio/docker-compose.yml for a local MinIO.`
    );
  }

  // 3) The four S3 connection vars must all be present and non-empty.
  for (const key of REQUIRED_S3_KEYS) {
    const value = process.env[key];
    if (!value || value.trim() === "") {
      errors.push(`  - ${key}: required (non-empty) for self-host S3 blob storage`);
    }
  }

  // 4) API-key auth posture. There is no key store here, so the operator must
  //    state how programmatic callers are authenticated: with a shared secret
  //    the gateway checks, or at a network perimeter they maintain themselves.
  //    Neither set is not a default worth having — it silently means "anyone who
  //    reaches this port and knows an app id has full access to that tenant".
  const gatewaySecret = process.env.SELF_HOST_GATEWAY_SECRET?.trim();
  const trustsPerimeter = process.env.SELF_HOST_TRUST_PERIMETER === "true";

  if (gatewaySecret) {
    if (gatewaySecret.length < MIN_GATEWAY_SECRET_LENGTH) {
      errors.push(
        `  - SELF_HOST_GATEWAY_SECRET: must be at least ${MIN_GATEWAY_SECRET_LENGTH} ` +
          `characters (got ${gatewaySecret.length}). It is accepted as an API key by ` +
          `a reachable service, so a short value is online-guessable. ` +
          `Generate one with: openssl rand -base64 32`
      );
    }
  } else if (!trustsPerimeter) {
    errors.push(
      `  - SELF_HOST_GATEWAY_SECRET: required, OR set SELF_HOST_TRUST_PERIMETER=true.\n` +
        `      Programmatic (API-key) requests resolve their tenant from the app id in\n` +
        `      your Supabase. With neither variable set, no secret is verified: anyone\n` +
        `      who can reach this port and knows an app id gets FULL ACCESS to that\n` +
        `      tenant — including spending your LLM provider credits.\n` +
        `      Pick one:\n` +
        `        SELF_HOST_GATEWAY_SECRET=<openssl rand -base64 32>  # clients send it as their API key\n` +
        `        SELF_HOST_TRUST_PERIMETER=true                      # you authenticate callers at the network layer\n` +
        `      Human/dashboard (JWT) access is fully tenant-validated either way.`
    );
  }

  if (errors.length > 0) {
    // One clear multi-line block listing EVERY problem, then hard-exit.
    process.stderr.write(
      "gateway-node: environment validation failed. Fix the following before starting:\n" +
        errors.join("\n") +
        "\n\nSee apps/gateway-node/README.md for the full self-host runbook.\n"
    );
    process.exit(1);
  }

  // Perimeter trust is a legitimate choice, but it must never be a quiet one:
  // the operator sees this on every boot, and it lands in whatever collects the
  // process's stderr.
  if (!gatewaySecret) {
    process.stderr.write(
      "gateway-node: WARNING — API-key auth is perimeter-trust " +
        "(SELF_HOST_TRUST_PERIMETER=true).\n" +
        "  No secret is verified on programmatic requests: any caller that reaches\n" +
        "  this port and knows an app id has full access to that tenant. Keep this\n" +
        "  gateway on a private network / behind authenticating ingress, or set\n" +
        "  SELF_HOST_GATEWAY_SECRET instead.\n"
    );
  }

  // Validation passed. The Env type also spans the Cloudflare runtime bindings
  // (queues, DOs, R2) that the Node composition root injects via its own
  // adapters — those are not string env vars — so the validated string env is
  // returned as Env.
  return process.env as unknown as Env;
}
