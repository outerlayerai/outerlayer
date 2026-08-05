/**
 * The node self-host entrypoint — the composition root for the Node runtime.
 *
 * Mirrors what `apps/gateway/src/index.ts` does for Cloudflare: inject the
 * runtime's `buildGatewayContext`, declare the entrypoint's required env, then
 * start serving. Two differences from the Worker: env is validated + loaded from
 * `process.env` at boot (`loadEnv`, fail-fast), and there is no Stripe boot-check
 * — self-host runs `SelfHostBillingService`, so no billing secrets are required.
 *
 * Auth is selected by composition, not a flag: the injected `gtx.auth` is
 * `SelfHostAuthResolver` (Supabase app-row resolution, no Unkey). See context.ts.
 */
import { setGatewayContextFactory, setRequiredEnvKeys } from "@repo/gateway-core/openapi";
import { loadEnv } from "./env";
import { buildGatewayContext } from "./context";
import { startServer } from "./server";
import { startCron } from "./cron";

// Fail fast on a misconfigured env before opening a socket.
const env = loadEnv();

// Inject the Node composition root into the shared /v1/* gtx middleware.
setGatewayContextFactory(buildGatewayContext);

// /health enforces these on top of the shared agnostic base (Supabase +
// ClickHouse + NODE_ENV): the self-host S3 blob store the Node runtime requires
// (it has no Cloudflare R2). The Worker declares its own hosted-only extras.
setRequiredEnvKeys([
  "BLOB_S3_ENDPOINT",
  "BLOB_S3_ACCESS_KEY_ID",
  "BLOB_S3_SECRET_ACCESS_KEY",
  "BLOB_S3_BUCKET",
]);

// Parse PORT defensively: an empty or non-numeric value must fall back to the
// default, not coerce to 0 (`Number("")` → 0 → bind to a random port, so probes
// hit the wrong listener).
const parsedPort = Number(process.env.PORT);
const port = Number.isInteger(parsedPort) && parsedPort > 0 ? parsedPort : 9001;
const server = startServer(env, port);
const cronTask = startCron(env);
// eslint-disable-next-line no-console
console.log(`[gateway-node] listening on :${port}`);

// Graceful shutdown: stop the cron, stop accepting connections, let in-flight
// requests finish within a 10s budget, then force-exit if they don't.
let shuttingDown = false;
function shutdown(signal: string): void {
  if (shuttingDown) return;
  shuttingDown = true;
  // eslint-disable-next-line no-console
  console.log(`[gateway-node] ${signal} received — draining (10s budget)`);
  cronTask.stop();
  const force = setTimeout(() => {
    // eslint-disable-next-line no-console
    console.error("[gateway-node] drain timed out — forcing exit");
    process.exit(1);
  }, 10_000);
  force.unref();
  server.close(() => {
    clearTimeout(force);
    // eslint-disable-next-line no-console
    console.log("[gateway-node] drained — exiting");
    process.exit(0);
  });
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
