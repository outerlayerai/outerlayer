import { NextRequest } from 'next/server';
import { createSupabaseAdminClient } from '@/supabaseAdminClient';
import { getDefaultClient } from '@/lib/analytics/client';
import { CRON_SECRET } from '@/config-global.server';
import { SpanUsageNotificationService } from '@/lib/system/span-usage-notifications/service';

export async function GET(request: NextRequest): Promise<Response> {
  const authHeader = request.headers.get('authorization');
  if (authHeader !== `Bearer ${CRON_SECRET}`) {
    return new Response('Unauthorized', { status: 401 });
  }

  const service = new SpanUsageNotificationService({
    supabase: createSupabaseAdminClient(),
    clickhouse: getDefaultClient(),
  });

  const result = await service.checkAndNotify();

  return Response.json(result, {
    status: result.errors.length > 0 && result.notified.length === 0 ? 500 : 200,
  });
}
