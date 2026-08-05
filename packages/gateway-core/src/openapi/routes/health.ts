/**
 * Health OpenAPI Routes
 *
 * Endpoints for health checks and connectivity status.
 */

import { z, BaseRoute, type AppContext } from './_shared';
import { EnvSchema } from '../../types';
import { getRequiredEnvKeys } from '../required-env';
import { createHealthService } from '../../services/health';
import { STATUS_CODE_MAP } from '../../types/health';

// ---------------------------------------------------------------------------
// Shared constants + schemas
// ---------------------------------------------------------------------------

/**
 * Cache-Control header for health endpoints (10 second TTL).
 * Applies to /health, /v1/health/ingestion, and /v1/health/files — all have
 * the same caching contract (short TTL so monitoring tools see fresh data
 * but bursts of probes don't re-run the full check).
 */
const HEALTH_CACHE_CONTROL = 'public, max-age=10, s-maxage=10';

/**
 * Zod schema for a single dependency entry in a ComponentHealth response.
 * Mirrors DependencyHealth in types/health.ts — declared here (rather than
 * reusing the runtime Zod schema from types/health.ts) to avoid pulling the
 * runtime schema into the chanfana OpenAPI route class.
 */
const DependencyHealthSchema = z.object({
  name: z.string(),
  status: z.enum(['healthy', 'unhealthy']),
  latencyMs: z.number().optional(),
  error: z.string().optional(),
});

/**
 * Top-level response schema for ComponentHealth-shaped health endpoints
 * (/v1/health/ingestion + /v1/health/files). Shape preserves the legacy
 * ComponentHealth contract exactly — external monitors and the CD
 * health-check action read `.status` at the top level, and downstream
 * consumers can parse `.dependencies[]` for per-dep latency + error.
 */
const ComponentHealthResponseSchema = z.object({
  status: z.enum(['healthy', 'degraded', 'unhealthy']),
  component: z.string(),
  timestamp: z.string().datetime(),
  dependencies: z.array(DependencyHealthSchema),
});

// ---------------------------------------------------------------------------
// GET /health
// ---------------------------------------------------------------------------

/**
 * The runtime-agnostic required-env base: the ONLY keys that BOTH the hosted
 * Cloudflare Worker and the Node self-host runtime must have. Core cannot
 * function without Supabase (auth/db), ClickHouse (analytics), and a known
 * NODE_ENV — everything else in `EnvSchema` (Unkey, Cloudflare, Fly, GitHub,
 * OTel, encryption/OAuth secrets, …) is HOSTED-ONLY and is now an
 * ENTRYPOINT responsibility, declared per-runtime via `setRequiredEnvKeys`.
 *
 * `/health` checks this agnostic base with a picked sub-schema (so the format
 * constraints for these keys — e.g. SUPABASE_API_BASE_URL must be a URL — are
 * preserved), then unions the entrypoint-declared extras on top. The Node
 * self-host entry declares no extras and so reports healthy without any of the
 * hosted-only secrets it will never have; the Worker declares them all (see
 * apps/gateway/src/index.ts) so its `/health` stays exactly as strict as when
 * the full `EnvSchema` was the required-key check.
 */
const AGNOSTIC_REQUIRED_ENV = EnvSchema.pick({
  CLICKHOUSE_HOST: true,
  SUPABASE_API_BASE_URL: true,
  SUPABASE_SECRET_KEY: true,
  SUPABASE_JWT_SECRET: true,
  SUPABASE_PUBLISHABLE_KEY: true,
  NODE_ENV: true,
});

export class HealthCheck extends BaseRoute {
  schema = {
    tags: ['Health'],
    summary: 'Service health',
    operationId: 'service-health',
    description:
      'Check if the gateway service is running. Returns healthy if all required\nenvironment variables are configured.',
    security: [],
    responses: {
      200: {
        description: 'Service is healthy.',
        content: {
          'application/json': {
            schema: z.object({
              status: z.literal('healthy'),
              timestamp: z.string().datetime(),
            }),
          },
        },
      },
      500: {
        description: 'Service is unhealthy.',
        content: {
          'application/json': {
            schema: z.object({
              status: z.literal('unhealthy'),
              error: z.string(),
              /**
               * How many required variables are unset — deliberately a count,
               * not their names, because this route is unauthenticated
               * (`security: []`). Operators read the names from the logs.
               */
              missing_count: z.number().int().positive(),
              timestamp: z.string().datetime(),
            }),
          },
        },
      },
    },
  };

