/**
 * Dashboard OpenAPI spec drift test.
 *
 * Catches the common failure mode: a developer changed a withApi route
 * schema (or added/removed a route) and forgot to re-run
 * `yarn gen:openapi`. The committed `docs/dashboard-openapi.yaml` must be
 * byte-identical to what the generator produces from current source.
 *
 * Mirrors `packages/gateway-core/src/openapi/__tests__/spec-drift.test.ts` in
 * purpose; differs in that the dashboard has a single generator path
 * (no runtime-vs-docs split), so the comparison is exact rather than
 * operation-level.
 */

import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import YAML from 'yaml';
import { applyDashboardSpecPostprocess } from '../spec-postprocess';

// The manifest imports route.ts files, which close over supabase clients
// etc. Stub everything that touches runtime state at module load —
// withApi only *registers* schemas at import time, so these mocks are
// never actually invoked during the test.
vi.mock('server-only', () => ({}));

// Stub every Next.js runtime module that a migrated route transitively
// imports. Without these, loading a route for spec generation pulls in
// `next/dist/server/stream-utils/node-web-streams-helper.js`, which
// runs `new TextEncoder()` at module-init — and under vitest's V8
// coverage path the lookup happens in a context where `TextEncoder`
// isn't a constructor, so the entire test file fails before `it()`.
//
// Paths that reach stream-utils (discovered one at a time — add the
// next one here when a new route is registered that imports something
// we missed):
//   - `next/server`  → via `NextResponse` in every migrated route
//   - `next/cache`   → via `unstable_cache` in `@/lib/analytics/cache`
//                      (imported by the score-analytics routes and
//                      transitively by `@/lib/analytics/service`)
//
// The stubs are no-ops because the spec generator only reads schemas
// that `withApi` registers at import time — none of these functions
// are actually invoked.
vi.mock('next/server', () => {
  class MockNextResponse {
    status: number;
    _body: unknown;
    constructor(body: unknown, init?: { status?: number; headers?: HeadersInit }) {
      this._body = body;
      this.status = init?.status ?? 200;
    }
    async json() {
      return this._body;
    }
    static json(body: unknown, init?: { status?: number; headers?: HeadersInit }) {
      return new MockNextResponse(body, init);
    }
  }
  return { NextResponse: MockNextResponse };
});
vi.mock('next/cache', () => ({
  unstable_cache: <T extends (...args: unknown[]) => unknown>(fn: T): T => fn,
  revalidateTag: vi.fn(),
  revalidatePath: vi.fn(),
}));

vi.mock('next/headers', () => ({
  cookies: vi.fn(async () => ({
    get: () => undefined,
    set: () => {},
    delete: () => {},
  })),
  headers: vi.fn(async () => new Headers()),
}));
vi.mock('@/lib/system/entitlement-service', () => ({
  EntitlementService: vi.fn().mockImplementation(() => ({
    getLimit: vi.fn().mockResolvedValue(-1),
  })),
}));
vi.mock('@/lib/analytics/tenant-context', () => ({
  verifyAppAccess: vi.fn(),
}));
vi.mock('@/features/dashboards/service', () => ({
  dashboardsService: {},
}));

describe('Dashboard OpenAPI spec drift', () => {
  it('docs/dashboard-openapi.yaml matches generated spec', async () => {
    // Import lazily so the mocks above are installed first.
    await import('../route-manifest');
    const { generateDashboardSpec } = await import('../registry');

    const committedPath = resolve(
      __dirname,
      '..',
      '..',
      '..',
      '..',
      '..',
      '..',
      'docs',
      'dashboard-openapi.yaml',
    );
    const committedRaw = readFileSync(committedPath, 'utf8');
    const committed = YAML.parse(
      stripBanner(committedRaw),
    );

    const generated = applyDashboardSpecPostprocess(
      generateDashboardSpec() as unknown as Record<string, unknown>,
    );

    expect(generated).toEqual(committed);
    // Imports the entire route-manifest (every route.ts + transitive deps) to
    // generate the spec — irreducible multi-second module loading. Explicit
    // ceiling so this test is never the flake, independent of the (lower)
    // suite-wide default.
  }, 30_000);
});

function stripBanner(yaml: string): string {
  // Drop leading `# ` comment lines so the YAML parser only sees the doc.
  const lines = yaml.split('\n');
  let i = 0;
  while (i < lines.length && lines[i]!.startsWith('#')) i++;
  return lines.slice(i).join('\n');
}
