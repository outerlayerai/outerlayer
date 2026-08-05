/**
 * DORA Metrics Summary - GET API Route
 *
 * Returns aggregated DORA metrics (deployment frequency, lead time,
 * change failure rate, MTTR) for platform admin dashboards.
 *
 * Auth: Platform admin only (via withPlatformAdminAuth wrapper).
 * Query params: timeRange (7d|30d|90d), appId (optional UUID filter).
 */

import { NextResponse } from 'next/server';
import { z } from 'zod';

import { createSupabaseAdminClient } from '@/supabaseAdminClient';
import { DORA_ENVIRONMENT } from '@/config-global.server';
import { getDoraMetricsService } from '@/lib/dora-metrics/service';
import { doraMetricsQuerySchema, parseSearchParams } from '@/lib/dora-metrics/validation';

import { withPlatformAdminAuth } from './auth';

// =============================================================================
// GET /api/platform-admin/dora-metrics
// =============================================================================

export const GET = withPlatformAdminAuth(async (request, _context) => {
  try {
    // 1. Parse and validate query params
    const url = new URL(request.url);
    const rawParams = parseSearchParams(url.searchParams);
    const params = doraMetricsQuerySchema.parse(rawParams);

    // 2. Create service (mock in preview, real in production)
    const supabase = createSupabaseAdminClient();
    const service = getDoraMetricsService(supabase);

    // 3. Fetch metrics
    // Environment is a property of THIS deployment, never client input —
    // the staging dashboard can only see staging data, production only
    // production.
    const response = await service.getMetrics(params.timeRange, params.appId, DORA_ENVIRONMENT);

    // 4. Return JSON response
    return NextResponse.json(response);
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json(
        { error: 'Validation error', details: error.issues.map((issue) => issue.message) },
        { status: 400 },
      );
    }

    console.error('[dora-metrics] Failed to calculate DORA metrics:', error);
    return NextResponse.json(
      { error: 'Failed to calculate DORA metrics' },
      { status: 500 },
    );
  }
});
