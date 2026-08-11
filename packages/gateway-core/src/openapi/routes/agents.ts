/**
 * Agents OpenAPI Routes — the sync pipe.
 *
 * POST /v1/agents/sync — the real ingest path for coding-agent sessions. The
 * CLI (`outerlayer sync`) scans local transcripts, tier-downconverts client-
 * side, and POSTs batches here. Per session the handler applies the SAME
 * pipeline the dev loader proved (tier gate → secret scrub → span mapping):
 * `agentSessionToClickHouseRows` + `agentSessionSummaryRow` → `otel_traces` +
 * `agent_session_summary`. Deterministic trace/span ids make re-sync
 * idempotent under the tables' replacing semantics.
 *
 * Image blobs arrive content-addressed (sha256) in the same request. They are
 * written to BOTH stores: the `agent_blobs` ClickHouse table (what the
 * dashboard's transcript serve reads, and the only store a self-host without
 * object storage has) and object storage via the
 * blob-storage seam (R2/S3) under `agents/{tenant}/{app}/{sha256}` — the
 * durable home, served by GET /v1/agents/blob/:sha256.
 *
 * Tier truth: the tenant's ceiling comes from `tenant.agent_capture_tier`
 * (default 'redacted'); `effectiveTier` clamps to the LOWER of it and the
 * client-declared tier. Clients lie; the write path doesn't.
 *
 * Actor truth: sessions are attributed to the API key's bound membership
 * (`actor_membership_id`, actor-scoped keys). Shared keys without a binding
 * attribute to the key itself (`key:<apiKeyId>`), never to a guessed human.
 */

import { z, BaseRoute, type AppContext, structuredError, errorResponse, parseJsonBody } from './_shared';
import { verifyAgentBlobToken } from '../../lib/agent-blob-token';
import type { GatewayPermission } from '../../lib/permissions';
import { createClient } from '@clickhouse/client-web';
import { clickHouseWriteAuth } from '../../stores/clickhouse/write-identity';
import { createSystemAdminClient, asServiceClient } from '../../lib/system-client';
import { createBlobStorage, type BlobStorage } from '../../lib/blob-storage';
import { createClickHouseService, createSpanLimitService } from '../../services';
import { initCache } from '../../utils';
import { memory } from '../../cache-store';
import { isSelfHostGateway } from '../../lib/entitlements';
import { claimFirstTrace } from '../../lib/first-trace';
import {
  agentSessionToClickHouseRows,
  agentSessionSummaryRow,
  resolveTenantCaptureTier,
} from '../../services/agent-session-converter';
export { resolveTenantCaptureTier };
import { safeParseAgentSession, CAPTURE_TIERS } from '@outerlayer/session-schema';

// ---------------------------------------------------------------------------
// Limits — sized so a worst-case request stays well inside Workers CPU/body
// budgets. The CLI batches under these caps; oversize requests fail loudly.
// ---------------------------------------------------------------------------

export const MAX_SESSIONS_PER_SYNC = 50;
export const MAX_BLOBS_PER_SYNC = 64;
/** Per-blob decoded cap (2 MiB) — transcript images are pasted screenshots. */
export const MAX_BLOB_BYTES = 2 * 1024 * 1024;
/**
 * Whole-request byte ceiling (8 MiB). Defense-in-depth against a pathological
 * single request that bypasses the CLI's own ~3.5 MB batch cap: reject it up
 * front with a structured 413 before the parse + base64 decode allocate, so one
 * oversized batch can't push the isolate toward exhaustion mid-request. Sized
 * well above the CLI cap so legitimate traffic never trips it.
 */
export const MAX_SYNC_REQUEST_BYTES = 8 * 1024 * 1024;
/**
 * Retry-After (seconds) advertised when a ClickHouse insert fails under load.
 * Long enough to let a saturated isolate/downstream drain, short enough that a
 * backfill resumes promptly.
 */
export const SYNC_RETRY_AFTER_SECONDS = 30;

const Sha256Schema = z.string().regex(/^[0-9a-f]{64}$/, 'must be 64 lowercase hex chars');

const SyncBlobSchema = z.object({
  sha256: Sha256Schema,
  mediaType: z.string().min(1).max(100),
  bytes: z.number().int().nonnegative(),
  /** Base64-encoded content. */
  data: z.string().min(1),
});

