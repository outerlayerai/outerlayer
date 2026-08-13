import { fromHono, OpenAPIRoute, ApiException, InputValidationException, MultiException } from 'chanfana';
import { Hono } from 'hono';
import { chanfanaErrorToEnvelope } from '@repo/api-schemas';
import type { BuildGatewayContext, ExecutionCtx } from '../runtime';
import { authMiddleware, type OpenAPIVariables } from './middleware';
import {
  permissionMiddleware,
  enforcePermission,
  setRoutePermission,
  type GatewayPermission,
} from '../lib/permissions';
import { enforceRateLimit } from '../lib/rate-limit';
import type { RouteRateLimit } from '../rate-limits';
import type { Env } from '../types';

// Route imports
import { SyncAgentSessions, GetAgentBlob } from './routes/agents';
import { ListSpans, SearchSpans, GetSpan, GetBlob } from './routes/spans';
import { CreateScore, CreateScoresBatch, ListScores, SearchScores, GetScore, GetScoreAggregations, GetScoreNames, DeleteScore } from './routes/scores';
import { HealthCheck, IngestionHealth, FilesHealth } from './routes/health';
import { GetCapabilities } from './routes/capabilities';
import { GetPricing } from './routes/pricing';
import { ListApiKeys, CreateApiKey, RevokeApiKey } from './routes/api-keys';
import {
  ListEnvironments,
  CreateEnvironment,
  GetEnvironment,
  DeleteEnvironment,
} from './routes/environments';
import {
  ListApps,
  CreateApp,
  GetApp,
  UpdateApp,
  DeleteApp,
  GetAppGitConnection,
  StartGitConnect,
  ListAppGitRepositories,
  ListAppGitBranches,
  LinkAppRepository,
  UnlinkAppRepository,
} from './routes/apps';
import {
  ContinueWorkerSession,
  CreateWorkerSession,
  GetWorkerRun,
  GetWorkerSession,
  LaunchWorkerRun,
} from './routes/workers';
import { countActiveEnvironmentsForTenant } from '../lib/workers';
import {
  enforceEntitlement,
  enforceQuota,
  type GatewayEntitlement,
  type GatewayNumericEntitlement,
  type QuotaUser,
  type SystemSupabase,
} from '../lib/entitlements';
import { isManagementApiPath, managementAuthGuard } from '../lib/management-auth';
import {
  ListOrgMembers,
  InviteOrgMember,
  ResendOrgMemberInvite,
  ChangeOrgMemberRole,
  RemoveOrgMember,
  ListOrgRoles,
} from './routes/management';

/**
 * Cast route subclasses to chanfana's expected type.
 * chanfana's register methods expect `typeof OpenAPIRoute` but our subclasses
 * widen the generic — this adapter bridges the variance mismatch.
 */

const R = <T>(cls: T) => cls as unknown as typeof OpenAPIRoute<any>;

/**
 * Route classes that go through permission middleware must declare the
 * permission their caller needs. This type enforces that declaration at
 * compile time: a class missing `requiredPermission` cannot be passed to
 * `registerAuthenticatedRoute()`.
 *
 * The instance type is intentionally loose — chanfana handles instantiation
 * and response handling; our only requirement is that the class carries
 * a `requiredPermission` static we can read at registration time.
 */
type AuthenticatedRouteClass = (new (...args: any[]) => any) & {
  requiredPermission: GatewayPermission;
  /**
   * Optional per-route rate limit. When present, an `enforceRateLimit` guard
   * is installed (after permission) that applies the limit via Unkey's
   * standalone, fail-open ratelimiter keyed by tenantId. Most routes omit it.
   */
  rateLimit?: RouteRateLimit;
};

type AuthenticatedRouteMethod = 'get' | 'post' | 'delete' | 'put' | 'patch';

// Create a Hono app typed with our bindings and auth variables
const app = new Hono<{ Bindings: Env; Variables: OpenAPIVariables }>();

// Sentinel header that the worker-level dispatcher in `src/index.ts` uses to
// distinguish "no OpenAPI route matched" from "OpenAPI handler returned a
// real 404" (e.g. `structuredError('trace_not_found', ...)`). Without the
// sentinel, any 404 from here would be treated as a routing miss and the
// dispatcher would discard the structured body in favour of the legacy
// `ErrorResponse` envelope — which drops the `code` field and breaks
// the canonical `{ error: { code, message } }` contract.
export const OPENAPI_NO_ROUTE_HEADER = 'X-OpenAPI-No-Route';

app.notFound((c) =>
  c.json(
    { error: { code: 'route_not_found', message: 'Route not found' } },
    404,
    { [OPENAPI_NO_ROUTE_HEADER]: '1' },
  ),
);

