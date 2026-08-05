/**
 * DORA Deployment Ingestion - POST API Route
 *
 * Receives deployment events from CI/CD pipelines (GitHub Actions).
 * Inserts into platform_deployment with deduplication via external_id and
 * records a `cd_push` heartbeat in platform_dora_collection_state so the
 * dashboard can surface staleness when CI stops reporting.
 *
 * Auth: API key (x-api-key header) — NOT session auth. This route lives
 * under /api/internal/ specifically so the session middleware (proxy.ts)
 * never intercepts machine-to-machine calls with a login redirect.
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';

import { createSupabaseAdminClient } from '@/supabaseAdminClient';
import { safeCompare } from '@/utils/safe-compare';

// =============================================================================
// Validation
// =============================================================================

const deploymentSchema = z.object({
  service: z.string().min(1, 'service is required'),
  environment: z.enum(['production', 'staging', 'preview'], {
    message: 'environment must be production, staging, or preview',
  }),
  status: z.enum(['success', 'failure', 'running'], {
    message: 'status must be success, failure, or running',
  }),
  commit_sha: z.string().nullable().optional(),
  commit_message: z.string().max(500).nullable().optional(),
  branch: z.string().nullable().optional(),
  failure_reason: z.string().nullable().optional(),
  duration_ms: z.number().positive().int().nullable().optional(),
  triggered_by: z.string().nullable().optional(),
  pipeline_url: z.union([z.literal(''), z.string().url()]).nullable().optional(),
  external_id: z.string().nullable().optional(),
  started_at: z.string().min(1, 'started_at is required'),
  completed_at: z.string().nullable().optional(),
  /** Earliest commit timestamp for true DORA lead time (commit → deploy). */
  first_commit_at: z.string().nullable().optional(),
});

// =============================================================================
// API Key Auth
// =============================================================================

function validateApiKey(request: NextRequest): boolean {
  const apiKey = request.headers.get('x-api-key');
  const expectedKey = process.env.DORA_INGEST_API_KEY;

  if (!expectedKey || !apiKey) return false;
  return safeCompare(apiKey, expectedKey);
}

// =============================================================================
// POST /api/internal/dora/deployments
// =============================================================================

export async function POST(request: NextRequest): Promise<NextResponse> {
  // 1. Auth: API key (timing-safe)
  if (!validateApiKey(request)) {
    return NextResponse.json({ error: 'Invalid API key' }, { status: 401 });
  }

  // 2. Parse and validate body
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  let validated: z.infer<typeof deploymentSchema>;
  try {
    validated = deploymentSchema.parse(body);
  } catch (err) {
    if (err instanceof z.ZodError) {
      return NextResponse.json(
        { error: 'Validation error', details: err.issues.map((issue) => issue.message) },
        { status: 400 },
      );
    }
    return NextResponse.json({ error: 'Validation failed' }, { status: 400 });
  }

  const supabase = createSupabaseAdminClient();

  // 3. Atomic upsert: ON CONFLICT (external_id) DO NOTHING.
  //    Replaces the previous check-then-insert (which raced against the
  //    same event arriving twice). Empty data array = row already existed.
  const { data, error } = await supabase
    .from('platform_deployment')
    .upsert(
      {
        service: validated.service,
        environment: validated.environment,
        status: validated.status,
        commit_sha: validated.commit_sha ?? null,
        commit_message: validated.commit_message ?? null,
        branch: validated.branch ?? null,
        failure_reason: validated.failure_reason ?? null,
        duration_ms: validated.duration_ms ?? null,
        triggered_by: validated.triggered_by ?? null,
        pipeline_url: validated.pipeline_url ?? null,
        external_id: validated.external_id ?? null,
        started_at: validated.started_at,
        completed_at: validated.completed_at ?? null,
        first_commit_at: validated.first_commit_at ?? null,
      },
      { onConflict: 'external_id', ignoreDuplicates: true },
    )
    .select('id');

  if (error) {
    console.error('[dora-deployments] Upsert failed:', error.message);
    return NextResponse.json(
      { error: 'Failed to record deployment' },
      { status: 500 },
    );
  }

  const rows = (data ?? []) as Array<{ id: string }>;
  const insertedRow = rows[0];

  // 4. Heartbeat: record that the CD push path is alive. Best-effort —
  //    a heartbeat failure must not fail the ingest.
  const now = new Date().toISOString();
  const { error: stateError } = await supabase
    .from('platform_dora_collection_state')
    .upsert(
      {
        source: 'cd_push',
        last_run_at: now,
        last_run_status: 'success',
        last_collected_at: now,
        last_error: null,
        updated_at: now,
        created_at: now,
      },
      { onConflict: 'source' },
    );
  if (stateError) {
    console.warn('[dora-deployments] cd_push heartbeat failed:', stateError.message);
  }

  if (!insertedRow) {
    return NextResponse.json({ created: false }, { status: 200 });
  }
  return NextResponse.json({ id: insertedRow.id, created: true }, { status: 201 });
}