const SyncBodySchema = z.object({
  schemaVersion: z.literal(1),
  /** Sessions validated INDIVIDUALLY below so one bad session rejects alone. */
  sessions: z.array(z.unknown()).min(1).max(MAX_SESSIONS_PER_SYNC),
  blobs: z.array(SyncBlobSchema).max(MAX_BLOBS_PER_SYNC).optional(),
});

const RejectedSchema = z.object({
  index: z.number().int(),
  id: z.string().optional(),
  reason: z.string(),
});

const SyncResponseSchema = z.object({
  data: z.object({
    accepted: z.array(z.string()),
    rejected: z.array(RejectedSchema),
    spanRows: z.number().int(),
    blobsStored: z.number().int(),
    /** The tenant-configured ceiling the batch was clamped to. */
    tenantTier: z.enum(CAPTURE_TIERS),
  }),
});

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/** Object-storage key for an agent image blob (content-addressed). */
export function agentBlobKey(tenantId: string, appId: string, sha256: string): string {
  return `agents/${tenantId}/${appId}/${sha256}`;
}

function base64ToBytes(data: string): Uint8Array {
  return Uint8Array.from(atob(data), (ch) => ch.charCodeAt(0));
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes as BufferSource);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * Insert the request's non-empty row batches through a SINGLE ClickHouse client
 * that is always closed. Returns `true` on success, `false` if an insert threw
 * (the caller then sheds with a structured 503 + Retry-After).
 *
 * The client must be closed: leaking one per request piles up keep-alive state
 * in a warm Workers isolate until sustained load sheds the isolate as a bare
 * platform 503, which no handler can catch or shape. Every other ClickHouse
 * route closes its client; this path routes every insert through here so it
 * does too.
 */
export async function insertAgentRows(
  env: { CLICKHOUSE_HOST: string; CLICKHOUSE_PASSWORD: string },
  batches: Array<{ table: string; values: Record<string, unknown>[] }>,
): Promise<boolean> {
  const nonEmpty = batches.filter((b) => b.values.length > 0);
  if (nonEmpty.length === 0) return true;
  const client = createClient({
    url: env.CLICKHOUSE_HOST,
    ...clickHouseWriteAuth(env),
    // The endpoint acks the sync only after these inserts resolve, and callers
    // treat the ack as "durably stored" (the CLI advances its sync watermark
    // past acked sessions and never re-sends them). insert() must therefore
    // not return until the rows are actually written: force a synchronous
    // insert rather than inheriting the server's async-insert profile, under
    // which insert() can return once the block is merely BUFFERED — acking
    // sessions whose rows are still in flight and, under memory pressure, may
    // never land. wait_for_async_insert is belt-and-suspenders if a profile
    // forces async_insert on anyway. Matches every other insert path in the repo.
    clickhouse_settings: { async_insert: 0, wait_for_async_insert: 1 },
  });
  try {
    for (const batch of nonEmpty) {
      await client.insert({ table: batch.table, values: batch.values, format: 'JSONEachRow' });
    }
    return true;
  } catch (e) {
    console.warn('[agents/sync] ClickHouse insert failed, signaling backpressure:', e);
    return false;
  } finally {
    await client.close();
  }
}

/**
 * Backoff between verify reads, in milliseconds. The first read happens with no
 * delay; each subsequent one waits the next value. Sub-second in total, which is
 * the point: it is spent inside a request that would otherwise shed and cost the
 * caller a full `SYNC_RETRY_AFTER_SECONDS` round trip.
 */
const VERIFY_RETRY_DELAYS_MS = [50, 150, 400];

/**
 * Confirms the summary rows for `traceIds` are actually readable after an
 * insert returned success.
 *
 * insert() returning 200 is *supposed* to mean the rows are durable, and every
 * layer we can test in isolation upholds that. But in the deployed runtime the
 * endpoint has been observed to ack sessions whose summary rows never became
 * readable (a small, load-dependent fraction). Because the CLI advances its
 * sync watermark past acked sessions and never re-sends them, that ack is a
 * silent, permanent loss. This turns it into a retried success: a short count
 * sheds the batch as 503, and the CLI's idempotent retry (deterministic ids +
 * ReplacingMergeTree) re-lands the rows.
 *
 * A SINGLE immediate read is not a durability oracle, though. The read opens
 * its own connection, so it can be served by a different node than the one that
 * accepted the write, and a write is not necessarily visible there the instant
 * insert() resolves. Reading once turns that ordinary visibility lag into a
 * shed, and because the caller retries the identical batch into the same
 * window, the shed can repeat until the caller gives up — a false permanent
 * failure built out of a transient one. So a short count is re-read across
 * `VERIFY_RETRY_DELAYS_MS` before it is believed. Rows that genuinely never
 * landed stay short through every attempt and still shed; lag resolves and acks.
 *
 * The read is tenant+app scoped so the primary-key prefix prunes to the
 * caller's parts, and `uniqExact` counts DISTINCT present TraceIds — so it is
 * compared against the number of distinct ids expected, not the row count. Two
 * rows can legitimately share a TraceId (the same session twice in one batch),
 * and comparing against the row count would then be unsatisfiable: the verify
 * would shed every attempt and fail the batch permanently.
 *
 * A verify that itself ERRORS returns true: an unreadable verify must never
 * turn a good insert into a false failure — only a definitive short count acts.
 */
