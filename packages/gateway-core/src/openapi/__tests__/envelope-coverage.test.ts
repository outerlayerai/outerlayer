/**
 * Smoke test: every /v1/* route that returns JSON MUST use the canonical
 * response envelope:
 *
 *   - `{ data }` / `{ data, pagination }` — see `itemResponse` /
 *     `listResponse` in `@repo/api-schemas/common`.
 *
 * Mutations with no meaningful payload should return `204 No Content`
 * (empty body) and therefore won't appear in this smoke test at all.
 *
 * We fetch the generated OpenAPI spec from the app and walk every path ×
 * method pair. For each 2xx `application/json` response, we assert the
 * top-level property list is a subset of the envelope allowlist and
 * contains `data` as the discriminator.
 *
 * This catches new routes that hand-roll a bespoke envelope — the same
 * kind of drift that produced `{ graphData }` and `{ datasets }` before
 * the envelope helpers existed, plus the older `{ success, ... }` shape
 * we migrated away from in favor of pure HTTP-status signalling.
 */

import { describe, it, expect, beforeAll, vi } from 'vitest';

// Same mocks as permission-coverage.test.ts — openApiApp transitively
// imports Supabase, ClickHouse, and the analytics factory.
vi.mock('../analytics-factory', () => ({
  getGatewayAnalyticsService: vi.fn(() => null),
}));
vi.mock('@clickhouse/client-web', () => ({
  createClient: vi.fn(() => ({ query: vi.fn(), insert: vi.fn() })),
}));

import { openApiApp, RAW_SHAPE_V1_PATHS } from '../index';

const LEGACY_PASSTHROUGHS: ReadonlyArray<readonly ['GET' | 'POST', string]> = [];

// Top-level properties the envelope allowlist recognizes. Anything else
// trips the smoke test.
const ALLOWED_TOP_LEVEL_KEYS = new Set(['data', 'pagination']);

// Known envelope violations. Each entry must carry a short comment explaining
// why and when it will be resolved.
//
// DO NOT extend this list. Every new list endpoint MUST use
// `listResponse(item)` and every detail endpoint MUST use `itemResponse(item)`
// from `@repo/api-schemas/common`. If you find yourself wanting to
// add an entry here, the right move is almost always to update the route to
// use the canonical envelope helper instead. Extending this set is how
// one-off response shapes such as `{ datasets: string[] }` or `{ graphData }`
// enter the API surface.
const ENVELOPE_EXCEPTIONS: ReadonlySet<string> = new Set([
  // POST /v1/scores returns `{ message, id }` to match the OSS CLI server's
  // response shape (see the CLI's scores/index.ts, now in the external OSS
  // repo, and the pinning test "POST /v1/scores returns { message, id }
  // matching cloud format"). This is a cross-service contract, not envelope
  // drift. Migrating it requires coordinating gateway + OSS CLI + SDK
  // consumers; track with the broader scores-endpoint redesign.
  'POST /v1/scores',
]);

const legacyKeys = new Set(
  LEGACY_PASSTHROUGHS.map(([method, path]) => `${method} ${path}`),
);

type RouteEntry = {
  method: string;
  path: string;
  statusCode: string;
  schema: { type?: string; properties?: Record<string, unknown>; required?: string[] };
};

function collectJsonRoutes(spec: {
  paths?: Record<string, Record<string, unknown>>;
}): RouteEntry[] {
  const out: RouteEntry[] = [];
  for (const [path, pathItem] of Object.entries(spec.paths ?? {})) {
    if (!path.startsWith('/v1/')) continue;
    if (RAW_SHAPE_V1_PATHS.has(path)) continue;

    for (const [method, op] of Object.entries(pathItem)) {
      if (typeof op !== 'object' || op === null) continue;
      const methodUpper = method.toUpperCase();
      if (!['GET', 'POST', 'DELETE', 'PUT', 'PATCH'].includes(methodUpper)) continue;
      if (legacyKeys.has(`${methodUpper} ${path}`)) continue;

      const responses = (op as { responses?: Record<string, unknown> }).responses ?? {};
      for (const [code, resp] of Object.entries(responses)) {
        if (!/^2\d\d$/.test(code)) continue;
        const schema = (resp as { content?: Record<string, { schema?: RouteEntry['schema'] }> })
          ?.content?.['application/json']?.schema;
        if (!schema) continue;
        out.push({ method: methodUpper, path, statusCode: code, schema });
        break; // One 2xx JSON schema per route is enough.
      }
    }
  }
  return out;
}

describe('response envelope coverage', () => {
  let routes: RouteEntry[] = [];

  beforeAll(async () => {
    const res = await openApiApp.fetch(new Request('http://test.local/v1/openapi.json'));
    const spec = (await res.json()) as { paths?: Record<string, Record<string, unknown>> };
    routes = collectJsonRoutes(spec);
  });

  it('discovers a non-empty set of JSON-returning /v1/* routes', () => {
    // Sanity — if this drops to zero we're filtering too aggressively and
    // the rest of the suite would silently pass without checking anything.
    expect(routes.length).toBeGreaterThan(0);
  });

  it('every route uses a canonical envelope (data / data+pagination / success)', () => {
    const failures: string[] = [];

    for (const { method, path, schema } of routes) {
      const key = `${method} ${path}`;
      if (ENVELOPE_EXCEPTIONS.has(key)) continue;

      const props = schema.properties ?? {};
      const keys = Object.keys(props);

      if (keys.length === 0) {
        failures.push(`${key}: 2xx JSON schema declares no properties`);
        continue;
      }

      const forbidden = keys.filter((k) => !ALLOWED_TOP_LEVEL_KEYS.has(k));
      if (forbidden.length > 0) {
        failures.push(
          `${key}: forbidden top-level keys [${forbidden.join(', ')}] — ` +
            `use itemResponse / listResponse from @repo/api-schemas, or ` +
            `return 204 No Content when there is no payload`,
        );
        continue;
      }

      if (!keys.includes('data')) {
        failures.push(
          `${key}: response envelope must include 'data' as the discriminator`,
        );
      }
    }

    expect(failures, `envelope violations:\n  ${failures.join('\n  ')}`).toEqual([]);
  });

  it('every documented envelope exception actually appears in the spec', () => {
    // Guards against stale exceptions that outlive the endpoint they
    // excused — remove from ENVELOPE_EXCEPTIONS when removing a route.
    const liveKeys = new Set(routes.map((r) => `${r.method} ${r.path}`));
    const stale = [...ENVELOPE_EXCEPTIONS].filter((k) => !liveKeys.has(k));
    expect(stale, 'exceptions referencing routes that no longer exist').toEqual([]);
  });
});
