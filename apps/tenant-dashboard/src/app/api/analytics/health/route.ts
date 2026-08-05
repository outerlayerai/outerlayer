/**
 * Analytics Health Check API Route
 *
 * GET /api/analytics/health
 *
 * Returns health status of the analytics service and its dependencies.
 * No authentication required (public health check).
 *
 * The probe itself lives in `@/lib/analytics/health-check` so the public
 * uptime endpoint at `/api/analytics` can share it verbatim.
 */

import { analyticsHealthResponse } from '@/lib/analytics/health-check';

export async function GET() {
  return analyticsHealthResponse();
}
