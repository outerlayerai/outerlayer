/**
 * Unit tests for POST /v1/agents/sync (openapi/routes/agents.ts,
 * SyncAgentSessions) and GET /v1/agents/blob/:sha256 (GetAgentBlob) — the
 * agent-session sync pipeline.
 *
 * Drives the handlers directly with a mocked context (the
 * create-score-validation.test.ts pattern): ClickHouse inserts are captured
 * per table, blob storage is an in-memory map, the tenant tier row and span
 * limit are mocked at their service seams.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createHash } from 'node:crypto';
import { NoopCacheStore } from '../../runtime/adapters/noop-cache-store';

// Capture ClickHouse inserts per table, and every client created (to assert
// each is closed — a leaked client per request is the reported 503 root cause).
const insertsByTable: Record<string, Array<Record<string, unknown>>> = {};
const createdClients: Array<{ insert: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn> }> = [];
let insertShouldThrow: Error | null = null;
// Simulate the observed drop: hide this many of the just-inserted summary rows
// from the post-insert verify read, so a test can prove the 503-and-retry path.
let verifyHideSummaryRows = 0;
// Force the verify query itself to error, to prove it fails OPEN (a broken
// verify must never turn a good insert into a false failure).
let verifyQueryShouldThrow = false;
// Return an EMPTY result set from the verify query (no rows), to exercise the
// `rows[0]?.n ?? 0` guard — an empty read must read as "nothing landed" → 503,
// not throw.
let verifyReturnEmpty = false;
// Hide one summary row from only the first N verify reads, then report
// honestly — the visibility-lag shape, where a write is real but not yet
// readable on the connection the verify happens to use.
let verifyShortForFirstNReads = 0;
// Every verify read the handler issued, so a test can pin that a short count
// was actually RE-READ rather than believed on sight.
let verifyReadCount = 0;
vi.mock('@clickhouse/client-web', () => ({
  createClient: vi.fn(() => {
    const client = {
      insert: vi.fn(async (params: { table: string; values: Array<Record<string, unknown>> }) => {
        if (insertShouldThrow) throw insertShouldThrow;
        (insertsByTable[params.table] ??= []).push(...params.values);
      }),
      // Faithful verify: uniqExact of the requested TraceIds actually present
      // in what we "inserted" into agent_session_summary, minus any the test
      // asked us to hide (to model the observed acked-but-not-landed drop).
      query: vi.fn(async (params: { query_params?: { ids?: string[] } }) => {
        if (verifyQueryShouldThrow) throw new Error('verify query boom');
        verifyReadCount += 1;
        if (verifyReturnEmpty) return { json: async () => [] as Array<{ n: number }> };
        const want = new Set(params.query_params?.ids ?? []);
        const present = new Set(
          (insertsByTable['agent_session_summary'] ?? [])
            .map((r) => String(r.TraceId))
            .filter((t) => want.has(t)),
        );
        const lagging = verifyReadCount <= verifyShortForFirstNReads ? 1 : 0;
        const n = Math.max(0, present.size - verifyHideSummaryRows - lagging);
        return { json: async () => [{ n }] };
      }),
      close: vi.fn(async () => {}),
    };
    createdClients.push(client);
    return client;
  }),
}));

// Tenant tier row — mutated per test.
let tenantTierRow: { agent_capture_tier: string } | null = { agent_capture_tier: 'redacted' };
vi.mock('../../lib/system-client', () => ({
  asServiceClient: (client: unknown) => client,
  createSystemAdminClient: vi.fn(() => ({
    from: vi.fn(() => ({
      select: () => ({
        eq: () => ({
          single: async () => ({ data: tenantTierRow }),
        }),
      }),
    })),
  })),
}));

// Span limit — mutated per test.
let limitResult = { allowed: true, currentCount: 5, limit: 100 };
vi.mock('../../services', () => ({
  createClickHouseService: vi.fn(() => ({})),
  createSpanLimitService: vi.fn(() => ({
    checkSpanLimit: vi.fn(async () => limitResult),
  })),
}));

const claimFirstTrace = vi.fn(async () => true);
vi.mock('../../lib/first-trace', () => ({
  claimFirstTrace: (...args: unknown[]) => claimFirstTrace(...(args as [])),
}));

// In-memory blob storage.
const blobStore = new Map<string, { bytes: Uint8Array; contentType: string }>();
let blobStorageAvailable = true;
vi.mock('../../lib/blob-storage', () => ({
  createBlobStorage: vi.fn(() => {
    if (!blobStorageAvailable) throw new Error('no R2 binding');
    return {
      put: async (key: string, bytes: Uint8Array, contentType: string) => {
        blobStore.set(key, { bytes, contentType });
      },
      get: async (key: string) => blobStore.get(key)?.bytes ?? null,
    };
  }),
}));

import { createClient } from '@clickhouse/client-web';
import type { AppContext } from '../routes/_shared';
import {
  SyncAgentSessions,
  GetAgentBlob,
  resolveTenantCaptureTier,
  agentBlobKey,
  MAX_SYNC_REQUEST_BYTES,
} from '../routes/agents';
import { PR_COMMENT_QUEUE_DEBOUNCE_SECONDS } from '../../types/queue-messages';

const createClientMock = vi.mocked(createClient);

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

function agentSession(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    id: '5c3a1b2d-4e6f-4708-9a1b-2c3d4e5f6a7b',
    agent: { type: 'claude-code', version: '2.1.201' },
    env: { cwd: '/home/dev/acme', gitRepo: 'github.com/acme/api', gitBranch: 'main' },
    startedAt: '2026-07-01T10:00:00.000Z',
    endedAt: '2026-07-01T11:00:00.000Z',
    models: ['claude-opus-4-8'],
    turns: [
      { index: 0, role: 'user', toolCalls: [], text: 'Fix the build', ts: '2026-07-01T10:00:01.000Z' },
      {
        index: 1,
        role: 'assistant',
        text: 'Running the build.',
        model: 'claude-opus-4-8',
        costUsd: 0.25,
        usage: { in: 100, out: 50, cacheRead: 1000, cacheCreate: 10 },
        toolCalls: [
          {
            name: 'Bash',
            status: 'error',
            isEdit: false,
            errorSignature: 'yarn build exited with code 1',
            input: '{"command":"ANTHROPIC_KEY=sk-ant-abc123def456ghi789jkl yarn build"}',
            output: 'error TS2307',
            durationMs: 1200,
          },
        ],
        ts: '2026-07-01T10:00:05.000Z',
      },
    ],
    events: [],
    totals: { inputTokens: 1100, outputTokens: 50, cacheReadTokens: 1000, cacheCreationTokens: 10, costUsd: 0.25 },
    title: 'Fix the build',
    captureTier: 'full',
    warnings: [],
    ...over,
  };
}

type UserOver = Partial<{
  actorMembershipId: string;
  apiKeyId: string;
}>;

function ctxFor(
  body: Record<string, unknown>,
  userOver: UserOver = {},
  reqHeaders: Record<string, string> = {},
  envOver: Record<string, unknown> = {},
): { ctx: AppContext; status: () => number; json: () => any; headers: () => Record<string, string> } {
  let captured: { body: unknown; status: number; headers: Record<string, string> } = {
    body: undefined,
    status: 200,
    headers: {},
  };
  const lowerHeaders: Record<string, string> = Object.fromEntries(
    Object.entries(reqHeaders).map(([k, v]) => [k.toLowerCase(), v]),
  );
  const ctx = {
    get: (k: string) => {
      if (k === 'user') {
        return { appId: 'app-1', tenantId: 'tenant-1', apiKeyId: 'key_abc', ...userOver };
      }
      // The quota gate builds its cache from gtx.
      if (k === 'gtx') {
        return {
          cacheL2Store: new NoopCacheStore(),
          execCtx: { waitUntil: () => {}, passThroughOnException: () => {} },
        };
      }
      return undefined;
    },
    env: { CLICKHOUSE_HOST: 'http://localhost:8123', CLICKHOUSE_PASSWORD: 'x', ...envOver },
    req: {
      json: async () => body,
      method: 'POST',
      path: '/v1/agents/sync',
      header: (name: string) => lowerHeaders[name.toLowerCase()],
    },
    json: (b: unknown, s?: number | { status?: number; headers?: Record<string, string> }) => {
      const status = typeof s === 'number' ? s : (s?.status ?? 200);
      const headers = typeof s === 'object' && s ? (s.headers ?? {}) : {};
      captured = { body: b, status, headers };
      return new Response(JSON.stringify(b), { status });
    },
  } as unknown as AppContext;
  return {
    ctx,
    status: () => captured.status,
    json: () => captured.body,
    headers: () => captured.headers,
  };
}

const helloBytes = new TextEncoder().encode('hello');
const helloSha = createHash('sha256').update('hello').digest('hex');
const helloB64 = Buffer.from('hello').toString('base64');

beforeEach(() => {
  for (const key of Object.keys(insertsByTable)) delete insertsByTable[key];
  createdClients.length = 0;
  createClientMock.mockClear();
  insertShouldThrow = null;
  verifyHideSummaryRows = 0;
  verifyQueryShouldThrow = false;
  verifyReturnEmpty = false;
  verifyShortForFirstNReads = 0;
  verifyReadCount = 0;
  blobStore.clear();
  blobStorageAvailable = true;
  tenantTierRow = { agent_capture_tier: 'redacted' };
  limitResult = { allowed: true, currentCount: 5, limit: 100 };
  claimFirstTrace.mockClear();
});

// ---------------------------------------------------------------------------
// POST /v1/agents/sync
// ---------------------------------------------------------------------------

describe('SyncAgentSessions', () => {
  it('rejects a malformed body with 400 invalid_request_body', async () => {
    const { ctx, status, json } = ctxFor({ schemaVersion: 1 });
    await new SyncAgentSessions({} as never).handle(ctx);
    expect(status()).toBe(400);
    expect((json() as { error: { code: string } }).error.code).toBe('invalid_request_body');
  });

  it('ingests a valid session: spans + summary rows, tier-clamped and scrubbed', async () => {
    const { ctx, status, json } = ctxFor(
      {
        schemaVersion: 1,
        sessions: [agentSession({ outcome: { prNumber: 512, prUrl: 'https://github.com/acme/api/pull/512' } })],
      },
      { actorMembershipId: 'membership-42' },
    );
    await new SyncAgentSessions({} as never).handle(ctx);

    expect(status()).toBe(200);
    const data = (json() as { data: Record<string, unknown> }).data;
    expect(data.accepted).toEqual(['5c3a1b2d-4e6f-4708-9a1b-2c3d4e5f6a7b']);
    expect(data.rejected).toEqual([]);
    expect(data.tenantTier).toBe('redacted');

    const spans = insertsByTable['otel_traces'] ?? [];
    expect(spans.length).toBeGreaterThan(0);
    // Deterministic trace id: UUID with dashes stripped.
    expect(spans[0]!.TraceId).toBe('5c3a1b2d4e6f47089a1b2c3d4e5f6a7b');
    // Every row attributed to the key's bound membership + clamped tier.
    for (const row of spans) {
      expect(row.ActorId).toBe('membership-42');
      expect(row.CaptureTier).toBe('redacted');
      expect(row.TenantId).toBe('tenant-1');
      expect(row.AppId).toBe('app-1');
    }
    // Tenant ceiling 'redacted' strips content: the client-sent 'full' session's
    // message text must not be stored anywhere in the span rows.
    const allRows = JSON.stringify(spans);
    expect(allRows).not.toContain('Fix the build');
    expect(allRows).not.toContain('Running the build.');
    // The secret never survives even when content would (scrub is tier-independent).
    expect(allRows).not.toContain('sk-ant-abc123def456ghi789jkl');

    const summaries = insertsByTable['agent_session_summary'] ?? [];
    expect(summaries).toHaveLength(1);
    expect(summaries[0]!.SessionId).toBe('5c3a1b2d-4e6f-4708-9a1b-2c3d4e5f6a7b');
    expect(summaries[0]!.CaptureTier).toBe('redacted');
    expect(summaries[0]!.GitRepo).toBe('github.com/acme/api');
    // pr-link outcome is redacted-tier: it must SURVIVE the redacted ceiling
    // (session→PR attribution is the point of storing it).
    expect(summaries[0]!.PrNumber).toBe(512);
    expect(summaries[0]!.PrUrl).toBe('https://github.com/acme/api/pull/512');
  });

  it('inserts synchronously so the ack means the rows are durable, not just buffered', async () => {
    // The endpoint acks only after these inserts resolve, and the CLI advances
    // its sync watermark past acked sessions. If the insert inherited an
    // async-insert profile, insert() could return once the block is merely
    // buffered — acking sessions whose rows are still in flight (the source of
    // an "acked N but fewer than N readable" flake). Pin the honest settings.
    const { ctx, status } = ctxFor({ schemaVersion: 1, sessions: [agentSession()] });
    await new SyncAgentSessions({} as never).handle(ctx);
    expect(status()).toBe(200);
    expect(createClientMock).toHaveBeenCalledWith(
      expect.objectContaining({
        clickhouse_settings: { async_insert: 0, wait_for_async_insert: 1 },
      }),
    );
  });

  it('sheds as 503 when a just-inserted summary row is not readable back (acked-but-not-durable)', async () => {
    // The insert "succeeds", but one of its summary rows never becomes
    // readable — the observed silent-loss signature. Verify-before-ack must
    // turn that into a 503 so the CLI's idempotent retry re-lands it, never a
    // 200 that the watermark would skip forever.
    verifyHideSummaryRows = 1;
    const { ctx, status, json } = ctxFor({ schemaVersion: 1, sessions: [agentSession()] });
    await new SyncAgentSessions({} as never).handle(ctx);

    expect(status()).toBe(503);
    expect((json() as { error: { code: string } }).error.code).toBe('service_unavailable');
  });

  it('acks 200 when every inserted summary row reads back', async () => {
    // The happy path: verify confirms the row landed, so the sync is acked.
    const { ctx, status, json } = ctxFor({ schemaVersion: 1, sessions: [agentSession()] });
    await new SyncAgentSessions({} as never).handle(ctx);

    expect(status()).toBe(200);
    expect((json() as { data: { accepted: string[] } }).data.accepted).toHaveLength(1);
  });

  it('treats an empty verify result as "nothing landed" → 503 (not a throw)', async () => {
    // The verify read comes back with no rows at all. That must read as 0
    // landed → shed for retry, via the `rows[0]?.n ?? 0` guard — never a crash
    // that the fail-open catch would mask into a false 200.
    verifyReturnEmpty = true;
    const { ctx, status, json } = ctxFor({ schemaVersion: 1, sessions: [agentSession()] });
    await new SyncAgentSessions({} as never).handle(ctx);

    expect(status()).toBe(503);
    expect((json() as { error: { code: string } }).error.code).toBe('service_unavailable');
  });

  it('re-reads a short verify instead of shedding, so visibility lag acks rather than 503s', async () => {
    // The write is real but not yet readable on the connection the verify uses
    // — the verify opens its own client, so it can be served by a node that has
    // not caught up. Believing the first short read sheds a good insert, and
    // the caller then retries the identical batch into the same window, so the
    // shed can repeat until it gives up. Re-reading turns that into an ack.
    verifyShortForFirstNReads = 2;
    const { ctx, status, json } = ctxFor({ schemaVersion: 1, sessions: [agentSession()] });
    await new SyncAgentSessions({} as never).handle(ctx);

    expect(status()).toBe(200);
    expect((json() as { data: { accepted: string[] } }).data.accepted).toHaveLength(1);
    // Pins the re-read itself: two short reads, then the one that satisfied it.
    expect(verifyReadCount).toBe(3);
  });

  it('stops re-reading the moment the rows read back, rather than always paying the full backoff', async () => {
    // A verify that landed first try must cost exactly one read — the retry
    // budget is there for the lagging case, not a tax on every sync.
    const { ctx, status } = ctxFor({ schemaVersion: 1, sessions: [agentSession()] });
    await new SyncAgentSessions({} as never).handle(ctx);

    expect(status()).toBe(200);
    expect(verifyReadCount).toBe(1);
  });

  it('still sheds when the rows never become readable, however many times it re-reads', async () => {
    // The safety property the re-read must not erode: a row that genuinely
    // never lands stays short through every attempt and must still 503, or the
    // caller's watermark skips it forever.
    verifyHideSummaryRows = 1;
    const { ctx, status, json } = ctxFor({ schemaVersion: 1, sessions: [agentSession()] });
    await new SyncAgentSessions({} as never).handle(ctx);

    expect(status()).toBe(503);
    expect((json() as { error: { code: string } }).error.code).toBe('service_unavailable');
    expect(verifyReadCount).toBeGreaterThan(1);
  });

  it('acks a batch carrying the same session twice, which reads back as ONE distinct trace id', async () => {
    // The verify counts DISTINCT TraceIds, so it must be compared against the
    // number of distinct ids expected. Compared against the ROW count, a batch
    // with a repeated session is unsatisfiable — 1 distinct id can never reach
    // 2 rows — so it would shed on every attempt and fail permanently.
    const { ctx, status, json } = ctxFor({
      schemaVersion: 1,
      sessions: [agentSession(), agentSession()],
    });
    await new SyncAgentSessions({} as never).handle(ctx);

    expect(status()).toBe(200);
    expect((json() as { data: { accepted: string[] } }).data.accepted).toHaveLength(2);
    expect(verifyReadCount).toBe(1);
  });

  it('fails OPEN: a verify query that errors must not fail a good insert', async () => {
    // A broken verify read must never turn a successful insert into a false
    // 503 — only a DEFINITIVE short count sheds.
    verifyQueryShouldThrow = true;
    const { ctx, status } = ctxFor({ schemaVersion: 1, sessions: [agentSession()] });
    await new SyncAgentSessions({} as never).handle(ctx);

    expect(status()).toBe(200);
  });

  it('stores full content when the tenant ceiling allows it', async () => {
    tenantTierRow = { agent_capture_tier: 'full' };
    const { ctx } = ctxFor({ schemaVersion: 1, sessions: [agentSession()] });
    await new SyncAgentSessions({} as never).handle(ctx);
    const allRows = JSON.stringify(insertsByTable['otel_traces'] ?? []);
    expect(allRows).toContain('Fix the build');
    // ...but the scrub still ran.
    expect(allRows).not.toContain('sk-ant-abc123def456ghi789jkl');
    expect(allRows).toContain('[SCRUBBED:anthropic-key]');
  });

  it('rejects an invalid session without failing the batch', async () => {
    const bad = agentSession({ id: undefined });
    delete (bad as Record<string, unknown>).id;
    const { ctx, status, json } = ctxFor({ schemaVersion: 1, sessions: [bad, agentSession()] });
    await new SyncAgentSessions({} as never).handle(ctx);

    expect(status()).toBe(200);
    const data = (json() as { data: { accepted: string[]; rejected: Array<{ index: number; reason: string }> } }).data;
    expect(data.accepted).toEqual(['5c3a1b2d-4e6f-4708-9a1b-2c3d4e5f6a7b']);
    expect(data.rejected).toHaveLength(1);
    expect(data.rejected[0]!.index).toBe(0);
    expect(data.rejected[0]!.reason).toContain('schema:');
  });

  it('attributes to the key itself when no membership is bound', async () => {
    const { ctx } = ctxFor({ schemaVersion: 1, sessions: [agentSession()] });
    await new SyncAgentSessions({} as never).handle(ctx);
    const spans = insertsByTable['otel_traces'] ?? [];
    expect(spans[0]!.ActorId).toBe('key:key_abc');
  });

  it('dual-writes a valid blob and rejects a sha mismatch', async () => {
    const { ctx, json } = ctxFor({
      schemaVersion: 1,
      sessions: [agentSession()],
      blobs: [
        { sha256: helloSha, mediaType: 'image/png', bytes: 5, data: helloB64 },
        { sha256: 'a'.repeat(64), mediaType: 'image/png', bytes: 5, data: helloB64 },
      ],
    });
    await new SyncAgentSessions({} as never).handle(ctx);

    const data = (json() as { data: { blobsStored: number; rejected: Array<{ id?: string; reason: string }> } }).data;
    expect(data.blobsStored).toBe(1);
    expect(data.rejected).toEqual([
      { index: -1, id: 'a'.repeat(64), reason: 'blob: sha256 does not match content' },
    ]);

    // Object storage copy under the content-addressed, tenant-scoped key.
    const stored = blobStore.get(agentBlobKey('tenant-1', 'app-1', helloSha));
    expect(stored?.contentType).toBe('image/png');
    expect(Array.from(stored?.bytes ?? [])).toEqual(Array.from(helloBytes));

    // ClickHouse copy (what the dashboard BFF serves).
    const rows = insertsByTable['agent_blobs'] ?? [];
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({
      TenantId: 'tenant-1',
      AppId: 'app-1',
      Sha256: helloSha,
      MediaType: 'image/png',
      Bytes: 5,
      Data: helloB64,
    });
  });

  it('still stores blobs in ClickHouse when object storage is unavailable', async () => {
    blobStorageAvailable = false;
    const { ctx, json } = ctxFor({
      schemaVersion: 1,
      sessions: [agentSession()],
      blobs: [{ sha256: helloSha, mediaType: 'image/png', bytes: 5, data: helloB64 }],
    });
    await new SyncAgentSessions({} as never).handle(ctx);
    expect((json() as { data: { blobsStored: number } }).data.blobsStored).toBe(1);
    expect(insertsByTable['agent_blobs']).toHaveLength(1);
    expect(blobStore.size).toBe(0);
  });

  it('deduplicates repeated blobs by sha within one request', async () => {
    // Same content twice: the second must be skipped, not stored again.
    const { ctx, json } = ctxFor({
      schemaVersion: 1,
      sessions: [agentSession()],
      blobs: [
        { sha256: helloSha, mediaType: 'image/png', bytes: 5, data: helloB64 },
        { sha256: helloSha, mediaType: 'image/png', bytes: 5, data: helloB64 },
      ],
    });
    await new SyncAgentSessions({} as never).handle(ctx);
    expect((json() as { data: { blobsStored: number } }).data.blobsStored).toBe(1);
    expect(insertsByTable['agent_blobs']).toHaveLength(1);
  });

  it('rejects a blob whose data is not valid base64', async () => {
    const { ctx, json } = ctxFor({
      schemaVersion: 1,
      sessions: [agentSession()],
      blobs: [{ sha256: 'a'.repeat(64), mediaType: 'image/png', bytes: 5, data: '!!!not-base64!!!' }],
    });
    await new SyncAgentSessions({} as never).handle(ctx);
    const data = (json() as { data: { blobsStored: number; rejected: Array<{ index: number; id?: string; reason: string }> } }).data;
    expect(data.blobsStored).toBe(0);
    expect(data.rejected).toEqual([{ index: -1, id: 'a'.repeat(64), reason: 'blob: data is not valid base64' }]);
    expect(insertsByTable['agent_blobs']).toBeUndefined();
  });

  it('rejects a blob whose decoded size exceeds the per-blob cap', async () => {
    // Valid base64 (all 'A' → 0x00 bytes) decoding to just over 2 MiB, but the
    // base64 string stays under the 8 MiB whole-request ceiling so it reaches
    // the per-blob size check rather than the 413 shed.
    const oversized = 'A'.repeat(2 * 1024 * 1024 * 4 / 3 + 4);
    const { ctx, json } = ctxFor({
      schemaVersion: 1,
      sessions: [agentSession()],
      blobs: [{ sha256: 'b'.repeat(64), mediaType: 'image/png', bytes: 5, data: oversized }],
    });
    await new SyncAgentSessions({} as never).handle(ctx);
    const data = (json() as { data: { blobsStored: number; rejected: Array<{ index: number; id?: string; reason: string }> } }).data;
    expect(data.blobsStored).toBe(0);
    expect(data.rejected).toEqual([
      { index: -1, id: 'b'.repeat(64), reason: `blob: exceeds ${2 * 1024 * 1024} bytes` },
    ]);
  });

  it('declares the 200 success response schema (not an empty content object)', () => {
    const route = new SyncAgentSessions({} as never) as unknown as {
      schema: { responses: Record<string, { content?: Record<string, { schema?: { shape?: Record<string, unknown> } }> }> };
    };
    const ok = route.schema.responses['200'];
    // Kills `content: {}` and `content: { 'application/json': {} }`.
    expect(ok?.content?.['application/json']?.schema?.shape).toHaveProperty('data');
  });

  it('returns 429 span_limit_exceeded when the monthly unit limit is hit', async () => {
    limitResult = { allowed: false, currentCount: 100, limit: 100 };
    const { ctx, status, json } = ctxFor({ schemaVersion: 1, sessions: [agentSession()] });
    await new SyncAgentSessions({} as never).handle(ctx);
    expect(status()).toBe(429);
    expect((json() as { error: { code: string } }).error.code).toBe('span_limit_exceeded');
    expect(insertsByTable['otel_traces']).toBeUndefined();
  });

  it('routes blob + trace + summary through ONE client, built with the CH config, and closes it', async () => {
    const { ctx, status } = ctxFor({
      schemaVersion: 1,
      sessions: [agentSession()],
      blobs: [{ sha256: helloSha, mediaType: 'image/png', bytes: 5, data: helloB64 }],
    });
    await new SyncAgentSessions({} as never).handle(ctx);

    expect(status()).toBe(200);
    // A single client serves every INSERT (not one per table — leaking one per
    // table is what exhausts a warm isolate into a bare 503), and the
    // verify-before-ack read opens exactly one more. Both are closed: NO client
    // leaks, which is the property that matters.
    expect(createdClients).toHaveLength(2);
    for (const client of createdClients) expect(client.close).toHaveBeenCalledTimes(1);
    // Built against the resolved ClickHouse endpoint, not a defaulted/empty
    // config, and pinned to synchronous inserts so the ack means durable —
    // for EVERY client (both the insert and the verify read), so neither can
    // silently drop the endpoint or the durability settings.
    const expectedConfig = {
      url: 'http://localhost:8123',
      password: 'x',
      clickhouse_settings: { async_insert: 0, wait_for_async_insert: 1 },
    };
    expect(createClientMock).toHaveBeenCalledTimes(2);
    for (const call of createClientMock.mock.calls) expect(call[0]).toEqual(expectedConfig);
    // It really did the work — close isn't hiding a no-op path.
    expect(insertsByTable['otel_traces']?.length ?? 0).toBeGreaterThan(0);
    expect(insertsByTable['agent_blobs']).toHaveLength(1);
  });

  it('opens no client and inserts nothing when there is nothing to write', async () => {
    // A single malformed session: nothing accepted, no blobs. The handler must
    // still 200 (per-session rejection is not a batch failure) WITHOUT opening a
    // ClickHouse client or inserting empty batches.
    const bad = agentSession();
    delete (bad as Record<string, unknown>).id;
    const { ctx, status, json } = ctxFor({ schemaVersion: 1, sessions: [bad] });
    await new SyncAgentSessions({} as never).handle(ctx);

    expect(status()).toBe(200);
    expect((json() as { data: { accepted: string[] } }).data.accepted).toEqual([]);
    expect(createdClients).toHaveLength(0);
    expect(insertsByTable['otel_traces']).toBeUndefined();
    expect(insertsByTable['agent_session_summary']).toBeUndefined();
    expect(insertsByTable['agent_blobs']).toBeUndefined();
  });

  it('never inserts an empty agent_blobs batch for a blob-less session', async () => {
    // spanRows/summaryRows are non-empty but blobRows is empty — the empty blob
    // batch must be filtered out, not inserted as [].
    const { ctx, status } = ctxFor({ schemaVersion: 1, sessions: [agentSession()] });
    await new SyncAgentSessions({} as never).handle(ctx);

    expect(status()).toBe(200);
    expect(insertsByTable['agent_blobs']).toBeUndefined();
    expect(insertsByTable['otel_traces']?.length ?? 0).toBeGreaterThan(0);
    // One client for the two non-empty insert batches + one for the
    // verify-before-ack read; both closed, none leaked.
    expect(createdClients).toHaveLength(2);
    for (const client of createdClients) expect(client.close).toHaveBeenCalledTimes(1);
  });

  it('signals a structured 503 with Retry-After when a ClickHouse insert fails, and still closes the client', async () => {
    insertShouldThrow = new Error('ClickHouse 503: too many simultaneous queries');
    const { ctx, status, json, headers } = ctxFor({ schemaVersion: 1, sessions: [agentSession()] });
    await new SyncAgentSessions({} as never).handle(ctx);

    expect(status()).toBe(503);
    expect((json() as { error: { code: string } }).error.code).toBe('service_unavailable');
    // The client's per-batch backoff reads this to distinguish 'retry' from 'broken'.
    expect(headers()['Retry-After']).toBe('30');
    // The failing request must not leak the client either.
    expect(createdClients).toHaveLength(1);
    expect(createdClients[0]!.close).toHaveBeenCalledTimes(1);
  });

  it('sheds an over-ceiling request with a structured 413 before parsing or opening a client', async () => {
    const { ctx, status, json } = ctxFor(
      { schemaVersion: 1, sessions: [agentSession()] },
      {},
      { 'content-length': String(MAX_SYNC_REQUEST_BYTES + 1) },
    );
    await new SyncAgentSessions({} as never).handle(ctx);

    expect(status()).toBe(413);
    const body = json() as { error: { code: string; limit: number } };
    expect(body.error.code).toBe('payload_too_large');
    expect(body.error.limit).toBe(MAX_SYNC_REQUEST_BYTES);
    // Shed before any downstream work: no ClickHouse client, no rows.
    expect(createdClients).toHaveLength(0);
    expect(insertsByTable['otel_traces']).toBeUndefined();
  });

  it('admits a request whose Content-Length is exactly the ceiling (boundary is inclusive)', async () => {
    const { ctx, status } = ctxFor(
      { schemaVersion: 1, sessions: [agentSession()] },
      {},
      { 'content-length': String(MAX_SYNC_REQUEST_BYTES) },
    );
    await new SyncAgentSessions({} as never).handle(ctx);
    expect(status()).toBe(200);
    expect(insertsByTable['otel_traces']?.length ?? 0).toBeGreaterThan(0);
  });

  it('sheds an oversized blob payload with 413 when Content-Length is absent (chunked upload)', async () => {
    // No Content-Length header: the blob-weight guard must still catch it.
    const oversizedData = 'A'.repeat(MAX_SYNC_REQUEST_BYTES + 4);
    const { ctx, status, json } = ctxFor({
      schemaVersion: 1,
      sessions: [agentSession()],
      blobs: [{ sha256: helloSha, mediaType: 'image/png', bytes: 5, data: oversizedData }],
    });
    await new SyncAgentSessions({} as never).handle(ctx);

    expect(status()).toBe(413);
    expect((json() as { error: { code: string } }).error.code).toBe('payload_too_large');
    expect(createdClients).toHaveLength(0);
    expect(insertsByTable['agent_blobs']).toBeUndefined();
  });

  it('declares a 413 payload-too-large response in its schema', () => {
    const route = new SyncAgentSessions({} as never) as unknown as {
      schema: { responses: Record<string, { description?: string }> };
    };
    expect(route.schema.responses['413']?.description).toContain('byte ceiling');
  });

  it('declares a 503 backpressure response with a Retry-After header in its schema', () => {
    const route = new SyncAgentSessions({} as never) as unknown as {
      schema: {
        responses: Record<
          string,
          { description?: string; content?: unknown; headers?: { shape?: Record<string, unknown> } }
        >;
      };
    };
    const res503 = route.schema.responses['503'];
    // The response must carry the error envelope + Retry-After header, not be `{}`.
    expect(res503?.description).toContain('temporarily unavailable');
    expect(res503?.headers?.shape).toHaveProperty('Retry-After');
  });
});

// ---------------------------------------------------------------------------
// PR_COMMENT_QUEUE enqueue (queue producer at ingest)
// ---------------------------------------------------------------------------

describe('SyncAgentSessions PR_COMMENT_QUEUE enqueue', () => {
  function queueMock() {
    return { sendBatch: vi.fn(async () => {}) };
  }

  it('enqueues one message per distinct (tenant, repo, prNumber)', async () => {
    const queue = queueMock();
    const { ctx, status } = ctxFor(
      {
        schemaVersion: 1,
        sessions: [
          agentSession({
            id: 'aaaaaaaa-0000-4000-8000-000000000001',
            outcome: { prNumber: 512, prUrl: 'https://github.com/acme/api/pull/512' },
          }),
        ],
      },
      {},
      {},
      { PR_COMMENT_QUEUE: queue },
    );
    await new SyncAgentSessions({} as never).handle(ctx);
    expect(status()).toBe(200);
    expect(queue.sendBatch).toHaveBeenCalledTimes(1);
    const requests = queue.sendBatch.mock.calls[0]![0] as Array<{
      body: { tenantId: string; repository: string; prNumber: number; enqueuedAt: number };
      delaySeconds: number;
    }>;
    expect(requests).toHaveLength(1);
    // The CANONICAL bare owner/repo, not ClickHouse's host-qualified
    // GitRepo: the producer, the queue consumer and the dashboard
    // orchestrator all key the comment's identity off one spelling, and two
    // spellings would mean two identity rows — two comments on one PR.
    expect(requests[0]!.body).toMatchObject({
      tenantId: 'tenant-1',
      repository: 'acme/api',
      prNumber: 512,
    });
    // Delayed delivery IS the debounce — asserted against the single named
    // constant, not a hardcoded literal.
    expect(requests[0]!.delaySeconds).toBe(PR_COMMENT_QUEUE_DEBOUNCE_SECONDS);
  });

  it('dedupes multi-PR / multi-session overlap within one request', async () => {
    const queue = queueMock();
    const { ctx, status } = ctxFor(
      {
        schemaVersion: 1,
        sessions: [
          agentSession({
            id: 'aaaaaaaa-0000-4000-8000-000000000001',
            outcome: {
              prs: [
                { prNumber: 512, prUrl: 'https://github.com/acme/api/pull/512' },
                { prNumber: 600, prUrl: 'https://github.com/acme/api/pull/600' },
              ],
            },
          }),
          agentSession({
            id: 'aaaaaaaa-0000-4000-8000-000000000002',
            outcome: { prNumber: 512, prUrl: 'https://github.com/acme/api/pull/512' },
          }),
        ],
      },
      {},
      {},
      { PR_COMMENT_QUEUE: queue },
    );
    await new SyncAgentSessions({} as never).handle(ctx);
    expect(status()).toBe(200);
    // Two distinct sessions both touching PR 512, plus one touching PR 600 —
    // must collapse to exactly two messages, not three.
    expect(queue.sendBatch).toHaveBeenCalledTimes(1);
    const requests = queue.sendBatch.mock.calls[0]![0] as Array<{
      body: { tenantId: string; repository: string; prNumber: number };
    }>;
    const prNumbers = requests.map((r) => r.body.prNumber).sort((a, b) => a - b);
    expect(prNumbers).toEqual([512, 600]);
  });

  it('does not enqueue when no session in the batch carries a PR link', async () => {
    const queue = queueMock();
    const { ctx, status } = ctxFor(
      { schemaVersion: 1, sessions: [agentSession()] },
      {},
      {},
      { PR_COMMENT_QUEUE: queue },
    );
    await new SyncAgentSessions({} as never).handle(ctx);
    expect(status()).toBe(200);
    expect(queue.sendBatch).not.toHaveBeenCalled();
  });

  it('no-ops silently when PR_COMMENT_QUEUE is unbound (queue-less deployment degrades to the cron sweep)', async () => {
    // No PR_COMMENT_QUEUE in envOver at all — mirrors self-host / local dev.
    const { ctx, status, json } = ctxFor({
      schemaVersion: 1,
      sessions: [agentSession({ outcome: { prNumber: 512, prUrl: 'https://github.com/acme/api/pull/512' } })],
    });
    await new SyncAgentSessions({} as never).handle(ctx);
    expect(status()).toBe(200);
    expect((json() as { data: { accepted: string[] } }).data.accepted).toHaveLength(1);
  });

  it('swallows a sendBatch throw without failing the sync', async () => {
    const queue = {
      sendBatch: vi.fn(async () => {
        throw new Error('queue unavailable');
      }),
    };
    const { ctx, status, json } = ctxFor(
      {
        schemaVersion: 1,
        sessions: [agentSession({ outcome: { prNumber: 512, prUrl: 'https://github.com/acme/api/pull/512' } })],
      },
      {},
      {},
      { PR_COMMENT_QUEUE: queue },
    );
    await new SyncAgentSessions({} as never).handle(ctx);
    expect(status()).toBe(200);
    expect((json() as { data: { accepted: string[] } }).data.accepted).toHaveLength(1);
    expect(queue.sendBatch).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// resolveTenantCaptureTier
// ---------------------------------------------------------------------------

describe('resolveTenantCaptureTier', () => {
  it('defaults to full on a missing/invalid row, but a READ FAILURE stays conservative', async () => {
    // Content is the product: no configured ceiling means full.
    const missing = {
      from: () => ({ select: () => ({ eq: () => ({ single: async () => ({ data: null }) }) }) }),
    };
    expect(await resolveTenantCaptureTier(missing as never, 't-1')).toBe('full');

    const garbage = {
      from: () => ({ select: () => ({ eq: () => ({ single: async () => ({ data: { agent_capture_tier: 'everything' } }) }) }) }),
    };
    expect(await resolveTenantCaptureTier(garbage as never, 't-1')).toBe('full');

    // A DB blip must NOT fall open: a tenant that deliberately opted DOWN
    // would otherwise upload content because of a transient read error.
    const throwing = {
      from: () => ({ select: () => ({ eq: () => ({ single: async () => { throw new Error('boom'); } }) }) }),
    };
    expect(await resolveTenantCaptureTier(throwing as never, 't-1')).toBe('redacted');
  });

  it('honors a configured tier', async () => {
    const full = {
      from: () => ({ select: () => ({ eq: () => ({ single: async () => ({ data: { agent_capture_tier: 'full' } }) }) }) }),
    };
    expect(await resolveTenantCaptureTier(full as never, 't-1')).toBe('full');
  });
});

// ---------------------------------------------------------------------------
// GET /v1/agents/blob/:sha256
// ---------------------------------------------------------------------------

describe('GetAgentBlob', () => {
  function blobCtx(sha256: string): { ctx: AppContext; captured: { status: number; body: unknown } } {
    const captured = { status: 200, body: undefined as unknown };
    const ctx = {
      get: (k: string) => (k === 'user' ? { appId: 'app-1', tenantId: 'tenant-1' } : undefined),
      env: {},
      json: (b: unknown, s?: number) => {
        captured.status = s ?? 200;
        captured.body = b;
        return new Response(JSON.stringify(b), { status: s ?? 200 });
      },
    } as unknown as AppContext;
    const route = new GetAgentBlob({} as never);
    // chanfana resolves params via getValidatedData; stub it for a direct drive.
    (route as unknown as { getValidatedData: () => Promise<{ params: { sha256: string } }> }).getValidatedData =
      async () => ({ params: { sha256 } });
    return { ctx, captured, route } as never;
  }

  it('serves bytes from the tenant-scoped content key', async () => {
    blobStore.set(agentBlobKey('tenant-1', 'app-1', helloSha), {
      bytes: helloBytes,
      contentType: 'image/png',
    });
    const { ctx, route } = blobCtx(helloSha) as never as { ctx: AppContext; route: GetAgentBlob };
    const res = (await route.handle(ctx)) as Response;
    expect(res.status).toBe(200);
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(helloBytes);
    expect(res.headers.get('Cache-Control')).toBe('private, max-age=31536000, immutable');
  });

  it('404s on a miss without leaking other tenants', async () => {
    // Same sha exists under ANOTHER tenant's key — must still 404.
    blobStore.set(agentBlobKey('tenant-2', 'app-9', helloSha), {
      bytes: helloBytes,
      contentType: 'image/png',
    });
    const { ctx, captured, route } = blobCtx(helloSha) as never as {
      ctx: AppContext;
      captured: { status: number; body: { error: { code: string } } };
      route: GetAgentBlob;
    };
    await route.handle(ctx);
    expect(captured.status).toBe(404);
    expect(captured.body.error.code).toBe('blob_not_found');
  });
});
