// ---------------------------------------------------------------------------
// DORA Metrics - Scheduled Incident Collection Route
//
// Invoked on a schedule (GitHub Actions cron workflow) to collect incident
// data from BetterStack into platform_incident and correlate incidents with
// deployments. Deployment events are pushed directly by CD — see
// /api/internal/dora/deployments.
//
// Returns 500 on ANY collection error so the calling workflow goes red and
// somebody notices. (The previous version returned 200 unless every source
// failed, which kept monitoring green while data silently went missing.)
// ---------------------------------------------------------------------------

import { NextRequest } from 'next/server';
import { createSupabaseAdminClient } from '@/supabaseAdminClient';
import {
  CRON_SECRET,
  DORA_ENVIRONMENT,
  BETTERSTACK_API_TOKEN,
} from '@/config-global.server';
import { safeCompare } from '@/utils/safe-compare';
import { DoraCollectionService } from '@/lib/dora-metrics/collection-service';

export async function GET(request: NextRequest): Promise<Response> {
  const authHeader = request.headers.get('authorization');
  if (!authHeader || !safeCompare(authHeader, `Bearer ${CRON_SECRET}`)) {
    return new Response('Unauthorized', { status: 401 });
  }

  const service = new DoraCollectionService(
    createSupabaseAdminClient(),
    BETTERSTACK_API_TOKEN ?? '',
    DORA_ENVIRONMENT,
  );

  const result = await service.runCollection({ backfill: false });

  return Response.json(result, {
    status: result.ok ? 200 : 500,
  });
}
