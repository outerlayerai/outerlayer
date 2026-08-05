/**
 * The HTTP boundary for the node self-host runtime.
 *
 * `@hono/node-server` adapts Node's req/res to the Web `fetch` shape, so each
 * request runs through the SAME `dispatchRequest` routing table the Cloudflare
 * Worker uses (`app.fetch` there). This module owns only the Node-side of that
 * boundary: build the per-request composition root + cache, run the dispatcher,
 * and log completion/errors to stdout (the Worker's counterpart also flushes
 * Sentry — there is none here).
 *
 * `env` is process-global on Node (loaded once at boot via `loadEnv`), not a
 * per-request binding, so it is captured in the closure and threaded into
 * `dispatchRequest` — which forwards it to `openApiApp.fetch(request, env, ctx)`,
 * populating `c.env` for the `/v1/*` gtx middleware.
 */
import { serve, type ServerType } from "@hono/node-server";
import { initCache } from "@repo/gateway-core/utils";
import { memory } from "@repo/gateway-core/cache-store";
import { dispatchRequest } from "@repo/gateway-core/dispatch-request";
import { initLogContext } from "@repo/gateway-core/context";
import { ErrorResponse, ResponseMessages } from "@repo/gateway-core/responses";
import { NodeLogger } from "@repo/gateway-core/runtime/adapters/node-logger";
import type { Env, GatewayRequest } from "@repo/gateway-core/types";
import type { ExecutionCtx } from "@repo/gateway-core/runtime/execution";
import { buildGatewayContext } from "./context";

const loggerFactory = new NodeLogger();

/** Node has no Cloudflare `ExecutionContext`; background work is fire-and-forget. */
function makeExecCtx(): ExecutionCtx {
  return {
    waitUntil: (p: Promise<unknown>) => void Promise.resolve(p).catch(() => {}),
    passThroughOnException: () => {},
  };
}

/** Handle one request: mirror the Worker's `app.fetch` preamble + error boundary. */
async function handleRequest(request: GatewayRequest, env: Env): Promise<Response> {
  request.context = {};
  initLogContext(request, env);
  const logger = loggerFactory.createLogger({ source: "gateway-node" });
  const start = Date.now();

  try {
    const execCtx = makeExecCtx();
    const gtx = buildGatewayContext(env, execCtx);
    const cache = initCache(gtx.cacheL2Store, execCtx, memory);

    const response = await dispatchRequest({ request, env, ctx: execCtx, cache, gtx });

    logger.info("request completed", {
      method: request.method,
      path: new URL(request.url).pathname,
      status: response.status,
      durationMs: Date.now() - start,
    });
    await logger.flush();
    return response;
  } catch (err) {
    logger.error(err instanceof Error ? err : new Error(String(err)), {
      path: new URL(request.url).pathname,
      method: request.method,
      status: 500,
      durationMs: Date.now() - start,
      source: "gateway-node-fetch",
    });
    await logger.flush();
    return new ErrorResponse(ResponseMessages.GenericError, 500);
  }
}

/** Start the HTTP server. Returns the Node server so the entrypoint can drain it. */
export function startServer(env: Env, port: number): ServerType {
  const server = serve({
    fetch: (request: Request) => handleRequest(request as GatewayRequest, env),
    port,
  });
  return server;
}
