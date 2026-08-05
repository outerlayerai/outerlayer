/**
 * HTTP header names the trace-ingest path reads for per-request environment
 * selection on kind-scoped API keys.
 *
 * WIRE CONTRACT — these MUST stay equal (case-insensitively) to whatever
 * headers the SDK emits for environment/PR selection (`@agentmark-ai/sdk`'s
 * `buildTraceExporterHeaders`, `packages/sdk/src/trace/tracing.ts` in the
 * external OSS repo). HTTP header names are case-insensitive and Hono
 * lowercases them on read, so the gateway stores the lowercase form.
 *
 * The authoritative end-to-end proof that the two sides agree is the
 * `@local-stack` trace e2e (real SDK emit → real gateway read). The constant
 * here + `__tests__/trace-headers.test.ts` additionally catch an accidental
 * gateway-side rename within the gateway suite — if you rename one of these,
 * rename the SDK emitter in the same change.
 */
export const ENV_SELECTOR_HEADER = "x-outerlayer-environment";
export const PR_NUMBER_HEADER = "x-outerlayer-pr-number";