export async function verifyAgentSummaryLanded(
  env: { CLICKHOUSE_HOST: string; CLICKHOUSE_PASSWORD: string },
  tenantId: string,
  appId: string,
  traceIds: string[],
): Promise<boolean> {
  // No empty-guard needed: the only caller guards on summaryRows.length > 0,
  // and an empty id set would read back 0 which `0 < 0` treats as landed anyway.
  const expected = new Set(traceIds).size;
  const client = createClient({
    url: env.CLICKHOUSE_HOST,
    ...clickHouseWriteAuth(env),
    clickhouse_settings: { async_insert: 0, wait_for_async_insert: 1 },
  });
  try {
    let landed = 0;
    for (let attempt = 0; ; attempt += 1) {
      const rs = await client.query({
        query:
          'SELECT uniqExact(TraceId) AS n FROM agent_session_summary ' +
          'WHERE TenantId = {t:String} AND AppId = {a:String} AND TraceId IN {ids:Array(String)}',
        query_params: { t: tenantId, a: appId, ids: traceIds },
        format: 'JSONEachRow',
      });
      const rows = (await rs.json()) as Array<{ n: string | number }>;
      landed = Number(rows[0]?.n ?? 0);
      if (landed >= expected) return true;
      const delay = VERIFY_RETRY_DELAYS_MS[attempt];
      if (delay === undefined) break;
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
    console.warn(
      `[agents/sync] post-insert verify short: ${landed}/${expected} summary rows readable ` +
        `after ${VERIFY_RETRY_DELAYS_MS.length + 1} reads — shedding for idempotent retry`,
    );
    return false;
  } catch (e) {
    console.warn('[agents/sync] post-insert verify query failed, assuming ok:', e);
    return true;
  } finally {
    await client.close();
  }
}

// ---------------------------------------------------------------------------
// POST /v1/agents/sync
// ---------------------------------------------------------------------------

export class SyncAgentSessions extends BaseRoute {
  static requiredPermission: GatewayPermission = 'trace.write';
  schema = {
    tags: ['Agents'],
    summary: 'Ingest coding-agent sessions (outerlayer sync)',
    operationId: 'sync-agent-sessions',
    description:
      'Ingests a batch of canonical AgentSessions (schemaVersion 1) plus their content-addressed image blobs. ' +
      'Each session is tier-clamped to the tenant ceiling, secret-scrubbed, and mapped to spans. ' +
      'Deterministic ids make re-sync idempotent. Sessions are validated individually: a malformed ' +
      'session is rejected without failing the batch.',
    request: {
      body: {
        content: {
          'application/json': {
            schema: SyncBodySchema,
          },
        },
      },
    },
    responses: {
      200: {
        description: 'Batch result: accepted/rejected per session.',
        content: { 'application/json': { schema: SyncResponseSchema } },
      },
      400: errorResponse('Malformed request body.'),
      401: errorResponse('Missing or invalid API key.'),
      413: errorResponse('Batch exceeds the per-request byte ceiling — split it into smaller requests.'),
      429: errorResponse('Monthly unit limit exceeded.'),
      503: {
        // Load-triggered: a ClickHouse insert failed (downstream saturated).
        // Structured envelope + Retry-After so a client's backoff can tell
        // 'back off and resume' apart from a permanent break.
        ...errorResponse('Ingest temporarily unavailable; retry after the interval.'),
        headers: z.object({
          'Retry-After': z.number().int().nonnegative().optional(),
        }),
      },
    },
  };

  async handle(c: AppContext) {
    // Shed an oversized request before the parse allocates. A batch far above
    // the CLI's own ~3.5 MB cap risks exhausting the isolate mid-parse (which
    // the platform then surfaces as an opaque 503); reject it up front with a
    // structured 413 the client can act on.
    const declaredLength = Number(c.req.header?.('content-length') ?? Number.NaN);
    if (Number.isFinite(declaredLength) && declaredLength > MAX_SYNC_REQUEST_BYTES) {
      return c.json(
        structuredError(
          'payload_too_large',
          `Sync request exceeds the ${MAX_SYNC_REQUEST_BYTES}-byte ceiling. Split the batch into smaller requests.`,
          { limit: MAX_SYNC_REQUEST_BYTES },
        ),
        413,
      );
    }

    const raw = await parseJsonBody(c);
    const parsed = SyncBodySchema.safeParse(raw);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      return c.json(
        structuredError(
          'invalid_request_body',
          `Invalid sync payload: ${issue ? `${issue.path.join('.')}: ${issue.message}` : 'malformed'}`,
        ),
        400,
      );
    }
    const { sessions, blobs } = parsed.data;

    // Secondary guard for clients that omit Content-Length (chunked uploads):
    // base64 blob data is the dominant allocation, so cap its total here too.
    const blobPayloadBytes = (blobs ?? []).reduce((sum, b) => sum + b.data.length, 0);
    if (blobPayloadBytes > MAX_SYNC_REQUEST_BYTES) {
      return c.json(
        structuredError(
          'payload_too_large',
          `Sync blob payload exceeds the ${MAX_SYNC_REQUEST_BYTES}-byte ceiling. Split the batch into smaller requests.`,
          { limit: MAX_SYNC_REQUEST_BYTES },
        ),
        413,
      );
    }

    const user = c.get('user');
    const env = c.env;
    const adminSupabase = asServiceClient(createSystemAdminClient(env));

    // Billing integrity: agent spans are units like any other ingested span.
    // Mirror the OTLP ingest's monthly-limit gate; fail OPEN on check errors
    // (a metering blip must not lose telemetry), fail CLOSED on a real limit.
    try {
      const limitService = createSpanLimitService(
        createClickHouseService({ host: env.CLICKHOUSE_HOST, ...clickHouseWriteAuth(env) }),
        adminSupabase,
        initCache(c.get('gtx').cacheL2Store, c.get('gtx').execCtx, memory),
        { selfHost: isSelfHostGateway(env) },
      );
      const limitResult = await limitService.checkSpanLimit(user.tenantId);
      if (limitResult.currentCount === 0) {
        try {
          await claimFirstTrace(adminSupabase, user.tenantId);
        } catch {
          // Analytics nicety — never block ingest on it.
        }
      }
      if (!limitResult.allowed) {
        return c.json(
          structuredError('span_limit_exceeded', 'Monthly unit limit exceeded. Upgrade your plan for unlimited units.', {
            currentCount: limitResult.currentCount,
            limit: limitResult.limit,
          }),
          429,
        );
      }
    } catch (e) {
      console.warn('[agents/sync] span-limit check failed, continuing:', e);
    }

    const tenantTier = await resolveTenantCaptureTier(adminSupabase, user.tenantId);
    // Actor-scoped keys attribute to the bound membership; shared keys to the
    // key itself. Never a client-supplied identity.
    const actorId = user.actorMembershipId ?? `key:${user.apiKeyId ?? 'unknown'}`;

    const accepted: string[] = [];
    const rejected: Array<z.infer<typeof RejectedSchema>> = [];
    const spanRows: Record<string, unknown>[] = [];
    const summaryRows: Record<string, unknown>[] = [];

    for (const [index, rawSession] of sessions.entries()) {
      const result = safeParseAgentSession(rawSession);
      if (!result.success) {
        const issue = result.error.issues[0];
        const id =
          typeof rawSession === 'object' && rawSession !== null && 'id' in rawSession
            ? String((rawSession as { id: unknown }).id)
            : undefined;
        rejected.push({
          index,
          ...(id ? { id } : {}),
          reason: `schema: ${issue ? `${issue.path.join('.')}: ${issue.message}` : 'invalid'}`.slice(0, 200),
        });
        continue;
      }
      const session = result.data;
      try {
        const rows = agentSessionToClickHouseRows(session, { meta: user, actorId, tenantTier });
        const summary = agentSessionSummaryRow(session, { meta: user, actorId, tenantTier });
        spanRows.push(...(rows as unknown as Record<string, unknown>[]));
        summaryRows.push(summary as unknown as Record<string, unknown>);
        accepted.push(session.id);
      } catch (e) {
        rejected.push({ index, id: session.id, reason: `convert: ${String(e)}`.slice(0, 200) });
      }
    }

    // Blobs: verify the content addressing (recompute sha256 server-side — the
    // whole scheme leans on the key being the hash), then dual-write. blobRows
    // is hoisted so the ClickHouse copy inserts through the same client as the
    // spans below.
    let blobsStored = 0;
    const blobRows: Record<string, unknown>[] = [];
    if (blobs && blobs.length > 0) {
      let storage: BlobStorage | null = null;
      try {
        storage = createBlobStorage(env);
      } catch (e) {
        // No object storage configured (self-host without R2/S3) — the
        // ClickHouse row below still makes the image servable.
        console.warn('[agents/sync] blob storage unavailable, ClickHouse only:', e);
      }
      const seen = new Set<string>();
      for (const blob of blobs) {
        if (seen.has(blob.sha256)) continue;
        seen.add(blob.sha256);
        let bytes: Uint8Array;
        try {
          bytes = base64ToBytes(blob.data);
        } catch {
          rejected.push({ index: -1, id: blob.sha256, reason: 'blob: data is not valid base64' });
          continue;
        }
        if (bytes.byteLength > MAX_BLOB_BYTES) {
          rejected.push({ index: -1, id: blob.sha256, reason: `blob: exceeds ${MAX_BLOB_BYTES} bytes` });
          continue;
        }
        const digest = await sha256Hex(bytes);
        if (digest !== blob.sha256) {
          rejected.push({ index: -1, id: blob.sha256, reason: 'blob: sha256 does not match content' });
          continue;
        }
        blobRows.push({
          TenantId: user.tenantId,
          AppId: user.appId,
          Sha256: blob.sha256,
          MediaType: blob.mediaType,
          Bytes: bytes.byteLength,
          Data: blob.data,
        });
        if (storage) {
          try {
            await storage.put(agentBlobKey(user.tenantId, user.appId, blob.sha256), bytes, blob.mediaType);
          } catch (e) {
            // ClickHouse row still serves it; object storage catches up on the
            // next sync (same deterministic key).
            console.warn(`[agents/sync] R2 put failed for ${blob.sha256}:`, e);
          }
        }
        blobsStored += 1;
      }
    }

    // Every insert rides one always-closed client. On failure, shed with a
    // structured 503 + Retry-After so the CLI's per-batch backoff can tell
    // 'back off and resume' apart from a permanent break — the whole batch is
    // safe to retry (deterministic ids + replacing-table semantics are
    // idempotent, blob puts are content-addressed).
    const inserted = await insertAgentRows(env, [
      { table: 'agent_blobs', values: blobRows },
      { table: 'otel_traces', values: spanRows },
      { table: 'agent_session_summary', values: summaryRows },
    ]);
    if (!inserted) {
      return c.json(
        structuredError('service_unavailable', 'Ingest temporarily unavailable. Retry after the interval.'),
        {
          status: 503,
          headers: { 'Retry-After': String(SYNC_RETRY_AFTER_SECONDS) },
        } as any, // Hono's c.json() typing doesn't accept status+headers together
      );
    }

    // Verify-before-ack: confirm the summary rows are actually readable before
    // telling the CLI they synced. An insert returning success is meant to be
    // durable, but a load-dependent fraction has been observed to ack yet never
    // land — and the CLI's watermark then skips them forever. A short count
    // sheds as 503 so the idempotent retry re-lands them, turning a silent
    // permanent loss into a retried success.
    if (summaryRows.length > 0) {
      const landed = await verifyAgentSummaryLanded(
        env,
        user.tenantId,
        user.appId,
        summaryRows.map((r) => String((r as { TraceId?: unknown }).TraceId)),
      );
      if (!landed) {
        return c.json(
          structuredError('service_unavailable', 'Ingest not yet durable. Retry after the interval.'),
          {
            status: 503,
            headers: { 'Retry-After': String(SYNC_RETRY_AFTER_SECONDS) },
          } as any,
        );
      }
    }

    return c.json({
      data: {
        accepted,
        rejected,
        spanRows: spanRows.length,
        blobsStored,
        tenantTier,
      },
    });
  }
}