  async handle(c: AppContext) {
    // Check only the runtime-agnostic required base (see AGNOSTIC_REQUIRED_ENV) —
    // NOT the full EnvSchema. The full schema requires hosted-only keys the Node
    // self-host runtime never has, which would leave Node permanently unhealthy.
    const result = AGNOSTIC_REQUIRED_ENV.safeParse(c.env);
    const schemaMissing = result.success
      ? []
      : result.error.issues.map((issue) => issue.path.join('.'));

    // Env the active entrypoint additionally requires beyond the agnostic base —
    // the hosted Worker declares all the hosted-only keys (Stripe, Unkey,
    // Cloudflare, Fly, GitHub, OTel, secrets…), the node self-host entry
    // declares none. Kept out of the agnostic base so the node runtime isn't
    // forced to set them (see openapi/required-env.ts).
    // Validate each entrypoint-declared key against its EnvSchema field
    // validator, not just truthiness — a present-but-malformed value (e.g. a
    // non-URL where a URL is required) must still fail /health, matching the
    // strictness the full EnvSchema.safeParse gave before the agnostic-base
    // split. These keys are `.optional()` in the shared schema (so it stays
    // runtime-agnostic), so presence is checked explicitly and format via the
    // field; a key with no EnvSchema field falls back to a presence check.
    const env = c.env as Record<string, unknown>;
    const shape = EnvSchema.shape as Record<string, z.ZodTypeAny>;
    const entrypointMissing = getRequiredEnvKeys().filter((key) => {
      const value = env[key];
      if (!value) return true;
      const field = shape[key];
      return field ? !field.safeParse(value).success : false;
    });

    const missing = [...new Set([...schemaMissing, ...entrypointMissing])];

    if (missing.length === 0) {
      return c.json(
        { status: 'healthy' as const, timestamp: new Date().toISOString() },
        200,
        { 'Cache-Control': HEALTH_CACHE_CONTROL },
      );
    }

    // The names go to the logs, not the response body: this route is
    // unauthenticated, and the detail is only useful to an operator.
    console.error(
      `[health] missing required environment variables: ${missing.join(', ')}. ` +
        'Configure at: Cloudflare Dashboard \u2192 Workers & Pages \u2192 gateway \u2192 Settings \u2192 Variables',
    );

    return c.json(
      {
        status: 'unhealthy' as const,
        error: 'Missing environment variables',
        missing_count: missing.length,
        timestamp: new Date().toISOString(),
      },
      500,
      { 'Cache-Control': 'no-store' },
    );
  }
}

// ---------------------------------------------------------------------------
// GET /v1/health/ingestion
// ---------------------------------------------------------------------------

export class IngestionHealth extends BaseRoute {
  schema = {
    tags: ['Health'],
    summary: 'Ingestion health',
    operationId: 'ingestion-health',
    description: 'Check the health of the trace ingestion pipeline and its dependencies.',
    security: [],
    responses: {
      200: {
        description: 'Ingestion pipeline is healthy or degraded.',
        content: {
          'application/json': {
            schema: ComponentHealthResponseSchema,
          },
        },
      },
      503: {
        description: 'Ingestion pipeline is unhealthy.',
        content: {
          'application/json': {
            schema: ComponentHealthResponseSchema,
          },
        },
      },
    },
  };

  async handle(c: AppContext) {
    const healthService = createHealthService({
      clickhouseHost: c.env.CLICKHOUSE_HOST,
      clickhouseUsername: c.env.CLICKHOUSE_WRITE_USER,
      clickhousePassword:
        (c.env.CLICKHOUSE_WRITE_USER
          ? c.env.CLICKHOUSE_WRITE_PASSWORD
          : c.env.CLICKHOUSE_PASSWORD) ?? '',
      supabaseUrl: c.env.SUPABASE_API_BASE_URL,
      supabaseKey: c.env.SUPABASE_SECRET_KEY,
      isProduction: c.env.NODE_ENV === 'production',
    });

    const health = await healthService.checkIngestion();
    const statusCode = STATUS_CODE_MAP[health.status];

    return c.json(health, statusCode, { 'Cache-Control': HEALTH_CACHE_CONTROL });
  }
}

// ---------------------------------------------------------------------------
// GET /v1/health/files
// ---------------------------------------------------------------------------

export class FilesHealth extends BaseRoute {
  schema = {
    tags: ['Health'],
    summary: 'Files health',
    operationId: 'files-health',
    description: 'Check the health of the files service and its dependencies.',
    security: [],
    responses: {
      200: {
        description: 'Files service is healthy or degraded.',
        content: {
          'application/json': {
            schema: ComponentHealthResponseSchema,
          },
        },
      },
      503: {
        description: 'Files service is unhealthy.',
        content: {
          'application/json': {
            schema: ComponentHealthResponseSchema,
          },
        },
      },
    },
  };

  async handle(c: AppContext) {
    const healthService = createHealthService({
      clickhouseHost: c.env.CLICKHOUSE_HOST,
      clickhouseUsername: c.env.CLICKHOUSE_WRITE_USER,
      clickhousePassword:
        (c.env.CLICKHOUSE_WRITE_USER
          ? c.env.CLICKHOUSE_WRITE_PASSWORD
          : c.env.CLICKHOUSE_PASSWORD) ?? '',
      supabaseUrl: c.env.SUPABASE_API_BASE_URL,
      supabaseKey: c.env.SUPABASE_SECRET_KEY,
      isProduction: c.env.NODE_ENV === 'production',
    });

    const health = await healthService.checkFiles();
    const statusCode = STATUS_CODE_MAP[health.status];

    return c.json(health, statusCode, { 'Cache-Control': HEALTH_CACHE_CONTROL });
  }
}