// Unified 4xx/5xx error handler.
//
// With `raiseOnError: true` in the Chanfana config below, validation
// failures (InputValidationException, MultiException) and any thrown
// ApiException bubble up here instead of being formatted by Chanfana's
// default `{ success: false, errors: [...] }` body. We rewrite them
// into the canonical envelope defined in @repo/api-schemas:
//
//   { error: { code, message, details? } }
//
// Validation failures (InputValidationException / MultiException of them)
// go through `chanfanaErrorToEnvelope` — the same helper OSS CLI calls
// for zod failures. Result: identical body shape across cloud and local
// dev for the same bad request — zero divergence by construction.
//
// Non-validation ApiExceptions keep the chanfana shape (rare in practice;
// they surface as generic 4xx with their own codes).
//
// Non-ApiException errors fall through to Hono's default 500 path.
app.onError((err, c) => {
  if (err instanceof InputValidationException || err instanceof MultiException) {
    const issues = err.buildResponse();
    return c.json(chanfanaErrorToEnvelope(issues), err.status as 400);
  }

  if (err instanceof ApiException) {
    const [first] = err.buildResponse();
    const code = first?.code != null ? `chanfana_${first.code}` : 'invalid_request';
    const message = first?.message ?? err.message ?? 'Invalid request';
    return c.json({ error: { code, message } }, err.status as 400);
  }

  // Unexpected non-Api error (handler crash, promise rejection, etc.).
  // Wrap in the same structured shape so consumers see ONE body format
  // for every 4xx/5xx. Logging mirrors Hono's default (console.error).
  console.error('Unhandled gateway error:', err);
  return c.json(
    { error: { code: 'internal_error', message: 'An unexpected error occurred' } },
    500,
  );
});

// Post-process the OpenAPI spec to inject cross-cutting concerns that
// Chanfana's typed config doesn't surface:
//   - `components.securitySchemes` (stripped by chanfana's `RouterOptions.schema` type)
//   - Global `security` requirement
//   - Global `security` requirement that includes app scoping
//
// Why app scoping is modeled as a security scheme: it keeps auth-aware
// tooling (including Schemathesis' ignored_auth check) aligned with the
// actual runtime contract, while avoiding duplicate docs output from also
// listing X-Outerlayer-App-Id as a normal header parameter on every route.
app.use('/v1/openapi.json', async (c, next) => {
  await next();

  const body = await c.res.text();
  const spec = JSON.parse(body);

  if (!spec.components) spec.components = {};
  spec.components.securitySchemes = {
    BearerAuth: {
      type: 'http',
      scheme: 'bearer',
      description: 'API key (sk_outerlayer_*)',
    },
    AppId: {
      type: 'apiKey',
      in: 'header',
      name: 'X-Outerlayer-App-Id',
      description: 'Application ID for tenant scoping.',
    },
    // Org-management routes (`/v1/orgs/{orgName}/...`) accept ONLY a
    // management API key (`olk_...`), never an `sk_outerlayer_*` key or a
    // Supabase session JWT — a distinct scheme from `BearerAuth` so
    // Schemathesis' `ignored_auth` check (and any SDK/doc tooling) sees the
    // real, narrower contract instead of the default one these routes
    // deliberately don't honor. Declared per-route (`security:
    // [{ ManagementApiKeyAuth: [] }]`), overriding the global requirement.
    ManagementApiKeyAuth: {
      type: 'http',
      scheme: 'bearer',
      description: 'Management API key (olk_*), scoped to one org.',
    },
  };

  spec.security = [{ BearerAuth: [], AppId: [] }];

  // Skip public routes — those declare `security: []` directly in their
  // Chanfana schema (and are registered via `registerPublicRoute`). This
  // loop adds a declared 400 Bad Request response. Chanfana auto-validates
  //      query/path/body params against the Zod schema and raises an
  //      ApiException on failure — which the gateway-wide `app.onError`
  //      handler (see top of this file) rewrites to the canonical
  //      `{ error: { code, message } }` body. Declaring 400 here once
  //      covers every route without touching 20+ files; the body shape
  //      matches OpenApiErrorResponseSchema from _shared.ts.
  const genericBadRequestResponse = {
    description: 'Invalid request parameters (validation failed).',
    content: {
      'application/json': {
        schema: {
          type: 'object',
          required: ['error'],
          properties: {
            error: {
              type: 'object',
              required: ['code', 'message'],
              properties: {
                code: { type: 'string' },
                message: { type: 'string' },
              },
            },
          },
        },
      },
    },
  };

  for (const [pathKey, pathItem] of Object.entries(spec.paths ?? {})) {
    if (!pathItem || typeof pathItem !== 'object') continue;
    if (UNAUTHENTICATED_V1_PATHS.has(pathKey)) continue;

    for (const method of ['get', 'post', 'put', 'patch', 'delete'] as const) {
      const op = (pathItem as Record<string, unknown>)[method];
      if (!op || typeof op !== 'object') continue;
      const operation = op as {
        parameters?: unknown[];
        responses?: Record<string, unknown>;
      };

      // Inject 400 response (if the route doesn't already declare a
      // more specific one — preserve per-route errorResponse() messages).
      if (operation.responses && !('400' in operation.responses)) {
        operation.responses['400'] = genericBadRequestResponse;
      }
    }
  }

  c.res = new Response(JSON.stringify(spec), {
    headers: { 'Content-Type': 'application/json' },
  });
});