// ---------------------------------------------------------------------------
// GET /v1/agents/blob/:sha256
// ---------------------------------------------------------------------------

/**
 * Serve an agent image blob from object storage (the durable home the sync
 * endpoint writes). Tenant+app scoped by construction: the key embeds the
 * caller's verified tenant/app, so a caller can never read another tenant's
 * blobs.
 *
 * This is an API-key surface for the client that uploaded the bytes. Unlike
 * the dashboard's transcript serve — which mints a signed, expiring URL per
 * viewer — the hash alone is enough here, because no gateway route hands a
 * sha256 to a caller: /v1/agents/sync is the only other agents route, and a
 * key can therefore only present hashes it produced itself.
 */
export class GetAgentBlob extends BaseRoute {
  static requiredPermission: GatewayPermission = 'trace.read';
  schema = {
    tags: ['Agents'],
    summary: 'Fetch an agent session image blob',
    operationId: 'get-agent-blob',
    description:
      'Returns the raw bytes of a content-addressed agent-session image (sha256). Scoped to the API key\'s tenant and app.',
    request: {
      params: z.object({ sha256: Sha256Schema }),
    },
    responses: {
      200: { description: 'Raw blob bytes (Content-Type = stored media type).' },
      401: errorResponse('Missing or invalid API key.'),
      404: errorResponse('Blob not found.'),
    },
  };

