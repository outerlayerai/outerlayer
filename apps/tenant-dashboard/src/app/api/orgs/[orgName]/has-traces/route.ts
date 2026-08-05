/**
 * Has-Traces API — lightweight existence check.
 *
 * GET /api/orgs/[orgName]/has-traces
 *
 * Returns `{ hasTraces: boolean }`. Used by the app-provider to decide
 * whether to show the onboarding placeholder. App-level data existence
 * check — no trace.read permission required. Runs under `withApi`.
 *
 * Canonical tenant-scoped URL: living under `/api/orgs/[orgName]/…` lets the
 * middleware derive the tenant from the URL org and thread it as the request
 * tenant, so the existence check runs under the URL tenant rather than a
 * possibly-stale JWT claim.
 */

import 'server-only';
import { NextResponse } from 'next/server';
import { withApi } from '@/lib/api/with-api';
import { getCachedTraces } from '@/lib/analytics/cache';
import { getAnalyticsService } from '@/lib/analytics/service';
import { HasTracesQuerySchema, OrgNameParamsSchema } from '@/lib/analytics/singletons/zod-schemas';

export const GET = withApi(
  {
    method: 'get',
    path: '/api/orgs/{orgName}/has-traces',
    tags: ['Analytics'],
    summary: 'Onboarding existence check',
    operationId: 'has-traces',
    description:
      'Returns `{ hasTraces: boolean }` — used to drive the onboarding placeholder in the dashboard.',
    request: { query: HasTracesQuerySchema, params: OrgNameParamsSchema },
    responses: {
      200: { description: '`{ hasTraces: boolean }`.' },
      400: { description: 'Invalid query params.' },
      401: { description: 'Not authenticated.' },
    },
  },
  async ({ request, context }) => {
    // The onboarding "waiting for your first trace" poll passes `?fresh=1` to
    // bypass the 30s trace cache (`CACHE_TTLS.traces`). Ingestion happens in
    // the gateway, so the dashboard's Next cache isn't invalidated when the
    // first trace lands — without this, the placeholder would take up to a
    // cache-TTL to advance instead of one poll interval. The initial gate
    // check (no `fresh`) stays cached: it runs on every app page load.
    const fresh = new URL(request.url).searchParams.get('fresh') === '1';
    if (fresh) {
      const service = getAnalyticsService(context);
      // No analytics backend (ClickHouse unconfigured) → report "no traces"
      // quietly rather than 500 on every 5s poll.
      const data = service
        ? await service.getTraces(context, { limit: 1, offset: 0 })
        : { total: 0 };
      return NextResponse.json({ hasTraces: data.total > 0 });
    }

    const data = await getCachedTraces(context, 1, 0);
    return NextResponse.json({ hasTraces: data.total > 0 });
  },
);
