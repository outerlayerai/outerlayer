/**
 * The gateway request dispatcher — runtime-neutral.
 *
 * Resolves a request in this order:
 *   1. OpenAPI routes (the chanfana-managed Hono app). A real 404 from an
 *      OpenAPI handler is returned as-is; only the notFound sentinel header
 *      falls through.
 *   2. A canonical `{ error: { code, message } }` 404.
 *
 * Every dependency here is runtime-agnostic core, so BOTH entrypoints call this
 * with their own `gtx`/`cache` and wrap it in their own observability boundary
 * (the Cloudflare Worker adds Sentry + BetterStack; the node self-host entry
 * adds stdout logging). The dispatcher does NOT log or catch: error handling /
 * request logging belong to each entrypoint.
 */
import type { ExecutionContext } from "hono";
import type { LegacyRouteContext } from "./types";
import { openApiApp, OPENAPI_NO_ROUTE_HEADER } from "./openapi";

export async function dispatchRequest({
  request,
  env,
  ctx,
}: LegacyRouteContext): Promise<Response> {
  // Try OpenAPI routes first (chanfana-managed endpoints). Only fall through to
  // the canonical 404 when the OpenAPI app had no route for the path — identified
  // by the sentinel header set by the notFound handler in src/openapi/index.ts.
  // A 404 from a real OpenAPI handler (e.g. `structuredError('trace_not_found',
  // ...)`) is returned as-is, preserving the canonical `{ error: { code,
  // message } }` envelope.
  const openApiResponse = await openApiApp.fetch(
    request,
    env,
    ctx as unknown as ExecutionContext,
  );
  const isOpenApiNoRoute =
    openApiResponse.status === 404 &&
    openApiResponse.headers.get(OPENAPI_NO_ROUTE_HEADER) === "1";
  if (!isOpenApiNoRoute) {
    return openApiResponse;
  }

  // Truly unknown path — return the canonical `{ error: { code, message } }`
  // envelope. Legacy `ErrorResponse` omits `code`, which violates the OpenAPI
  // error schema and tripped Schemathesis on every 4xx from this fallthrough.
  return new Response(
    JSON.stringify({
      error: { code: "route_not_found", message: "Route not found" },
    }),
    { status: 404, headers: { "Content-Type": "application/json" } },
  );
}
