/**
 * DORA Rankings - GET API Route
 *
 * Returns per-app DORA metrics rankings for platform admin dashboards.
 * Supports sorting by any of the four DORA metrics.
 *
 * Auth: Platform admin only (via withPlatformAdminAuth wrapper).
 * Query params: timeRange (7d|30d|90d), sortBy, sortOrder.
 */

import { NextResponse } from 'next/server';
import { z } from 'zod';

import { createSupabaseAdminClient } from '@/supabaseAdminClient';
import { DORA_ENVIRONMENT } from '@/config-global.server';
import { getDoraMetricsService } from '@/lib/dora-metrics/service';
import { doraRankingsQuerySchema, parseSearchParams } from '@/lib/dora-metrics/validation';

import { withPlatformAdminAuth } from '../auth';

// =============================================================================
// GET /api/platform-admin/dora-metrics/rankings
// =============================================================================

export const GET = withPlatformAdminAuth(async (request, _context) => {
  try {
    // 1. Parse and validate query params
    const url = new URL(request.url);
    const rawParams = parseSearchParams(url.searchParams);
    const params = doraRankingsQuerySchema.parse(rawParams);

    // 2. Create service (mock in preview, real in production)
    const supabase = createSupabaseAdminClient();
    const service = getDoraMetricsService(supabase);

    // 3. Fetch rankings
    const response = await service.getRankings(
      params.timeRange,
      params.sortBy,
      params.sortOrder,
      // Environment is a property of THIS deployment, never client input.
      DORA_ENVIRONMENT,
    );

    // 4. Return JSON response
    return NextResponse.json(response);
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json(
        { error: 'Validation error', details: error.issues.map((issue) => issue.message) },
        { status: 400 },
      );
    }

    console.error('[dora-metrics] Failed to fetch rankings:', error);
    return NextResponse.json(
      { error: 'Failed to fetch DORA rankings' },
      { status: 500 },
    );
  }
});