// ============================================================================
// Route-category sets
//
// Two orthogonal concerns share the same membership *today*, but they are
// distinct contracts and may diverge — keeping them in separate sets makes
// the intent explicit at every call site.
//
//   UNAUTHENTICATED_V1_PATHS
//     Operational contract: which /v1/* paths the auth and permission
//     middleware should skip. Adding a route here means "callers do not
//     need an API key to hit this."
//
//   RAW_SHAPE_V1_PATHS
//     Shape contract: which /v1/* paths are exempt from the
//     response-envelope smoke test (envelope-coverage.test.ts). Adding a
//     route here means "this endpoint intentionally returns a non-`{data}`
//     payload — discovery endpoint, health probe, or external-monitoring
//     contract."
//
// When the two lists diverge (e.g. an authenticated endpoint that still
// returns raw shape, or a public endpoint that uses the canonical envelope)
// update only the relevant set. The two sets overlap on the
// health/capabilities/pricing paths but diverge on the spec and /health
// endpoints — nothing depends on them matching — do not collapse them.
// ============================================================================

// Internal mutable set. Populated by `registerPublicRoute` (below, once it
// exists) for Chanfana-managed routes, plus manual additions here for the
// two spec endpoints Chanfana registers itself.
const _publicPaths = new Set<string>([
  '/v1/openapi.json',
  '/v1/openapi.yaml',
]);

/**
 * Paths that do not require authentication or authorization.
 *
 * Single source of truth for which routes the auth + permission middleware
 * should skip. Populated at module load by:
 *   - `registerPublicRoute()` calls for each public route (which also
 *     register the route with Chanfana). Each such route MUST carry
 *     `security: []` in its Chanfana schema so the generated OpenAPI spec
 *     documents the route as public.
 *   - Direct additions above for `/v1/openapi.{json,yaml}`, which Chanfana
 *     registers itself, so there is no route class to annotate.
 *
 * Exposed as ReadonlySet so callers can't mutate after module load.
 */
export const UNAUTHENTICATED_V1_PATHS: ReadonlySet<string> = _publicPaths;

/**
 * Paths under /v1/* that are exempt from the response-envelope smoke test.
 *
 * These return raw shapes (no `{ data }` wrapper) by design:
 *   - Health endpoints consumed by the CD health-check action + external
 *     monitoring, which expect top-level `.status`.
 *   - Capabilities is a discovery endpoint returning `{ target, url, endpoints }`.
 *   - Pricing returns a model-ID-keyed map; wrapping would break SDK consumers.
 *
 * The OpenAPI spec endpoints are not listed here because they do not appear
 * in the generated spec (the spec cannot document itself), so the envelope
 * smoke test never sees them.
 */
export const RAW_SHAPE_V1_PATHS: ReadonlySet<string> = new Set([
  '/v1/health/ingestion',
  '/v1/health/files',
  '/v1/capabilities',
  '/v1/pricing',
]);

const isUnauthenticatedV1Path = (url: string): boolean =>
  UNAUTHENTICATED_V1_PATHS.has(new URL(url).pathname);

/**
 * CORS handler for /v1/* routes.
 *
 * The dashboard environments UI (via `gatewayFetch`) and the alerts client
 * (`apps/tenant-dashboard/src/lib/alerts/client.ts`) call the gateway
 * directly from the browser. The gateway is consumed two ways:
 *   - Server-to-server: headless agents and the dashboard's server actions
 *     (no CORS preflight needed — same-origin or non-browser callers).
 *   - Browser-to-server: the dashboard's client-side fetch wrappers.
 *
 * Cross-origin browser calls require an `Access-Control-Allow-Origin`
 * header and explicit handling of the OPTIONS preflight. The whitelist
 * here is conservative — only the dashboard's known dev/preview/prod
 * origins are allowed. `DASHBOARD_BASE_URL` is the prod app origin
 * (already configured per-env via wrangler vars); the localhost entries
 * cover `yarn dev` on the dashboard.
 *
 * This MUST run before `authMiddleware`: a preflight `OPTIONS` carries no
 * API key, so auth would 401 it (with no `Access-Control-Allow-*` headers)
 * and the browser would never send the real request.
 *
 * These are the headers the dashboard sends — adding more later requires
 * updating this list. `X-Tenant-Id` carries the URL-derived request tenant on
 * bearer dispatch, so a browser preflight naming it must be allowed. We
 * deliberately do NOT echo `*` for origin because the dashboard sends
 * credentials (Supabase JWT in Authorization), and browsers reject
 * `Access-Control-Allow-Origin: *` with credentialed requests.
 */
