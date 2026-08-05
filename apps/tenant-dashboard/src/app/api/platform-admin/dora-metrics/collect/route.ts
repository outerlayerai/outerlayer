/**
 * DORA Metrics - Manual Collection Trigger
 *
 * Triggers manual incident collection from BetterStack. Supports both
 * incremental collection (last 24h) and historical backfill. Deployment
 * events are pushed by CD — see /api/internal/dora/deployments.
 *
 * Auth: Platform admin session (via withPlatformAdminAuth wrapper).
 */

import { NextResponse } from 'next/server';
import { z } from 'zod';

import { createSupabaseAdminClient } from '@/supabaseAdminClient';
import { DORA_ENVIRONMENT, BETTERSTACK_API_TOKEN } from '@/config-global.server';
import { DoraCollectionService } from '@/lib/dora-metrics/collection-service';

import { withPlatformAdminAuth } from '../auth';

// =============================================================================
// Validation
// =============================================================================

const collectSchema = z.object({
  backfill: z.boolean({ message: 'backfill is required' }),
  backfill_months: z.number().int().min(1).max(24).nullable().optional(),
});

// =============================================================================
// POST /api/platform-admin/dora-metrics/collect
// =============================================================================

export const POST = withPlatformAdminAuth(async (request, _context) => {
  // 1. Parse request body
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  // 2. Validate against schema
  let validated: z.infer<typeof collectSchema>;
  try {
    validated = collectSchema.parse(body);
  } catch (err) {
    if (err instanceof z.ZodError) {
      return NextResponse.json(
        { error: 'Validation error', details: err.issues.map((issue) => issue.message) },
        { status: 400 },
      );
    }
    return NextResponse.json({ error: 'Validation failed' }, { status: 400 });
  }

  // 3. Build collection service with env-based credentials
  const supabase = createSupabaseAdminClient();
  const service = new DoraCollectionService(
    supabase,
    BETTERSTACK_API_TOKEN ?? '',
    DORA_ENVIRONMENT,
  );

  // 4. Run collection. Any error is a failure — no silent partials.
  const result = await service.runCollection({
    backfill: validated.backfill,
    backfillMonths: validated.backfill_months ?? undefined,
  });

  if (!result.ok) {
    return NextResponse.json(
      { status: 'failed', results: result },
      { status: 500 },
    );
  }

  return NextResponse.json({
    status: 'completed',
    results: result,
  });
});
