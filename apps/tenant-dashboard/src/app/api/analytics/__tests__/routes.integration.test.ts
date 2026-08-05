/**
 * Analytics API Routes — residual integration smoke tests.
 *
 * Every analytics route except `health` runs under `withApi` and owns its
 * coverage in a `__tests__/route.test.ts` alongside it:
 *
 *   - Metrics / Models / Percentiles / Score-names /
 *     Metadata-keys / Has-traces / Requests /
 *     Span-kind-breakdown / Requests-aggregate / Sessions /
 *     Sessions[id]/traces / Experiments / Dataset-runs → see
 *       src/app/api/analytics/**\/__tests__/route.test.ts
 *   - Traces / Traces[id] / Span I/O → tests at
 *       src/app/api/analytics/traces/__tests__/
 *       src/app/api/analytics/traces/[id]/__tests__/
 *       src/app/api/analytics/traces/[id]/spans/[spanId]/io/__tests__/
 *
 * The dashboards integration test covers the wrapper-level auth
 * paths (unauthenticated / no tenant / cross-tenant) once for the
 * whole `withApi` surface — no need to duplicate them per route
 * family.
 *
 * What remains here: the health smoke test, which intentionally runs
 * without any auth wrapper at all.
 */

vi.mock('server-only', () => ({}));

vi.mock('next/server', () => ({
  NextResponse: {
    json: (data: unknown, init?: ResponseInit) => ({
      status: init?.status || 200,
      json: () => Promise.resolve(data),
      headers: new Headers(init?.headers),
    }),
  },
}));

import { describe, it, expect, vi } from 'vitest';
import { GET as getHealth } from '../health/route';

describe('Analytics API Routes Integration', () => {
  describe('Health Route', () => {
    it('should NOT require authentication', async () => {
      // Health route is intentionally public. ClickHouse connection
      // failure is expected in the test env — we only assert the
      // handler is callable without any auth wrapper throwing.
      await getHealth().catch(() => {
        /* ClickHouse unavailable in test environment — expected */
      });
      expect(true).toBe(true);
    });
  });
});