const ALLOWED_CORS_HEADERS =
  'Authorization, Content-Type, X-Outerlayer-App-Id, X-Tenant-Id';
const ALLOWED_CORS_METHODS = 'GET, POST, PUT, PATCH, DELETE, OPTIONS';

/**
 * Dashboard dev ports, echoed only outside production. These pair with
 * `Access-Control-Allow-Credentials: true`, so anything able to serve content on
 * a victim's localhost at one of these ports could otherwise read credentialed
 * gateway responses. A deployed gateway has no legitimate localhost caller —
 * browser traffic comes from DASHBOARD_BASE_URL.
 */
const LOCALHOST_DEV_ORIGINS = [
  'http://localhost:3000',
  'http://localhost:3001',
  'http://localhost:3002',
];

export function resolveCorsOrigin(c: { req: { header: (name: string) => string | undefined }; env: Env }): string | null {
  const origin = c.req.header('Origin');
  if (!origin) return null;
  const allowed = new Set<string>(
    c.env.NODE_ENV === 'production' ? [] : LOCALHOST_DEV_ORIGINS,
  );
  if (c.env.DASHBOARD_BASE_URL) allowed.add(c.env.DASHBOARD_BASE_URL);
  return allowed.has(origin) ? origin : null;
}

app.use('/v1/*', async (c, next) => {
  const origin = resolveCorsOrigin(c);

  // Preflight: respond with the allowed-headers list without invoking
  // the rest of the chain. Browsers send OPTIONS before any non-simple
  // /v1/* request (Authorization header is enough to qualify), so this
  // must come before auth/permission middleware.
  if (c.req.method === 'OPTIONS') {
    const headers = new Headers();
    if (origin) {
      headers.set('Access-Control-Allow-Origin', origin);
      headers.set('Vary', 'Origin');
      headers.set('Access-Control-Allow-Credentials', 'true');
    }
    headers.set('Access-Control-Allow-Methods', ALLOWED_CORS_METHODS);
    headers.set('Access-Control-Allow-Headers', ALLOWED_CORS_HEADERS);
    headers.set('Access-Control-Max-Age', '600');
    return new Response(null, { status: 204, headers });
  }

  await next();

  // Decorate the actual response (auth-success or auth-failure alike) so
  // the browser can read the body. Echoing origin only on whitelist hits
  // keeps untrusted origins from getting CORS clearance even on errors.
  if (origin && c.res) {
    c.res.headers.set('Access-Control-Allow-Origin', origin);
    c.res.headers.append('Vary', 'Origin');
    c.res.headers.set('Access-Control-Allow-Credentials', 'true');
  }
});

// The runtime's composition root (`buildGatewayContext`) is INJECTED, not
// imported: core never names a concrete impl, so `gateway-core` carries no edge
// to the Cloudflare adapters. Each entrypoint calls `setGatewayContextFactory`
// once at setup — the Worker entry (`src/index.ts`) with the CF factory, the
// Node entry (Step 5) with its own, and the unit-test setup with the CF factory.
let injectedBuildGatewayContext: BuildGatewayContext | undefined;

/**
 * Inject the composition-root factory the `/v1/*` middleware uses to build
 * `gtx`. Idempotent; call once per process before serving requests.
 */
export function setGatewayContextFactory(build: BuildGatewayContext): void {
  injectedBuildGatewayContext = build;
}

// Entrypoints declare their extra required env (enforced by /health) alongside
// the gtx factory — both are entrypoint-owned composition wiring.
export { setRequiredEnvKeys } from './required-env';

// Build the injected runtime adapters once per request and expose them as
// `c.get('gtx')`. Runs before auth so auth/cache/etc. can read the seam.
//
// gtx needs `env` (+ `execCtx`). Spec/metadata requests invoke the app without
// them — `openApiApp.fetch(new Request('/v1/openapi.json'))` — and never read
// gtx, so skip building it then. Real requests always carry env; `execCtx`
// falls back to a fire-and-forget shim if a caller omits it.
app.use('/v1/*', async (c, next) => {
  if (c.env) {
    if (!injectedBuildGatewayContext) {
      // A real request reached the seam with no factory injected — a
      // composition-root wiring bug. Fail loud rather than NPE later in auth
      // (which reads `gtx.cacheL2Store`).
      throw new Error(
        'gateway-core: no BuildGatewayContext injected — call setGatewayContextFactory() at the entrypoint',
      );
    }
    let execCtx: ExecutionCtx;
    try {
      execCtx = c.executionCtx;
    } catch {
      execCtx = {
        waitUntil: (p: Promise<unknown>) => void Promise.resolve(p).catch(() => {}),
        passThroughOnException: () => {},
      } as unknown as ExecutionCtx;
    }
    c.set('gtx', injectedBuildGatewayContext(c.env, execCtx));
  }
  return next();
});

