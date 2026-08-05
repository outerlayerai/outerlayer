/**
 * `@repo/gateway-core` — the runtime-agnostic gateway core.
 *
 * The root entry surfaces the DI seam (the `GatewayContext` container + the
 * adapter interfaces each entrypoint injects). The rest of the surface is
 * reached via subpath imports the package exports directly, e.g.
 * `@repo/gateway-core/openapi` (the Hono app + `setGatewayContextFactory`),
 * `@repo/gateway-core/routes/*`, `@repo/gateway-core/services/*`,
 * `@repo/gateway-core/lib/*`, and `@repo/gateway-core/types`.
 */
export * from './runtime';
