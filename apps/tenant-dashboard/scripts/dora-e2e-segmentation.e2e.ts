/**
 * DORA environment-segmentation e2e — runs the REAL DoraCollectionService
 * correlation and DoraMetricsService queries against the REAL local
 * Postgres (no MSW, no mocks).
 *
 * Validates the exact failure mode flagged in review: staging incidents
 * must not pollute production MTTR/CFR, correlation must stay within an
 * environment, and unknown-environment incidents must be excluded rather
 * than miscounted.
 *
 * Usage:  yarn vitest run --config vitest.e2e-local.config.ts
 * Requires: local Supabase running (this branch's migrations applied).
 */

import { createClient } from '@supabase/supabase-js';

import { DoraCollectionService } from '../src/lib/dora-metrics/collection-service';
import { DoraMetricsService } from '../src/lib/dora-metrics/service';

const SUPABASE_URL = process.env.E2E_SUPABASE_URL ?? 'http://127.0.0.1:54421';
const SERVICE_ROLE =
  process.env.SUPABASE_SECRET_KEY ??
  // local demo service-role JWT (supabase CLI default)
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU';

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE);

function check(label: string, actual: unknown, expected: unknown) {
  console.log(`  ${label}`);
  expect({ [label]: actual }).toEqual({ [label]: expected });
}

function minutesAgo(min: number): string {
  return new Date(Date.now() - min * 60_000).toISOString();
}

it('segments DORA metrics and correlation by environment against real Postgres', async () => {
  // -- Clean slate -----------------------------------------------------------
  await supabase.from('platform_incident').delete().neq('id', '00000000-0000-0000-0000-000000000000');
  await supabase.from('platform_deployment').delete().neq('id', '00000000-0000-0000-0000-000000000000');

  // -- Seed: one successful gateway deploy per environment --------------------
  const { data: deploys, error: depErr } = await supabase
    .from('platform_deployment')
    .insert([
      {
        service: 'gateway', environment: 'staging', status: 'success',
        external_id: 'e2e-seg-stg', started_at: minutesAgo(95), completed_at: minutesAgo(90),
        first_commit_at: minutesAgo(300),
      },
      {
        service: 'gateway', environment: 'production', status: 'success',
        external_id: 'e2e-seg-prod', started_at: minutesAgo(85), completed_at: minutesAgo(80),
        first_commit_at: minutesAgo(400),
      },
    ])
    .select('id, environment');
  if (depErr) throw new Error(`deploy seed failed: ${depErr.message}`);
  const stgDeployId = deploys!.find((d) => d.environment === 'staging')!.id;
  const prodDeployId = deploys!.find((d) => d.environment === 'production')!.id;

  // -- Seed: incidents — one per env (inside the 60-min correlation window
  //    after their deploy), plus one with unknown environment ----------------
  const { error: incErr } = await supabase.from('platform_incident').insert([
    {
      // 30 min after the staging deploy; resolved in 15 min
      external_id: 'e2e-inc-stg', source: 'betterstack', monitor_name: 'Gateway Staging',
      service: 'gateway', environment: 'staging', status: 'resolved',
      url: 'https://api-stg.agentmark.co/health',
      started_at: minutesAgo(60), resolved_at: minutesAgo(45), resolution_ms: 15 * 60_000,
    },
    {
      // 40 min after the production deploy; resolved in 30 min
      external_id: 'e2e-inc-prod', source: 'betterstack', monitor_name: 'Gateway Production',
      service: 'gateway', environment: 'production', status: 'resolved',
      url: 'https://api.agentmark.co/health',
      started_at: minutesAgo(40), resolved_at: minutesAgo(10), resolution_ms: 30 * 60_000,
    },
    {
      external_id: 'e2e-inc-unknown', source: 'betterstack', monitor_name: 'Mystery Heartbeat',
      service: 'gateway', environment: null, status: 'resolved',
      started_at: minutesAgo(55), resolved_at: minutesAgo(5), resolution_ms: 50 * 60_000,
    },
  ]);
  if (incErr) throw new Error(`incident seed failed: ${incErr.message}`);

  // -- 1. REAL correlation against REAL Postgres ------------------------------
  const collector = new DoraCollectionService(supabase as never, '', 'production');
  const correlated = await collector.correlateIncidents();
  check('correlation links exactly the two known-env incidents', correlated, 2);

  const { data: after } = await supabase
    .from('platform_incident')
    .select('external_id, deployment_id')
    .order('external_id');
  const byId = new Map((after ?? []).map((r) => [r.external_id, r.deployment_id]));
  check('staging incident → staging deploy', byId.get('e2e-inc-stg'), stgDeployId);
  check('production incident → production deploy', byId.get('e2e-inc-prod'), prodDeployId);
  check('unknown-env incident stays uncorrelated', byId.get('e2e-inc-unknown'), null);

  // -- 2. REAL metrics queries: per-env isolation -----------------------------
  const metrics = new DoraMetricsService(supabase as never);

  const prod = await metrics.getMetrics('7d', null, 'production');
  const stg = await metrics.getMetrics('7d', null, 'staging');

  // MTTR: production must reflect ONLY the 90-min production incident;
  // staging ONLY the 30-min one. (Values are hours.)
  check('production MTTR = 0.5h (30-min incident only)', prod.metrics.mttr.value, 0.5);
  check('staging MTTR = 0.25h (15-min incident only)', stg.metrics.mttr.value, 0.25);

  // CFR: each env has 1 successful deploy, correlated to 1 incident → 100%,
  // computed strictly within the environment.
  check('production CFR = 100 (its own incident only)', prod.metrics.changeFailureRate.value, 100);
  check('staging CFR = 100 (its own incident only)', stg.metrics.changeFailureRate.value, 100);

  // DF: exactly one deploy each, never the other env's.
  check('production DF sample = 1 deploy', prod.metrics.deploymentFrequency.sampleSize, 1);
  check('staging DF sample = 1 deploy', stg.metrics.deploymentFrequency.sampleSize, 1);

  // MTTR sample sizes must not include the unknown-env incident.
  check('production MTTR sample = 1 incident', prod.metrics.mttr.sampleSize, 1);
  check('staging MTTR sample = 1 incident', stg.metrics.mttr.sampleSize, 1);

  // -- Cleanup ----------------------------------------------------------------
  await supabase.from('platform_incident').delete().neq('id', '00000000-0000-0000-0000-000000000000');
  await supabase.from('platform_deployment').delete().neq('id', '00000000-0000-0000-0000-000000000000');

  console.log('ALL SEGMENTATION CHECKS PASSED');
});
