/**
 * DORA Metrics - One-Time Historical Incident Backfill
 *
 * Triggers a one-time 1-month historical incident backfill from BetterStack.
 * Enforced as one-time via platform_dora_collection_state (source: 'backfill').
 * Returns 409 if backfill has already succeeded; failed backfills are
 * retryable.
 *
 * Success is only recorded when the collection ran with ZERO errors — the
 * previous version marked 'success' whenever the service merely resolved,
 * which permanently locked out retries after a backfill that collected
 * nothing (e.g. bad API token).
 *
 * Auth: Platform admin session (via withPlatformAdminAuth wrapper).
 */

import { NextResponse } from 'next/server';

import { createSupabaseAdminClient } from '@/supabaseAdminClient';
import { DORA_ENVIRONMENT, BETTERSTACK_API_TOKEN } from '@/config-global.server';
import { DoraCollectionService } from '@/lib/dora-metrics/collection-service';

import { withPlatformAdminAuth } from '../auth';

// =============================================================================
// Constants
// =============================================================================

const BACKFILL_MONTHS = 1;
const BACKFILL_STATE_SOURCE = 'backfill';

// =============================================================================
// POST /api/platform-admin/dora-metrics/backfill
// =============================================================================

export const POST = withPlatformAdminAuth(async (_request, _context) => {
  const supabase = createSupabaseAdminClient();

  // One-time enforcement: return 409 if a previous backfill already succeeded
  const { data: existing } = await supabase
    .from('platform_dora_collection_state')
    .select('last_run_status')
    .eq('source', BACKFILL_STATE_SOURCE)
    .maybeSingle();

  if (existing?.last_run_status === 'success') {
    return NextResponse.json(
      { error: 'Historical data has already been loaded' },
      { status: 409 },
    );
  }

  const service = new DoraCollectionService(
    supabase,
    BETTERSTACK_API_TOKEN ?? '',
    DORA_ENVIRONMENT,
  );

  const result = await service.runCollection({
    backfill: true,
    backfillMonths: BACKFILL_MONTHS,
  });

  const now = new Date().toISOString();

  if (!result.ok) {
    // Record the error so the user can retry (only success blocks re-runs)
    const msg = result.betterstack_incidents.errors.join('; ');
    await supabase
      .from('platform_dora_collection_state')
      .upsert(
        {
          source: BACKFILL_STATE_SOURCE,
          last_run_at: now,
          last_run_status: 'error',
          last_error: msg,
          updated_at: now,
          created_at: now,
        },
        { onConflict: 'source' },
      );

    console.error('[dora-backfill] Backfill failed:', msg);
    return NextResponse.json({ error: 'Backfill failed' }, { status: 500 });
  }

  // Mark backfill as succeeded to enforce one-time run
  await supabase
    .from('platform_dora_collection_state')
    .upsert(
      {
        source: BACKFILL_STATE_SOURCE,
        last_run_at: now,
        last_run_status: 'success',
        last_collected_at: now,
        last_error: null,
        updated_at: now,
        created_at: now,
      },
      { onConflict: 'source' },
    );

  return NextResponse.json({ status: 'completed', results: result });
});