// Apply auth middleware to all /v1/* routes, skipping unauthenticated
// endpoints AND the org-management API (`/v1/orgs/*`), which runs its own
// `managementAuthGuard` per route (see `registerManagementRoute` below) —
// an `sk_`/JWT-shaped Authorization header must 401 there exactly like a
// missing one, which `authMiddleware`'s own schemes don't produce.
app.use('/v1/*', async (c, next) => {
  if (isUnauthenticatedV1Path(c.req.url) || isManagementApiPath(new URL(c.req.url).pathname)) return next();
  return authMiddleware(c, next);
});

// Permission enforcement — checks user.permissions against route requirements
app.use('/v1/*', async (c, next) => {
  if (isUnauthenticatedV1Path(c.req.url) || isManagementApiPath(new URL(c.req.url).pathname)) return next();
  return permissionMiddleware(c, next);
});

// /health is outside /v1/* so needs no auth skip — the /v1/* use block above won't match it

// Wrap with chanfana for OpenAPI spec generation.
//
// All top-level metadata (info prose, servers, tags, contact) lives inline
// here so the generated spec is complete without post-processing. The only
// post-processing step is `components.securitySchemes` above: chanfana's
// typed config strips `components`, so the middleware has to add it back.
export const openApiApp = fromHono(app, {
  docs_url: null,        // Disable built-in Swagger UI
  redoc_url: null,       // Disable built-in ReDoc
  openapi_url: '/v1/openapi.json',
  // OpenAPI 3.0.3, not 3.1. Rationale: oasdiff and most SDK generators
  // still have partial 3.1 support (numeric exclusiveMinimum, unevaluatedProperties).
  // Staying on 3.0 keeps downstream tooling (oasdiff, SDK codegen, Stoplight)
  // from hitting unmarshal errors.
  openapiVersion: '3',
  // Re-throw validation / ApiException errors to Hono's onError handler
  // (below) rather than letting Chanfana emit its default
  // `{ success: false, errors: [...] }` body. Unifies the 4xx response
  // shape across framework-emitted and handler-emitted paths — both
  // now produce `{ error: { code, message } }`.
  raiseOnError: true,
  // Disable Chanfana's outer `fromHono` wrapper that catches raw
  // ApiExceptions and re-wraps them into `HTTPException { res: ... }`
  // for Hono (see chanfana/dist/index.mjs line ~452). Without this,
  // `raiseOnError: true` is defeated at the outer layer: the inner
  // ApiException is re-thrown, then the outer wrapper catches it,
  // formats it with Chanfana's default body, and re-throws as an
  // HTTPException — which our `app.onError` (checking only for
  // ApiException, not Hono's HTTPException) misclassifies as an
  // unexpected error and emits 500 `internal_error`.
  //
  // The visible symptom is request-validation failures — a bad body,
  // param, or query against a route schema — answering 500 instead of
  // the documented 400.
  //
  // `passthroughErrors: true` skips the outer wrapper so raw
  // ApiException reaches onError with full buildResponse() intact.
  passthroughErrors: true,
  schema: {
    info: {
      title: 'OuterLayer Gateway API',
      version: '1.0',
      description:
        'The OuterLayer Gateway API lets you ingest coding-agent sessions and OpenTelemetry traces, query spans, and create scores programmatically.\n\n' +
        'Most developers should use the OuterLayer SDK for integration.\n' +
        'The REST API is for cases where you need direct HTTP access or are building a custom integration.\n\n' +
        'Versioning: every endpoint is prefixed with `/v1/`. Breaking changes ship under a new version prefix (`/v2/`, etc.) ' +
        'with a 90-day-minimum deprecation window; anything additive lands on the current prefix.',
      contact: {
        email: 'hello@outerlayer.ai',
        url: 'https://www.outerlayer.ai',
      },
    },
    servers: [
      { url: 'https://api.agentmark.co', description: 'Production (OuterLayer Cloud)' },
      { url: 'http://localhost:9418', description: 'Local dev server (self-hosted gateway)' },
    ],
    tags: [
      { name: 'Agents', description: 'Coding-agent session ingest (outerlayer sync) and content-addressed session images.' },
      { name: 'Spans', description: 'Query individual spans across traces.' },
      { name: 'Scoring', description: 'Create, retrieve, list, and delete score records for spans and traces.' },
      { name: 'Search', description: 'Structured-filter search across observability resources.' },
      { name: 'Capabilities', description: 'Query server feature availability.' },
      { name: 'Pricing', description: 'Per-model LLM pricing data. Public, unauthenticated.' },
      { name: 'API Keys', description: 'Create, list, and revoke tenant API keys. Plaintext returned exactly once at creation.' },
      { name: 'Score Configs', description: 'List and retrieve score configuration definitions from the synced project config.' },
      { name: 'Environments', description: 'Per-app named environments (e.g. `dev`, `prod`). CRUD for env lifecycle.' },
      { name: 'Apps', description: 'App CRUD — the top-level tenant entity every other resource hangs off. Lets a headless agent provision an app without the dashboard.' },
      { name: 'Workers', description: 'Cloud workers — terminal coding agents on managed compute. Launch one-shot runs or persistent multi-turn sessions against the app\'s connected repo; every response carries the dashboard deep link to the live thread.' },
      { name: 'Health', description: 'Service health checks.' },
    ],
  },
});

