/**
 * Unit tests for POST /v1/artifacts (openapi/routes/artifacts.ts,
 * EmitArtifact) — the artifact emit pipe.
 *
 * Drives the handler directly with a mocked context (the agents-sync.test.ts
 * pattern): ClickHouse traffic is captured per table/query, blob storage is an
 * in-memory map, and the scoped Supabase client is replaced at the
 * `getScopedSupabase` seam with a stateful fake covering the two Postgres
 * tables the route touches.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createHash } from 'node:crypto';
import { NoopCacheStore } from '../../runtime/adapters/noop-cache-store';

// The storage-cap gate builds the admin client only to hand it to
// checkStorageCap (mocked below) — a bare object stands in.
vi.mock('../../lib/system-client', () => ({
  asServiceClient: (client: unknown) => client,
  createSystemAdminClient: vi.fn(() => ({})),
}));

// Storage cap — mutated per test. `null` means "check throws", modeling a
// Stripe/cache failure so tests can pin the fail-open contract.
let storageCapResult: { allowed: boolean; currentBytes: number; limitBytes: number; capReached: boolean } | null = {
  allowed: true,
  currentBytes: 0,
  limitBytes: -1,
  capReached: false,
};
const checkStorageCap = vi.fn(async () => {
  if (storageCapResult === null) throw new Error('storage-cap check boom');
  return storageCapResult;
});

// Captured ClickHouse traffic: blob inserts per table plus every
// session-existence read, so tests can pin tenant scoping on the read and
// exact content on the write.
const insertsByTable: Record<string, Array<Record<string, unknown>>> = {};
const summaryQueries: Array<Record<string, unknown>> = [];
let sessionExistsInClickHouse = false;
let insertShouldThrow: Error | null = null;
vi.mock('@clickhouse/client-web', () => ({
  createClient: vi.fn(() => ({
    insert: vi.fn(async (params: { table: string; values: Array<Record<string, unknown>> }) => {
      if (insertShouldThrow) throw insertShouldThrow;
      (insertsByTable[params.table] ??= []).push(...params.values);
    }),
    query: vi.fn(async (params: { query_params?: Record<string, unknown> }) => {
      summaryQueries.push(params.query_params ?? {});
      return { json: async () => [{ n: sessionExistsInClickHouse ? 1 : 0 }] };
    }),
    close: vi.fn(async () => {}),
  })),
}));

// In-memory blob storage (the object-storage half of the dual-write).
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

// Scoped-Supabase seam: a stateful fake for the two tables the route reads
// and writes. Calls are captured into plain arrays and asserted with toEqual.
type StoredArtifactRow = {
  id: string;
  kind: string;
  provenance: string;
  verification: string;
  pr_number: number | null;
  repository: string;
};
// Consumed one entry per artifact select (pre-check first, then the
// post-upsert re-read); an exhausted queue reads as "no row".
let artifactSelectQueue: Array<StoredArtifactRow | null> = [];
let prRowExists = false;
let upsertIgnored = false;
const artifactUpserts: Array<{ row: Record<string, unknown>; options: Record<string, unknown> }> = [];
const artifactLookups: Array<{ appId: string; clientArtifactId: string }> = [];
const prLookups: Array<{ appId: string; prNumber: number }> = [];

function scopedDb() {
  return {
    from: (table: string) => {
      if (table === 'artifact') {
        return {
          select: () => ({
            eq: (_appCol: string, appId: string) => ({
              eq: (_idCol: string, clientArtifactId: string) => ({
                maybeSingle: async () => {
                  artifactLookups.push({ appId, clientArtifactId });
                  const next = artifactSelectQueue.length > 0 ? artifactSelectQueue.shift()! : null;
                  return { data: next, error: null };
                },
              }),
            }),
          }),
          upsert: (row: Record<string, unknown>, options: Record<string, unknown>) => {
            artifactUpserts.push({ row, options });
            return {
              select: () => ({
                maybeSingle: async () => ({
                  data: upsertIgnored
                    ? null
                    : {
                        id: 'artifact-uuid-1',
                        kind: row.kind,
                        provenance: row.provenance,
                        verification: row.verification,
                        pr_number: row.pr_number ?? null,
                        repository: row.repository ?? '',
                      },
                  error: null,
                }),
              }),
            };
          },
        };
      }
      if (table === 'pull_request') {
        return {
          select: () => ({
            eq: (_appCol: string, appId: string) => ({
              eq: (_prCol: string, prNumber: number) => ({
                limit: () => ({
                  maybeSingle: async () => {
                    prLookups.push({ appId, prNumber });
                    return { data: prRowExists ? { id: 'pr-uuid-1' } : null, error: null };
                  },
                }),
              }),
            }),
          }),
        };
      }
      throw new Error(`unexpected table: ${table}`);
    },
  };
}

vi.mock('../routes/_shared', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../routes/_shared')>()),
  getScopedSupabase: vi.fn(async () => scopedDb()),
}));

import { createClient } from '@clickhouse/client-web';
import type { AppContext } from '../routes/_shared';
import { EmitArtifact, ARTIFACT_MAX_BLOB_BYTES, ARTIFACT_MAX_REQUEST_BYTES } from '../routes/artifacts';
import { agentBlobKey } from '../routes/agents';
import { PR_COMMENT_QUEUE_DEBOUNCE_SECONDS } from '../../types/queue-messages';

const createClientMock = vi.mocked(createClient);

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

const pngBytes = new TextEncoder().encode('png-bytes-of-proof');
const pngSha = createHash('sha256').update(pngBytes).digest('hex');
const pngB64 = Buffer.from(pngBytes).toString('base64');

function emitBody(
  artifactOver: Record<string, unknown> = {},
  blobOver: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    schemaVersion: 1,
    artifact: {
      clientArtifactId: 'art_01HZX4T8',
      filename: 'login-page.png',
      mediaType: 'image/png',
      bytes: pngBytes.byteLength,
      sha256: pngSha,
      caption: 'Login page renders after the fix',
      emittedAt: '2026-08-14T10:00:00.000Z',
      ...artifactOver,
    },
    blob: { data: pngB64, ...blobOver },
  };
}

type UserOver = Partial<{ actorMembershipId: string; apiKeyId: string }>;

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
        return { appId: 'app-1', tenantId: 'tenant-1', apiKeyId: 'key_abc', stripeCustomerId: 'cus_1', ...userOver };
      }
      // The storage-cap gate builds its cache from gtx.
      if (k === 'gtx') {
        return {
          cacheL2Store: new NoopCacheStore(),
          execCtx: { waitUntil: () => {}, passThroughOnException: () => {} },
          billing: { checkStorageCap },
        };
      }
      return undefined;
    },
    env: { CLICKHOUSE_HOST: 'http://localhost:8123', CLICKHOUSE_PASSWORD: 'x', ...envOver },
    req: {
      json: async () => body,
      method: 'POST',
      path: '/v1/artifacts',
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

beforeEach(() => {
  for (const key of Object.keys(insertsByTable)) delete insertsByTable[key];
  summaryQueries.length = 0;
  sessionExistsInClickHouse = false;
  insertShouldThrow = null;
  blobStore.clear();
  blobStorageAvailable = true;
  artifactSelectQueue = [];
  prRowExists = false;
  upsertIgnored = false;
  artifactUpserts.length = 0;
  artifactLookups.length = 0;
  prLookups.length = 0;
  createClientMock.mockClear();
  storageCapResult = { allowed: true, currentBytes: 0, limitBytes: -1, capReached: false };
  checkStorageCap.mockClear();
});

// ---------------------------------------------------------------------------
// POST /v1/artifacts
// ---------------------------------------------------------------------------

describe('EmitArtifact', () => {
  it('rejects a malformed body with 400 invalid_request_body', async () => {
    const { ctx, status, json } = ctxFor({ schemaVersion: 1 });
    await new EmitArtifact({} as never).handle(ctx);
    expect(status()).toBe(400);
    expect((json() as { error: { code: string } }).error.code).toBe('invalid_request_body');
  });

  // proves AC-084-01
  it('stores an accepted emit with caption, inferred kind, criterion id, and derived provenance, and echoes them', async () => {
    const { ctx, status, json } = ctxFor(
      emitBody({
        criterionId: 'login.smoke-01',
        gitRepo: 'github.com/acme/api',
        gitBranch: 'fix/login',
        commitSha: 'abc1234def',
      }),
      { actorMembershipId: 'membership-42' },
    );
    await new EmitArtifact({} as never).handle(ctx);

    expect(status()).toBe(200);
    expect(artifactUpserts).toHaveLength(1);
    expect(artifactUpserts[0]!.row).toEqual({
      tenant_id: 'tenant-1',
      app_id: 'app-1',
      client_artifact_id: 'art_01HZX4T8',
      sha256: pngSha,
      filename: 'login-page.png',
      media_type: 'image/png',
      kind: 'screenshot',
      caption: 'Login page renders after the fix',
      criterion_id: 'login.smoke-01',
      provenance: 'local',
      session_id: '',
      trace_id: '',
      turn_index: null,
      repository: 'acme/api',
      pr_number: null,
      git_repo: 'github.com/acme/api',
      git_branch: 'fix/login',
      commit_sha: 'abc1234def',
      verification: 'pending',
      emitted_at: '2026-08-14T10:00:00.000Z',
    });
    expect(artifactUpserts[0]!.options).toEqual({
      onConflict: 'app_id,client_artifact_id',
      ignoreDuplicates: true,
    });
    expect(json()).toEqual({
      data: {
        id: 'artifact-uuid-1',
        kind: 'screenshot',
        provenance: 'local',
        verification: 'pending',
        prNumber: null,
        repository: 'acme/api',
      },
    });
  });

  it('dual-writes the blob: agent_blobs row plus object storage under the tenant-scoped content key', async () => {
    const { ctx, status } = ctxFor(emitBody({ gitBranch: 'fix/login' }));
    await new EmitArtifact({} as never).handle(ctx);

    expect(status()).toBe(200);
    expect(insertsByTable['agent_blobs']).toEqual([
      {
        TenantId: 'tenant-1',
        AppId: 'app-1',
        Sha256: pngSha,
        MediaType: 'image/png',
        Bytes: pngBytes.byteLength,
        Data: pngB64,
      },
    ]);
    const stored = blobStore.get(agentBlobKey('tenant-1', 'app-1', pngSha));
    expect(stored?.contentType).toBe('image/png');
    expect(Array.from(stored?.bytes ?? [])).toEqual(Array.from(pngBytes));
  });

  it('still stores the blob in ClickHouse when object storage is unavailable', async () => {
    blobStorageAvailable = false;
    const { ctx, status } = ctxFor(emitBody({ gitBranch: 'fix/login' }));
    await new EmitArtifact({} as never).handle(ctx);
    expect(status()).toBe(200);
    expect(insertsByTable['agent_blobs']).toHaveLength(1);
    expect(blobStore.size).toBe(0);
  });

  // proves AC-084-03
  it('anchors a CI emit immediately: shared-key ci provenance, pr_number set, confirmed when the PR row exists', async () => {
    prRowExists = true;
    // No actorMembershipId override: a shared machine key.
    const { ctx, status, json } = ctxFor(emitBody({ ci: true, repository: 'Acme/API', prNumber: 512 }));
    await new EmitArtifact({} as never).handle(ctx);

    expect(status()).toBe(200);
    expect(prLookups).toEqual([{ appId: 'app-1', prNumber: 512 }]);
    expect(artifactUpserts[0]!.row).toEqual({
      tenant_id: 'tenant-1',
      app_id: 'app-1',
      client_artifact_id: 'art_01HZX4T8',
      sha256: pngSha,
      filename: 'login-page.png',
      media_type: 'image/png',
      kind: 'screenshot',
      caption: 'Login page renders after the fix',
      criterion_id: '',
      provenance: 'ci',
      session_id: '',
      trace_id: '',
      turn_index: null,
      repository: 'acme/api',
      pr_number: 512,
      git_repo: '',
      git_branch: '',
      commit_sha: '',
      verification: 'confirmed',
      emitted_at: '2026-08-14T10:00:00.000Z',
    });
    expect(json()).toEqual({
      data: {
        id: 'artifact-uuid-1',
        kind: 'screenshot',
        provenance: 'ci',
        verification: 'confirmed',
        prNumber: 512,
        repository: 'acme/api',
      },
    });
  });

  it('stores pr_number with pending verification when no pull_request row exists yet', async () => {
    prRowExists = false;
    const { ctx, status } = ctxFor(emitBody({ prNumber: 900 }));
    await new EmitArtifact({} as never).handle(ctx);
    expect(status()).toBe(200);
    expect(artifactUpserts[0]!.row.pr_number).toBe(900);
    expect(artifactUpserts[0]!.row.verification).toBe('pending');
  });

  it('binds to a synced session: session provenance, derived trace id, session_id and turn_index stored', async () => {
    sessionExistsInClickHouse = true;
    const { ctx, status, json } = ctxFor(
      emitBody({ session: { sessionId: '5c3a1b2d-4e6f-4708-9a1b-2c3d4e5f6a7b', turnIndex: 3 } }),
    );
    await new EmitArtifact({} as never).handle(ctx);

    expect(status()).toBe(200);
    // The existence read is pinned to the caller's tenant + app partition and
    // the trace id derived the same way the sync converter derives it (UUID
    // with dashes stripped).
    expect(summaryQueries).toEqual([
      { t: 'tenant-1', a: 'app-1', id: '5c3a1b2d4e6f47089a1b2c3d4e5f6a7b' },
    ]);
    expect(artifactUpserts[0]!.row).toEqual({
      tenant_id: 'tenant-1',
      app_id: 'app-1',
      client_artifact_id: 'art_01HZX4T8',
      sha256: pngSha,
      filename: 'login-page.png',
      media_type: 'image/png',
      kind: 'screenshot',
      caption: 'Login page renders after the fix',
      criterion_id: '',
      provenance: 'session',
      session_id: '5c3a1b2d-4e6f-4708-9a1b-2c3d4e5f6a7b',
      trace_id: '5c3a1b2d4e6f47089a1b2c3d4e5f6a7b',
      turn_index: 3,
      repository: '',
      pr_number: null,
      git_repo: '',
      git_branch: '',
      commit_sha: '',
      verification: 'pending',
      emitted_at: '2026-08-14T10:00:00.000Z',
    });
    expect((json() as { data: { provenance: string } }).data.provenance).toBe('session');
  });

  // proves AC-084-05
  it('rejects a claimed session binding whose session never synced, storing nothing', async () => {
    sessionExistsInClickHouse = false;
    const { ctx, status, json } = ctxFor(
      emitBody({ session: { sessionId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee' } }),
    );
    await new EmitArtifact({} as never).handle(ctx);

    expect(status()).toBe(400);
    expect(json()).toEqual({
      error: {
        code: 'session_not_found',
        message:
          'No synced session matches this binding for the app — sync the session before emitting artifacts bound to it.',
      },
    });
    expect(summaryQueries).toEqual([
      { t: 'tenant-1', a: 'app-1', id: 'aaaaaaaabbbb4ccc8dddeeeeeeeeeeee' },
    ]);
    expect(artifactUpserts).toEqual([]);
    expect(insertsByTable['agent_blobs']).toBeUndefined();
    expect(blobStore.size).toBe(0);
  });

  // proves AC-084-05
  it('downgrades a ci claim from an actor-bound key to local', async () => {
    prRowExists = true;
    const { ctx, status } = ctxFor(
      emitBody({ ci: true, repository: 'acme/api', prNumber: 512 }),
      { actorMembershipId: 'membership-42' },
    );
    await new EmitArtifact({} as never).handle(ctx);

    expect(status()).toBe(200);
    expect(artifactUpserts[0]!.row.provenance).toBe('local');
  });

  // proves AC-084-06
  it('refuses an emit with no anchor, storing neither blob nor row', async () => {
    const { ctx, status, json } = ctxFor(emitBody());
    await new EmitArtifact({} as never).handle(ctx);

    expect(status()).toBe(400);
    expect(json()).toEqual({
      error: { code: 'nothing_to_attach', message: 'nothing to attach this to' },
    });
    expect(artifactUpserts).toEqual([]);
    expect(insertsByTable['agent_blobs']).toBeUndefined();
    expect(blobStore.size).toBe(0);
    expect(createClientMock).not.toHaveBeenCalled();
  });

  it('does not treat a bare repository (no PR, session, or git context) as an anchor', async () => {
    const { ctx, status, json } = ctxFor(emitBody({ repository: 'acme/api' }));
    await new EmitArtifact({} as never).handle(ctx);
    expect(status()).toBe(400);
    expect((json() as { error: { code: string } }).error.code).toBe('nothing_to_attach');
    expect(artifactUpserts).toEqual([]);
  });

  it('accepts branch-only git context as a pending anchor', async () => {
    const { ctx, status } = ctxFor(emitBody({ gitBranch: 'fix/login' }));
    await new EmitArtifact({} as never).handle(ctx);
    expect(status()).toBe(200);
    expect(artifactUpserts[0]!.row.verification).toBe('pending');
    expect(artifactUpserts[0]!.row.pr_number).toBeNull();
  });

  // proves AC-084-09
  // proves AC-084-10
  it('stores the kind inferred from the media type, filing an unrecognized type as file even when the payload claims otherwise', async () => {
    const first = ctxFor(emitBody({ prNumber: 7 }));
    await new EmitArtifact({} as never).handle(first.ctx);
    expect(first.status()).toBe(200);
    expect(artifactUpserts[0]!.row.kind).toBe('screenshot');

    // The wire contract has no kind field: a smuggled `kind` is stripped by
    // the schema and an unrecognized media type stays `file`, never guessed
    // into a stronger kind.
    const second = ctxFor(
      emitBody({
        clientArtifactId: 'art_02',
        mediaType: 'application/x-unknown',
        prNumber: 7,
        kind: 'video',
      }),
    );
    await new EmitArtifact({} as never).handle(second.ctx);
    expect(second.status()).toBe(200);
    expect(artifactUpserts[1]!.row.kind).toBe('file');
    expect((second.json() as { data: { kind: string } }).data.kind).toBe('file');
  });

  it('rejects a sha mismatch with 400, storing neither blob nor row', async () => {
    const { ctx, status, json } = ctxFor(emitBody({ prNumber: 7, sha256: 'a'.repeat(64) }));
    await new EmitArtifact({} as never).handle(ctx);

    expect(status()).toBe(400);
    expect(json()).toEqual({
      error: { code: 'invalid_field_value', message: 'sha256 does not match content' },
    });
    expect(insertsByTable['agent_blobs']).toBeUndefined();
    expect(blobStore.size).toBe(0);
    expect(artifactUpserts).toEqual([]);
  });

  it('rejects blob data that is not valid base64', async () => {
    const { ctx, status, json } = ctxFor(emitBody({ prNumber: 7 }, { data: '!!!not-base64!!!' }));
    await new EmitArtifact({} as never).handle(ctx);

    expect(status()).toBe(400);
    expect(json()).toEqual({
      error: { code: 'invalid_field_value', message: 'blob.data is not valid base64' },
    });
    expect(insertsByTable['agent_blobs']).toBeUndefined();
    expect(artifactUpserts).toEqual([]);
  });

  it('rejects a blob decoding past the cap with 413, storing nothing', async () => {
    // Valid base64 (all 'A' → 0x00 bytes) decoding just past the 8 MiB cap,
    // while the base64 string stays under the 12 MiB request ceiling so it
    // reaches the decoded-size check rather than the request-size shed.
    const oversized = 'A'.repeat(Math.ceil(ARTIFACT_MAX_BLOB_BYTES / 3) * 4 + 4);
    const { ctx, status, json } = ctxFor(emitBody({ prNumber: 7 }, { data: oversized }));
    await new EmitArtifact({} as never).handle(ctx);

    expect(status()).toBe(413);
    const body = json() as { error: { code: string; limit: number } };
    expect(body.error.code).toBe('payload_too_large');
    expect(body.error.limit).toBe(ARTIFACT_MAX_BLOB_BYTES);
    expect(insertsByTable['agent_blobs']).toBeUndefined();
    expect(blobStore.size).toBe(0);
    expect(artifactUpserts).toEqual([]);
  });

  it('sheds an over-ceiling request via Content-Length before parsing or touching any store', async () => {
    const { ctx, status, json } = ctxFor(
      emitBody({ prNumber: 7 }),
      {},
      { 'content-length': String(ARTIFACT_MAX_REQUEST_BYTES + 1) },
    );
    await new EmitArtifact({} as never).handle(ctx);

    expect(status()).toBe(413);
    const body = json() as { error: { code: string; limit: number } };
    expect(body.error.code).toBe('payload_too_large');
    expect(body.error.limit).toBe(ARTIFACT_MAX_REQUEST_BYTES);
    expect(createClientMock).not.toHaveBeenCalled();
    expect(artifactLookups).toEqual([]);
  });

  it('admits a request whose Content-Length is exactly the ceiling (boundary is inclusive)', async () => {
    const { ctx, status } = ctxFor(
      emitBody({ prNumber: 7 }),
      {},
      { 'content-length': String(ARTIFACT_MAX_REQUEST_BYTES) },
    );
    await new EmitArtifact({} as never).handle(ctx);
    expect(status()).toBe(200);
    expect(artifactUpserts).toHaveLength(1);
  });

  it('rejects a filename carrying path separators or dot-dot', async () => {
    for (const filename of ['../etc/passwd', 'a/b.png', 'a\\b.png']) {
      const { ctx, status, json } = ctxFor(emitBody({ prNumber: 7, filename }));
      await new EmitArtifact({} as never).handle(ctx);
      expect(status()).toBe(400);
      expect((json() as { error: { code: string } }).error.code).toBe('invalid_request_body');
    }
    expect(artifactUpserts).toEqual([]);
  });

  it('returns the stored row on an idempotent retry without a second blob write', async () => {
    artifactSelectQueue.push({
      id: 'artifact-uuid-9',
      kind: 'screenshot',
      provenance: 'ci',
      verification: 'confirmed',
      pr_number: 512,
      repository: 'acme/api',
    });
    const { ctx, status, json } = ctxFor(emitBody({ ci: true, repository: 'acme/api', prNumber: 512 }));
    await new EmitArtifact({} as never).handle(ctx);

    expect(status()).toBe(200);
    expect(json()).toEqual({
      data: {
        id: 'artifact-uuid-9',
        kind: 'screenshot',
        provenance: 'ci',
        verification: 'confirmed',
        prNumber: 512,
        repository: 'acme/api',
      },
    });
    expect(artifactLookups).toEqual([{ appId: 'app-1', clientArtifactId: 'art_01HZX4T8' }]);
    expect(artifactUpserts).toEqual([]);
    expect(insertsByTable['agent_blobs']).toBeUndefined();
    expect(blobStore.size).toBe(0);
    expect(createClientMock).not.toHaveBeenCalled();
  });

  it('returns the winner row when a concurrent duplicate makes the upsert a no-op', async () => {
    upsertIgnored = true;
    // Pre-check misses (the duplicate lands mid-request), the post-upsert
    // re-read finds the winner.
    artifactSelectQueue = [
      null,
      {
        id: 'artifact-uuid-7',
        kind: 'screenshot',
        provenance: 'local',
        verification: 'pending',
        pr_number: 7,
        repository: '',
      },
    ];
    const { ctx, status, json } = ctxFor(emitBody({ prNumber: 7 }));
    await new EmitArtifact({} as never).handle(ctx);

    expect(status()).toBe(200);
    expect(json()).toEqual({
      data: {
        id: 'artifact-uuid-7',
        kind: 'screenshot',
        provenance: 'local',
        verification: 'pending',
        prNumber: 7,
        repository: '',
      },
    });
  });

  it('sheds 503 with Retry-After when the blob insert fails, before the row upsert', async () => {
    insertShouldThrow = new Error('ClickHouse 503: too many simultaneous queries');
    const { ctx, status, json, headers } = ctxFor(emitBody({ prNumber: 7 }));
    await new EmitArtifact({} as never).handle(ctx);

    expect(status()).toBe(503);
    expect((json() as { error: { code: string } }).error.code).toBe('service_unavailable');
    expect(headers()['Retry-After']).toBe('30');
    expect(artifactUpserts).toEqual([]);
  });

  it('returns 429 storage_cap_exceeded when the cap is reached, storing nothing', async () => {
    storageCapResult = { allowed: false, currentBytes: 5_000_000_000, limitBytes: 5_000_000_000, capReached: true };
    const { ctx, status, json } = ctxFor(emitBody({ prNumber: 7 }));
    await new EmitArtifact({} as never).handle(ctx);

    expect(status()).toBe(429);
    expect(json()).toEqual({
      error: {
        code: 'storage_cap_exceeded',
        message: 'Monthly storage cap exceeded. Upgrade your plan for more storage.',
        currentBytes: 5_000_000_000,
        limitBytes: 5_000_000_000,
      },
    });
    // Gated with the caller's verified tenant + stripe identity, not request input.
    expect(checkStorageCap).toHaveBeenCalledWith(expect.anything(), 'tenant-1', 'cus_1', expect.anything());
    expect(insertsByTable['agent_blobs']).toBeUndefined();
    expect(blobStore.size).toBe(0);
    expect(artifactUpserts).toEqual([]);
  });

  it('proceeds with the emit when the storage-cap check throws (fails open)', async () => {
    storageCapResult = null;
    const { ctx, status } = ctxFor(emitBody({ prNumber: 7 }));
    await new EmitArtifact({} as never).handle(ctx);

    expect(status()).toBe(200);
    expect(insertsByTable['agent_blobs']).toHaveLength(1);
    expect(artifactUpserts).toHaveLength(1);
  });

  it('never consults the storage cap for a refused emit — a stored nothing is not storage', async () => {
    const { ctx, status } = ctxFor(emitBody());
    await new EmitArtifact({} as never).handle(ctx);

    expect(status()).toBe(400);
    expect(checkStorageCap).not.toHaveBeenCalled();
  });

  it('declares the 200 success response schema (not an empty content object)', () => {
    const route = new EmitArtifact({} as never) as unknown as {
      schema: { responses: Record<string, { content?: Record<string, { schema?: { shape?: Record<string, unknown> } }> }> };
    };
    const ok = route.schema.responses['200'];
    // Kills `content: {}` and `content: { 'application/json': {} }`.
    expect(ok?.content?.['application/json']?.schema?.shape).toHaveProperty('data');
  });
});

// ---------------------------------------------------------------------------
// PR_COMMENT_QUEUE nomination
// ---------------------------------------------------------------------------

describe('EmitArtifact PR_COMMENT_QUEUE nomination', () => {
  it('nominates the PR for a comment refresh with the canonical repo key and the shared debounce', async () => {
    prRowExists = true;
    const queue = { sendBatch: vi.fn(async () => {}) };
    const { ctx, status } = ctxFor(
      emitBody({ ci: true, repository: 'Acme/API', prNumber: 512 }),
      {},
      {},
      { PR_COMMENT_QUEUE: queue },
    );
    await new EmitArtifact({} as never).handle(ctx);

    expect(status()).toBe(200);
    expect(queue.sendBatch).toHaveBeenCalledTimes(1);
    expect(queue.sendBatch).toHaveBeenCalledWith([
      {
        body: {
          tenantId: 'tenant-1',
          repository: 'acme/api',
          prNumber: 512,
          enqueuedAt: expect.any(Number),
        },
        delaySeconds: PR_COMMENT_QUEUE_DEBOUNCE_SECONDS,
      },
    ]);
  });

  it('does not nominate a PR whose repo is not a GitHub.com owner/repo', async () => {
    // A GHES remote anchors the artifact (pending) but cannot be nominated —
    // the comment feature is GitHub.com-only and a guessed key posts a
    // duplicate comment.
    const queue = { sendBatch: vi.fn(async () => {}) };
    const { ctx, status } = ctxFor(
      emitBody({ prNumber: 512, gitRepo: 'git.acme-enterprise.com/acme/api' }),
      {},
      {},
      { PR_COMMENT_QUEUE: queue },
    );
    await new EmitArtifact({} as never).handle(ctx);

    expect(status()).toBe(200);
    expect(artifactUpserts[0]!.row.repository).toBe('');
    expect(queue.sendBatch).not.toHaveBeenCalled();
  });

  it('swallows a sendBatch throw without failing the emit', async () => {
    prRowExists = true;
    const queue = {
      sendBatch: vi.fn(async () => {
        throw new Error('queue unavailable');
      }),
    };
    const { ctx, status, json } = ctxFor(
      emitBody({ ci: true, repository: 'acme/api', prNumber: 512 }),
      {},
      {},
      { PR_COMMENT_QUEUE: queue },
    );
    await new EmitArtifact({} as never).handle(ctx);

    expect(status()).toBe(200);
    expect((json() as { data: { prNumber: number } }).data.prNumber).toBe(512);
    expect(queue.sendBatch).toHaveBeenCalledTimes(1);
  });
});

describe('EmitArtifact — contract and edge branches', () => {
  it('declares the OpenAPI contract: tag, request schema, and the 503 Retry-After header', () => {
    const route = new EmitArtifact({} as never);
    const schema = route.schema as {
      tags: string[];
      request: { body: { content: Record<string, { schema: unknown }> } };
      responses: Record<string, { headers?: { shape?: Record<string, unknown> } }>;
    };

    expect(schema.tags).toEqual(['Artifacts']);
    const content = schema.request.body.content;
    expect(Object.keys(content)).toEqual(['application/json']);
    expect(content['application/json']!.schema).toBeInstanceOf(Object);
    expect(Object.keys(schema.responses).sort()).toEqual(['200', '400', '401', '413', '429', '503']);
    expect(schema.responses['503']!.headers).toBeInstanceOf(Object);
  });

  it('413s a request whose base64 payload alone exceeds the request ceiling, naming the limit', async () => {
    const { ctx, status, json } = ctxFor(
      emitBody({}, { data: 'a'.repeat(ARTIFACT_MAX_REQUEST_BYTES + 1) }),
    );
    await new EmitArtifact({} as never).handle(ctx);

    expect(status()).toBe(413);
    expect(json()).toEqual({
      error: {
        code: 'payload_too_large',
        message: `Artifact request exceeds the ${ARTIFACT_MAX_REQUEST_BYTES}-byte ceiling.`,
        limit: ARTIFACT_MAX_REQUEST_BYTES,
      },
    });
    expect(insertsByTable['agent_blobs']).toBeUndefined();
  });

  it('anchors on branch context alone — gitBranch with no gitRepo is still an anchor', async () => {
    const { ctx, status, json } = ctxFor(emitBody({ gitBranch: 'feat/only-branch' }));
    await new EmitArtifact({} as never).handle(ctx);

    expect(status()).toBe(200);
    expect((json() as { data: { verification: string; provenance: string } }).data).toMatchObject({
      verification: 'pending',
      provenance: 'local',
    });
    const inserted = artifactUpserts[artifactUpserts.length - 1]!.row;
    expect(inserted).toMatchObject({ git_branch: 'feat/only-branch', git_repo: '' });
  });

  it('never nominates a comment refresh for an artifact with no resolved PR number', async () => {
    sessionExistsInClickHouse = true;
    const queue = { sendBatch: vi.fn(async () => {}) };
    const { ctx, status } = ctxFor(
      emitBody({ session: { sessionId: 'sess-1' } }),
      {},
      {},
      { PR_COMMENT_QUEUE: queue },
    );
    await new EmitArtifact({} as never).handle(ctx);

    expect(status()).toBe(200);
    expect(queue.sendBatch).not.toHaveBeenCalled();
    // The session-existence probe runs on the shared ingest client factory,
    // pointed at the env's ClickHouse with its write identity.
    expect(createClientMock).toHaveBeenCalledWith(
      expect.objectContaining({ url: 'http://localhost:8123' }),
    );
  });
});
