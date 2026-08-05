/**
 * Entrypoint-declared required env keys — enforced by the `/health` probe.
 *
 * The shared `EnvSchema` is runtime-agnostic: it cannot require Stripe secrets,
 * because the node self-host entrypoint runs the same core and must boot without
 * them. But the hosted Cloudflare Worker always runs Stripe billing, so a
 * misconfigured hosted deploy (a missing `STRIPE_*` secret) should fail `/health`
 * loudly at deploy time instead of silently failing-open inside metering.
 *
 * Each entrypoint owns its own env validation (the same principle behind
 * `setGatewayContextFactory`): the Worker entry declares its extra required keys
 * here; the node entry declares none. `/health` reports whatever the active
 * entrypoint declared, on top of the shared-schema check. This is a leaf module
 * (no imports) so both the openapi app and the health route can read it without
 * an import cycle.
 */

let requiredEnvKeys: readonly string[] = [];

/** Called once per process by an entrypoint, before serving requests. */
export function setRequiredEnvKeys(keys: readonly string[]): void {
  requiredEnvKeys = keys;
}

export function getRequiredEnvKeys(): readonly string[] {
  return requiredEnvKeys;
}
