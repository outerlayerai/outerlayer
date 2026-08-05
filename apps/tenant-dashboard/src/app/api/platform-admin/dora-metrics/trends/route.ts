/**
 * DORA Metrics Trends - GET API Route
 *
 * Returns time-series trend data for all four DORA metrics, bucketed
 * by day (7d/30d) or week (90d) for platform admin trend charts.
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

import { withPlatformAdminAuth } from '../auth';

// =============================================================================
// GET /api/platform-admin/dora-metrics/trends
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

    // 3. Fetch trends
    // Environment is a property of THIS deployment, never client input.
    const response = await service.getTrends(params.timeRange, params.appId, DORA_ENVIRONMENT);

    // 4. Return JSON response
    return NextResponse.json(response);
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json(
        { error: 'Validation error', details: error.issues.map((issue) => issue.message) },
        { status: 400 },
      );
    }

    console.error('[dora-metrics] Failed to fetch trends:', error);
    return NextResponse.json(
      { error: 'Failed to fetch DORA trends' },
      { status: 500 },
    );
  }
});