/**
 * Register an authenticated OpenAPI route.
 *
 * Requires the route class to declare `static requiredPermission`. That
 * declaration is type-enforced (via `AuthenticatedRouteClass`) and also
 * read at runtime here to populate the permission lookup consumed by
 * `permissionMiddleware`. Registering a route that lacks a permission is
 * impossible — the compiler rejects it, and the runtime would throw.
 */
function registerAuthenticatedRoute(
  method: AuthenticatedRouteMethod,
  path: string,
  RouteClass: AuthenticatedRouteClass,
  options: {
    entitlement?: GatewayEntitlement;
    quota?: {
      key: GatewayNumericEntitlement;
      getCurrentCount: (supabase: SystemSupabase, user: QuotaUser) => Promise<number>;
    };
  } = {},
): void {
  // Per-route permission guard — runs AFTER Hono has matched the specific
  // path, so c.req.routePath is the concrete pattern (e.g. '/v1/traces'),
  // not the wildcard '/v1/*' that the app.use() middleware sees. This is
  // the authoritative enforcement point for all chanfana-registered routes.
  // The wildcard app.use('/v1/*', permissionMiddleware) is kept as a
  // no-op fallback for any non-chanfana routes, but it never reaches this
  // permission for routes registered here because routePath is '/v1/*'
  // there and getRoutePermission returns null.
  openApiApp[method](path, enforcePermission(RouteClass.requiredPermission));
  // Tier-gated routes additionally check the entitlement matrix /
  // tenant_entitlement_override before reaching the handler. Order
  // matters: permission first (RBAC — the caller has the *scope* to
  // attempt this), then entitlement (BILLING — the tenant has *paid
  // for* the feature). Reversing would leak entitlement state to
  // callers who lack the read scope.
  if (options.entitlement) {
    openApiApp[method](path, enforceEntitlement(options.entitlement));
  }
  // Quota-gated routes check a per-tenant count against a numeric tier
  // limit (e.g. max_api_keys). Same ordering rationale as entitlement:
  // installed AFTER the permission guard so a wrong-scope caller sees
  // 403 rather than 402.
  if (options.quota) {
    openApiApp[method](path, enforceQuota(options.quota));
  }
  // Per-route rate limit (RBAC → entitlement → quota → RATE LIMIT → handler).
  // Installed last among the guards so a wrong-scope / unentitled / over-quota
  // caller sees those errors first, and the limiter only counts requests that
  // would otherwise reach the handler. Fail-open: a limiter outage never
  // blocks the request (see lib/rate-limit.ts).
  if (RouteClass.rateLimit) {
    openApiApp[method](path, enforceRateLimit(RouteClass.rateLimit));
  }
  openApiApp[method](path, R(RouteClass));
  setRoutePermission(method.toUpperCase() as 'GET' | 'POST' | 'DELETE' | 'PUT' | 'PATCH', path, RouteClass.requiredPermission);
}

/**
 * Count active api_key rows for the authenticated tenant. Used by the
 * quota guard on POST /v1/api-keys to enforce `max_api_keys`. Mirrors
 * the dashboard's server-action check for api keys.
 *
 * The supabase argument is the admin client (service role, bypasses
 * RLS) — see the rationale in lib/entitlements.ts. Without the
 * `.eq('tenant_id', user.tenantId)` filter this query counts every
 * tenant's keys.
 *
 * Uses `head: true` so PostgREST returns just the Content-Range header
 * (e.g. `0-0/N`) rather than the row payload — minimal bytes over the
 * wire for what is just a SELECT COUNT(*).
 *
 * This count is advisory, not a hard cap: it is read before the row
 * insert in `CreateApiKey`, so it reflects the tenant's state at read
 * time rather than at write time. A hard cap belongs in the database
 * (a trigger or row lock), not here. The dashboard's pre-insert check
 * has the same shape.
 */
async function countApiKeysForTenant(
  supabase: SystemSupabase,
  user: QuotaUser,
): Promise<number> {
  const { count, error } = await supabase
    .from('api_key')
    .select('id', { count: 'exact', head: true })
    .eq('tenant_id', user.tenantId)
    // Machine-minted keys (managed build / deployment SDK keys) now carry rows;
    // they must not count against the tenant's max_api_keys entitlement.
    .eq('is_machine', false);
  if (error) {
    // Throw so the quota guard's catch surfaces a 500. Returning 0 on
    // error would silently let a paying tenant exceed their quota.
    throw new Error(`api_key count lookup failed: ${error.message}`);
  }
  return count ?? 0;
}

