#!/usr/bin/env tsx
/**
 * Dev loader for the coding-agent ingestion pipeline: scan the local
 * coding-agent corpus (claude-code + codex + cursor, via @outerlayer/capture's
 * source adapters) and ingest it into a local ClickHouse through the REAL
 * pipeline — tier gate, secret scrub, AgentSession→span mapping, agent
 * columns — exactly the transform the `outerlayer sync` endpoint runs.
 * Transport is direct ClickHouse insert (the queue is a cloud concern; the
 * mapping is the thing under test).
 *
 * Actor attribution for the multi-actor demo: sessions hash-split across
 * SEED_ACTORS deterministically (same session → same actor on re-run), so
 * team views render as a fleet, not a monologue. Re-runs are idempotent:
 * deterministic trace/span ids + ReplacingMergeTree(+FINAL reads) dedupe.
 *
 * Usage:
 *   TENANT_ID=... APP_ID=... tsx apps/gateway/scripts/ingest-agent-sessions.ts
 *
 * Env:
 *   TENANT_ID / APP_ID       REQUIRED — from seed-test-tenant.ts output
 *   CLICKHOUSE_URL           default http://127.0.0.1:8123
 *   CLICKHOUSE_PASSWORD      default dev_password (local compose)
 *   TENANT_TIER              default "full" (demo shows real content; the
 *                            tier matrix is covered by unit tests + one
 *                            metrics-tier spot session below)
 *   LIMIT                    optional cap on sessions (newest first)
 *
 * Diagnostics to stderr; a machine-readable summary line to stdout.
 */
import { createClient } from '@clickhouse/client';
import { scanAll, enrichSessionRepo } from '@outerlayer/capture';
import type { CaptureTier } from '@outerlayer/session-schema';
import { createHash } from 'node:crypto';
import { agentSessionToClickHouseRows, agentSessionSummaryRow } from '@repo/gateway-core/services/agent-session-converter';
import type { UserMeta } from '@repo/gateway-core/types';

const TENANT_ID = process.env.TENANT_ID;
const APP_ID = process.env.APP_ID;
if (!TENANT_ID || !APP_ID) {
  console.error('TENANT_ID and APP_ID are required (run seed-test-tenant.ts first)');
  process.exit(1);
}

const CLICKHOUSE_URL = process.env.CLICKHOUSE_URL ?? 'http://127.0.0.1:8123';
const CLICKHOUSE_PASSWORD = process.env.CLICKHOUSE_PASSWORD ?? 'dev_password';
const TENANT_TIER = (process.env.TENANT_TIER ?? 'full') as CaptureTier;
const LIMIT = process.env.LIMIT ? parseInt(process.env.LIMIT, 10) : undefined;

/** Demo fleet: deterministic hash-split so re-runs keep cohort membership. */
const SEED_ACTORS = ['devon', 'dev-avery'] as const;
function actorFor(sessionId: string): string {
  const h = createHash('sha256').update(sessionId).digest()[0]! % 100;
  return h < 70 ? SEED_ACTORS[0] : SEED_ACTORS[1]!; // 70/30 split
}

async function main(): Promise<void> {
  const clickhouse = createClient({
    url: CLICKHOUSE_URL,
    password: CLICKHOUSE_PASSWORD,
    clickhouse_settings: { async_insert: 0 },
  });

  const meta: UserMeta = { tenantId: TENANT_ID, appId: APP_ID } as UserMeta;

  let sessions = 0;
  let rows = 0;
  let skipped = 0;
  let batch: Record<string, unknown>[] = [];
  let summaries: Record<string, unknown>[] = [];
  // Image blobs, deduped by sha256 across the whole corpus (content addressing).
  // The dev loader can't reach R2 (no worker binding), so it lands the bytes in
  // the agent_blobs table — the SAME sha256-keyed contract the prod sync uses
  // against R2. Held in a Map so the same screenshot pasted into 40 sessions is
  // stored once. Flushed in bounded chunks alongside the span batches.
  const blobById = new Map<string, Record<string, unknown>>();
  let blobBuf: Record<string, unknown>[] = [];
  let blobCount = 0;
  // scanAll's callback is synchronous — chain inserts so batches stream while
  // the scan walks, and one await at the end drains the chain
  let pending: Promise<void> = Promise.resolve();

  const flush = (): void => {
    if (batch.length === 0 && summaries.length === 0 && blobBuf.length === 0) return;
    const chunk = batch; const sumChunk = summaries; const blobChunk = blobBuf;
    batch = []; summaries = []; blobBuf = [];
    pending = pending.then(async () => {
      if (chunk.length) await clickhouse.insert({ table: 'otel_traces', values: chunk, format: 'JSONEachRow' });
      if (sumChunk.length) await clickhouse.insert({ table: 'agent_session_summary', values: sumChunk, format: 'JSONEachRow' });
      if (blobChunk.length) await clickhouse.insert({ table: 'agent_blobs', values: blobChunk, format: 'JSONEachRow' });
      rows += chunk.length;
    });
  };

  const started = Date.now();
  const { report } = scanAll({
    ...(LIMIT ? { limit: LIMIT } : {}),
    onSession: (session, _entry, blobs) => {
      try {
        enrichSessionRepo(session); // resolve gitRepo (app key) + commit from cwd
        const converted = agentSessionToClickHouseRows(session, {
          meta,
          actorId: actorFor(session.id),
          tenantTier: TENANT_TIER,
        });
        batch.push(...converted);
        summaries.push(agentSessionSummaryRow(session, { meta, actorId: actorFor(session.id), tenantTier: TENANT_TIER }) as unknown as Record<string, unknown>);
        // Persist captured image bytes once per sha256 (prod path: R2 upload in
        // the sync endpoint). Only 'full' tier retains raw content — lower tiers
        // never captured the bytes, so blobs is empty there.
        for (const b of blobs) {
          if (blobById.has(b.sha256)) continue;
          const row = { TenantId: TENANT_ID, AppId: APP_ID, Sha256: b.sha256, MediaType: b.mediaType, Bytes: b.bytes, Data: b.data };
          blobById.set(b.sha256, row);
          blobBuf.push(row);
          blobCount += 1;
        }
        sessions += 1;
        if (batch.length >= 2000 || blobBuf.length >= 64) flush();
        if (sessions % 250 === 0) process.stderr.write(`  ${sessions} sessions → ${rows + batch.length} rows\n`);
      } catch (err) {
        skipped += 1;
        if (skipped <= 3) process.stderr.write(`  skip ${session.id.slice(0, 8)}: ${String(err).slice(0, 120)}\n`);
      }
      // flush in ~2k-row batches without await inside the sync callback:
      // scanAll is synchronous, so we buffer and flush after the walk
    },
  });

  flush();
  await pending;
  const secs = ((Date.now() - started) / 1000).toFixed(1);
  process.stderr.write(`scanned=${report.scanned} byAgent=${JSON.stringify(report.byAgent)}\n`);
  console.log(`ingested sessions=${sessions} rows=${rows} blobs=${blobCount} skipped=${skipped} tenant=${TENANT_ID} app=${APP_ID} in=${secs}s`);
  await clickhouse.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
