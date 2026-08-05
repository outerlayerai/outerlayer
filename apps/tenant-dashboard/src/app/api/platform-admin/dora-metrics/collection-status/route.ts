/**
 * DORA Metrics - Collection Status
 *
 * Returns collection state for all DORA data sources.
 * Shows when each source was last collected, run status, and any errors.
 *
 * Auth: Platform admin session (via withPlatformAdminAuth wrapper).
 */

import { NextResponse } from 'next/server';

import { createSupabaseAdminClient } from '@/supabaseAdminClient';

import { withPlatformAdminAuth } from '../auth';

// =============================================================================
// GET /api/platform-admin/dora-metrics/collection-status
// =============================================================================

export const GET = withPlatformAdminAuth(async (_request, _context) => {
  const supabase = createSupabaseAdminClient();

  const { data, error } = await supabase
    .from('platform_dora_collection_state')
    .select('source, last_collected_at, last_run_at, last_run_status, last_error')
    .order('source', { ascending: true });

  if (error) {
    console.error('[dora-collection-status] Query failed:', error.message);
    return NextResponse.json(
      { error: 'Failed to fetch collection status' },
      { status: 500 },
    );
  }

  return NextResponse.json({
    sources: data ?? [],
  });
});