/**
 * Count `app` rows for the authenticated tenant. Backs the quota guard
 * on POST /v1/apps to enforce `max_apps`. Mirrors the dashboard's
 * server-action check in sections/apps/actions.ts::createApp.
 *
 * Advisory, not a hard cap — same as countApiKeysForTenant above: the
 * count is read before the insert, so it reflects the tenant's state at
 * read time. A hard cap belongs in the database. The dashboard's
 * pre-insert read has the same shape.
 */
async function countAppsForTenant(
  supabase: SystemSupabase,
  user: QuotaUser,
): Promise<number> {
  const { count, error } = await supabase
    .from('app')
    .select('id', { count: 'exact', head: true })
    .eq('tenant_id', user.tenantId);
  if (error) {
    throw new Error(`app count lookup failed: ${error.message}`);
  }
  return count ?? 0;
}

/**
 * Register a public OpenAPI route — no auth required.
 *
 * Symmetric to `registerAuthenticatedRoute`. Collects the path into the
 * `UNAUTHENTICATED_V1_PATHS` set that the auth middleware consults at
 * request time. The route class MUST also declare `security: []` in its
 * Chanfana schema so the generated OpenAPI spec documents the route as
 * public; the `openapi-contract-fuzz` CI workflow (Schemathesis) fails
 * the build with an `ignored_auth` finding if that declaration is
 * missing — a valid runtime response without auth against a spec that
 * says auth is required.
 */
function registerPublicRoute(
  method: AuthenticatedRouteMethod,
  path: string,
  RouteClass: typeof OpenAPIRoute,
): void {
  openApiApp[method](path, R(RouteClass));
  _publicPaths.add(path);
}

/**
 * Register an org-management route (`/v1/orgs/:orgName/...`). Distinct from
 * `registerAuthenticatedRoute`: these routes are excluded from the shared
 * `authMiddleware`/`permissionMiddleware` wildcard chain (see the `/v1/*`
 * `app.use` blocks above) and instead run `managementAuthGuard(required)` —
 * a management-API-key (`olk_...`) verify + org-tenant-binding +
 * permission-intersection check, installed directly on the route.
 */
function registerManagementRoute(
  method: AuthenticatedRouteMethod,
  path: string,
  RouteClass: typeof OpenAPIRoute,
  requiredPermission: string,
): void {
  openApiApp[method](path, managementAuthGuard(requiredPermission));
  openApiApp[method](path, R(RouteClass));
}

// ============================================================================
// Health / capabilities routes (no auth required — skipped by middleware)
// ============================================================================
registerPublicRoute('get', '/health', HealthCheck);
registerPublicRoute('get', '/v1/health/ingestion', IngestionHealth);
registerPublicRoute('get', '/v1/health/files', FilesHealth);
registerPublicRoute('get', '/v1/capabilities', GetCapabilities);
registerPublicRoute('get', '/v1/pricing', GetPricing);

// ============================================================================
// Templates routes
// ============================================================================

// ============================================================================
// Agents routes (session sync pipe)
// ============================================================================
// Cloud workers: programmatic launch with dashboard deep links.
// workers_enabled gates every launch; the persistent-session create is
// additionally capped by the live-environment quota. Concurrency + monthly
// minutes are enforced in the launch handler (two quotas, one route).
registerAuthenticatedRoute('post', '/v1/workers/runs', LaunchWorkerRun, {
  entitlement: 'workers_enabled',
});
registerAuthenticatedRoute('get', '/v1/workers/runs/:runId', GetWorkerRun);
registerAuthenticatedRoute('post', '/v1/workers/environments', CreateWorkerSession, {
  entitlement: 'persistent_worker_environments',
  quota: {
    key: 'max_persistent_worker_environments',
    getCurrentCount: (supabase, user) =>
      countActiveEnvironmentsForTenant(supabase as never, user.tenantId),
  },
});
registerAuthenticatedRoute('post', '/v1/workers/environments/:envId/turns', ContinueWorkerSession, {
  entitlement: 'workers_enabled',
});
registerAuthenticatedRoute('get', '/v1/workers/environments/:envId', GetWorkerSession);

registerAuthenticatedRoute('post', '/v1/agents/sync', SyncAgentSessions);
registerAuthenticatedRoute('get', '/v1/agents/blob/:sha256', GetAgentBlob);

// ============================================================================
// Spans routes
// ============================================================================
registerAuthenticatedRoute('get', '/v1/spans', ListSpans);
registerAuthenticatedRoute('get', '/v1/blobs', GetBlob);
registerAuthenticatedRoute('post', '/v1/spans/search', SearchSpans);
registerAuthenticatedRoute('get', '/v1/spans/:spanId', GetSpan);