  async handle(c: AppContext) {
    const data = await this.getValidatedData();
    const user = c.get('user');
    const { sha256 } = data.params as { sha256: string };

    let bytes: Uint8Array | null = null;
    try {
      bytes = await createBlobStorage(c.env).get(agentBlobKey(user.tenantId, user.appId, sha256));
    } catch (e) {
      console.warn('[agents/blob] storage unavailable:', e);
    }
    if (!bytes) {
      return c.json(structuredError('blob_not_found', 'Blob not found'), 404);
    }
    return new Response(bytes as unknown as BodyInit, {
      status: 200,
      headers: {
        // Media type travels with the ClickHouse row, not object storage
        // metadata; octet-stream is safe for <img> with a correct sniff.
        'Content-Type': 'application/octet-stream',
        'Cache-Control': 'private, max-age=31536000, immutable',
      },
    });
  }
}

// ---------------------------------------------------------------------------
// GET /v1/agents/blob-token/:token
//
// Serves the same content-addressed bytes as GetAgentBlob, but authorized by
// a signed capability token (see lib/agent-blob-token.ts) instead of the
// `trace.read` permission GetAgentBlob requires. Session-detail responses
// carry ONLY these signed URLs — a `session.read`-only key lacks `trace.read`,
// so this is the sole way such a key can fetch an image its own transcript
// references. GetAgentBlob's raw-sha256 contract is untouched by this route.
// ---------------------------------------------------------------------------

