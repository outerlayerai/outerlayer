/**
 * DORA Metrics Services - GET API Route
 *
 * Returns a list of platform services that have deployment data, for use
 * in the service filter dropdown on the DORA metrics dashboard.
 *
 * Auth: Platform admin only (via withPlatformAdminAuth wrapper).
 */

import 'server-only';

import { NextResponse } from 'next/server';

import { createSupabaseAdminClient } from '@/supabaseAdminClient';
import { isPreviewMode, isCiMode } from '@/lib/dora-metrics/service';
import { MockDoraMetricsService } from '@/lib/dora-metrics/mock-service';

import { withPlatformAdminAuth } from '../auth';

interface ServiceInfo {
  id: string;
  name: string;
}

// =============================================================================
// GET /api/platform-admin/dora-metrics/apps
// =============================================================================

export const GET = withPlatformAdminAuth(async (_request, _context) => {
  try {
    // Preview/CI mode: return services from mock data
    if (isPreviewMode() || isCiMode()) {
      console.log('[dora-metrics/apps] Preview/CI mode — serving mock services list');
      const mockService = new MockDoraMetricsService();
      const serviceNames = mockService.getServices();
      const result: ServiceInfo[] = serviceNames.map((name) => ({ id: name, name }));
      return NextResponse.json({ apps: result });
    }

    const supabase = createSupabaseAdminClient();

    // Get distinct service names from platform_deployment
    // Note: platform_deployment is not in the generated Supabase types yet
    // (needs supabase gen types after migration). Using type assertion.
    const { data: deployments, error: depError } = await (supabase as any)
      .from('platform_deployment')
      .select('service');

    if (depError) throw depError;

    const rows = (deployments ?? []) as Array<{ service: string }>;
    const serviceNames = [...new Set(rows.map((d) => d.service))];

    if (serviceNames.length === 0) {
      return NextResponse.json({ apps: [] });
    }

    const result: ServiceInfo[] = serviceNames
      .sort()
      .map((name) => ({
        id: name,
        name,
      }));

    return NextResponse.json({ apps: result });
  } catch (err) {
    console.error('[dora-metrics] Failed to fetch services:', err);
    return NextResponse.json({ error: 'Failed to fetch services' }, { status: 500 });
  }
});