// ============================================================================
// Scores routes
// ============================================================================
registerAuthenticatedRoute('get', '/v1/scores/aggregations', GetScoreAggregations);  // Must be before :scoreId
registerAuthenticatedRoute('get', '/v1/scores/names', GetScoreNames);                // Must be before :scoreId
registerAuthenticatedRoute('get', '/v1/scores', ListScores);
registerAuthenticatedRoute('post', '/v1/scores/search', SearchScores);
registerAuthenticatedRoute('get', '/v1/scores/:scoreId', GetScore);
registerAuthenticatedRoute('post', '/v1/scores', CreateScore);
registerAuthenticatedRoute('post', '/v1/scores/batch', CreateScoresBatch);
registerAuthenticatedRoute('delete', '/v1/scores/:scoreId', DeleteScore);

// ============================================================================
// Filter-schema discovery — machine-readable description of
// the filterable surface, for agents/SDKs building structured filters.
// ============================================================================

// ============================================================================
// Metrics routes
// ============================================================================

// ============================================================================
// Datasets routes (task mining + run inputs)
// ============================================================================

// ============================================================================
// API Keys routes
// ============================================================================
registerAuthenticatedRoute('get', '/v1/api-keys', ListApiKeys);
// Quota-gate POST so a hobby tenant can't exceed `max_api_keys` (25 by
// default). Reads + revoke stay open: a downgraded tenant still needs
// to be able to list + delete what they have. Mirrors the dashboard's
// server-action check (sections/settings/api-keys/actions.ts).
registerAuthenticatedRoute('post', '/v1/api-keys', CreateApiKey, {
  quota: { key: 'max_api_keys', getCurrentCount: countApiKeysForTenant },
});
registerAuthenticatedRoute('delete', '/v1/api-keys/:apiKeyId', RevokeApiKey);

// ============================================================================
// Environments routes (CRUD slice). All four query Supabase
// directly via the scoped client; create/delete also touch the Fly Machines
// API for per-env app lifecycle. There is no env-promotion surface
// (promote / rollback / deployment-saga list) — env-promotion isn't driven
// through a saga.
// ============================================================================
registerAuthenticatedRoute('get', '/v1/environments', ListEnvironments);
registerAuthenticatedRoute('post', '/v1/environments', CreateEnvironment);
registerAuthenticatedRoute('get', '/v1/environments/:id', GetEnvironment);
registerAuthenticatedRoute('delete', '/v1/environments/:id', DeleteEnvironment);

// ============================================================================
// Apps routes
//
// Tenant-scoped (NOT app-scoped). The X-Outerlayer-App-Id header is still
// required by auth middleware for API key resolution, but the handlers
// ignore its value. The headless agent flow: mint a tenant-scoped API key
// (one-time dashboard step today), then provision apps via these endpoints.
// ============================================================================
registerAuthenticatedRoute('get', '/v1/apps', ListApps);
// Quota-gate POST so a tenant can't exceed `max_apps` via the API. Mirrors
// the `max_api_keys` enforcement on POST /v1/api-keys above. Without this
// the gateway would let a paying-tier customer create unlimited apps via
// the API even though the dashboard enforces the cap.
registerAuthenticatedRoute('post', '/v1/apps', CreateApp, {
  quota: { key: 'max_apps', getCurrentCount: countAppsForTenant },
});
// Literal /git path must come before /:appId/git pattern overlap concerns
// — same pattern as alerts/slack-channels.
registerAuthenticatedRoute('get', '/v1/apps/:appId/git', GetAppGitConnection);
registerAuthenticatedRoute('post', '/v1/apps/:appId/git/connect', StartGitConnect);
registerAuthenticatedRoute('get', '/v1/apps/:appId/git/repositories', ListAppGitRepositories);
registerAuthenticatedRoute('get', '/v1/apps/:appId/git/branches', ListAppGitBranches);
registerAuthenticatedRoute('post', '/v1/apps/:appId/git/link', LinkAppRepository);
registerAuthenticatedRoute('delete', '/v1/apps/:appId/git/link', UnlinkAppRepository);
registerAuthenticatedRoute('get', '/v1/apps/:appId', GetApp);
registerAuthenticatedRoute('patch', '/v1/apps/:appId', UpdateApp);
registerAuthenticatedRoute('delete', '/v1/apps/:appId', DeleteApp);

// ============================================================================
// Org-management routes — management-API-key (`olk_*`) auth only, see
// `registerManagementRoute` above.
// ============================================================================
registerManagementRoute('get', '/v1/orgs/:orgName/members', ListOrgMembers, 'membership.read');
registerManagementRoute('post', '/v1/orgs/:orgName/members/invites', InviteOrgMember, 'membership.insert');
registerManagementRoute(
  'post',
  '/v1/orgs/:orgName/members/invites/:inviteId/resend',
  ResendOrgMemberInvite,
  'membership.insert',
);
registerManagementRoute('patch', '/v1/orgs/:orgName/members/:userId', ChangeOrgMemberRole, 'membership.update');
registerManagementRoute('delete', '/v1/orgs/:orgName/members/:userId', RemoveOrgMember, 'membership.delete');
registerManagementRoute('get', '/v1/orgs/:orgName/roles', ListOrgRoles, 'membership.read');