export class GetAgentBlobByToken extends BaseRoute {
  static requiredPermission: GatewayPermission = 'session.read';
  schema = {
    tags: ['Agents'],
    summary: 'Fetch an agent session image blob via a signed token',
    operationId: 'get-agent-blob-by-token',
    description:
      'Returns the raw bytes of a content-addressed agent-session image, authorized by a signed, expiring token minted on a session-detail response. ' +
      'Never accepts a raw sha256 — the token is the only capability.',
    request: {
      params: z.object({ token: z.string().min(1) }),
    },
    responses: {
      200: { description: 'Raw blob bytes (Content-Type = stored media type).' },
      401: errorResponse('Missing or invalid API key.'),
      403: errorResponse('Missing, altered, or expired image token.'),
      404: errorResponse('Blob not found.'),
    },
  };

  async handle(c: AppContext) {
    const data = await this.getValidatedData();
    const user = c.get('user');
    const { token } = data.params as { token: string };

    const verified = await verifyAgentBlobToken({ secret: c.env.OAUTH_STATE_SECRET, token });
    if (
      !verified.ok ||
      verified.claims.tenantId !== user.tenantId ||
      verified.claims.appId !== user.appId ||
      verified.claims.keyId !== (user.apiKeyId ?? user.tenantId)
    ) {
      return c.json(structuredError('forbidden', 'Image link is invalid or has expired'), 403);
    }

    let bytes: Uint8Array | null = null;
    try {
      bytes = await createBlobStorage(c.env).get(
        agentBlobKey(verified.claims.tenantId, verified.claims.appId, verified.claims.sha256),
      );
    } catch (e) {
      console.warn('[agents/blob-token] storage unavailable:', e);
    }
    if (!bytes) {
      return c.json(structuredError('blob_not_found', 'Blob not found'), 404);
    }
    const maxAge = Math.max(0, verified.claims.exp - Math.floor(Date.now() / 1000));
    return new Response(bytes as unknown as BodyInit, {
      status: 200,
      headers: {
        'Content-Type': 'application/octet-stream',
        'Cache-Control': `private, max-age=${maxAge}, immutable`,
      },
    });
  }
}
