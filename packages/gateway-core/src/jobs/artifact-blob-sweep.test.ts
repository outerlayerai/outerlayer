/**
 * Unit tests for sweepUnmatchedArtifactBlobs (jobs/artifact-blob-sweep.ts) —
 * the storage half of artifact age-out.
 *
 * ClickHouse commands and object-storage deletes are captured at their module
 * seams; the admin Supabase client is a stateful fake whose builder chains
 * capture their filter arguments so scoping is asserted exactly.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Captured ClickHouse traffic.
const commands: Array<{ query: string; query_params: Record<string, unknown> }> = [];
let commandShouldThrow: Error | null = null;
const closes: Array<true> = [];
vi.mock('@clickhouse/client-web', () => ({
  createClient: vi.fn(() => ({
    command: vi.fn(async (params: { query: string; query_params: Record<string, unknown> }) => {
      if (commandShouldThrow) throw commandShouldThrow;
      commands.push({ query: params.query, query_params: params.query_params });
    }),
    close: vi.fn(async () => {
      closes.push(true);
    }),
  })),
}));

// Object-storage seam.
const storageDeletes: string[] = [];
let storageDeleteShouldThrow: Error | null = null;
let blobStorageAvailable = true;
vi.mock('../lib/blob-storage', () => ({
  createBlobStorage: vi.fn(() => {
    if (!blobStorageAvailable) throw new Error('no object storage configured');
    return {
      put: async () => {},
      get: async () => null,
      delete: async (key: string) => {
        if (storageDeleteShouldThrow) throw storageDeleteShouldThrow;
        storageDeletes.push(key);
      },
    };
  }),
}));

import { createClient } from '@clickhouse/client-web';
import { createBlobStorage } from '../lib/blob-storage';
import {
  sweepUnmatchedArtifactBlobs,
  ARTIFACT_BLOB_SWEEP_BATCH_SIZE,
} from './artifact-blob-sweep';
import type { Env } from '../types';

const createClientMock = vi.mocked(createClient);
const createBlobStorageMock = vi.mocked(createBlobStorage);

// ---------------------------------------------------------------------------
// Supabase fake — builder methods are plain closures capturing into arrays.
// ---------------------------------------------------------------------------

type BatchRow = { id: string; tenant_id: string; app_id: string; sha256: string };
type CountQuery = {
  tenantId: string;
  appId: string;
  sha256: string;
  blobDeleted: boolean;
  excludeId: string;
};

let batchRows: BatchRow[] = [];
let batchReadError: { message: string } | null = null;
const batchFilters: Array<Record<string, unknown>> = [];
let countResolver: (q: CountQuery) => number = () => 0;
let countReadError: { message: string } | null = null;
const countQueries: CountQuery[] = [];
const updates: Array<{ id: string; tenantId: string; values: Record<string, unknown> }> = [];
let updateError: { message: string } | null = null;

function fakeDb() {
  return {
    from: (table: string) => {
      if (table !== 'artifact') throw new Error(`unexpected table: ${table}`);
      return {
        select: (_cols: string, opts?: { count?: string; head?: boolean }) => {
          if (opts?.head) {
            return {
              eq: (_c1: string, tenantId: string) => ({
                eq: (_c2: string, appId: string) => ({
                  eq: (_c3: string, sha256: string) => ({
                    eq: (_c4: string, blobDeleted: boolean) => ({
                      neq: async (_c5: string, excludeId: string) => {
                        const q: CountQuery = { tenantId, appId, sha256, blobDeleted, excludeId };
                        countQueries.push(q);
                        if (countReadError) return { count: null, error: countReadError };
                        return { count: countResolver(q), error: null };
                      },
                    }),
                  }),
                }),
              }),
            };
          }
          return {
            eq: (_c1: string, verification: string) => ({
              eq: (_c2: string, blobDeleted: boolean) => ({
                limit: async (limit: number) => {
                  batchFilters.push({ verification, blobDeleted, limit });
                  if (batchReadError) return { data: null, error: batchReadError };
                  return { data: batchRows, error: null };
                },
              }),
            }),
          };
        },
        update: (values: Record<string, unknown>) => ({
          eq: (_c1: string, id: string) => ({
            eq: async (_c2: string, tenantId: string) => {
              if (updateError) return { error: updateError };
              updates.push({ id, tenantId, values });
              return { error: null };
            },
          }),
        }),
      };
    },
  };
}

const env = { CLICKHOUSE_HOST: 'http://localhost:8123', CLICKHOUSE_PASSWORD: 'x' } as unknown as Env;

const shaA = 'a'.repeat(64);

function unmatchedRow(over: Partial<BatchRow> = {}): BatchRow {
  return { id: 'row-1', tenant_id: 'tenant-1', app_id: 'app-1', sha256: shaA, ...over };
}

beforeEach(() => {
  commands.length = 0;
  commandShouldThrow = null;
  closes.length = 0;
  storageDeletes.length = 0;
  storageDeleteShouldThrow = null;
  blobStorageAvailable = true;
  batchRows = [];
  batchReadError = null;
  batchFilters.length = 0;
  countResolver = () => 0;
  countReadError = null;
  countQueries.length = 0;
  updates.length = 0;
  updateError = null;
  createClientMock.mockClear();
  createBlobStorageMock.mockClear();
});

describe('sweepUnmatchedArtifactBlobs', () => {
  // proves AC-082-08
  it('deletes an unmatched row\'s blob from both stores and stamps the row', async () => {
    batchRows = [unmatchedRow()];

    const result = await sweepUnmatchedArtifactBlobs(env, fakeDb() as never);

    // Only unmatched, not-yet-swept rows are ever read.
    expect(batchFilters).toEqual([
      { verification: 'unmatched', blobDeleted: false, limit: ARTIFACT_BLOB_SWEEP_BATCH_SIZE },
    ]);
    // ClickHouse copy: a point delete scoped to the row's own tenant + app.
    expect(commands).toEqual([
      {
        query:
          'DELETE FROM agent_blobs ' +
          'WHERE TenantId = {t:String} AND AppId = {a:String} AND Sha256 = {s:String}',
        query_params: { t: 'tenant-1', a: 'app-1', s: shaA },
      },
    ]);
    // Object-storage copy under the same content-addressed key the emit wrote.
    expect(storageDeletes).toEqual([`agents/tenant-1/app-1/${shaA}`]);
    // Stamped only after both deletes.
    expect(updates).toEqual([{ id: 'row-1', tenantId: 'tenant-1', values: { blob_deleted: true } }]);
    expect(result).toEqual({ examined: 1, blobsDeleted: 1, rowsMarked: 1, failures: 0 });
    expect(closes).toHaveLength(1);
  });

  it('releases a shared-sha row without deleting the bytes another artifact still claims', async () => {
    batchRows = [unmatchedRow()];
    countResolver = () => 1;

    const result = await sweepUnmatchedArtifactBlobs(env, fakeDb() as never);

    // The liveness read is scoped to the row's exact claim and excludes the
    // row itself.
    expect(countQueries).toEqual([
      { tenantId: 'tenant-1', appId: 'app-1', sha256: shaA, blobDeleted: false, excludeId: 'row-1' },
    ]);
    expect(commands).toEqual([]);
    expect(storageDeletes).toEqual([]);
    // The claim is still released — the surviving reference keeps the bytes.
    expect(updates).toEqual([{ id: 'row-1', tenantId: 'tenant-1', values: { blob_deleted: true } }]);
    expect(result).toEqual({ examined: 1, blobsDeleted: 0, rowsMarked: 1, failures: 0 });
  });

  it('converges when one batch holds every claimant of a sha: earlier rows release, the last deletes', async () => {
    batchRows = [unmatchedRow({ id: 'row-a' }), unmatchedRow({ id: 'row-b' })];
    // Liveness reflects stamps already applied this run — the un-stamped
    // sibling counts as a live claim, a stamped one does not.
    countResolver = ({ excludeId }) => {
      const stamped = new Set(updates.map((u) => u.id));
      return ['row-a', 'row-b'].filter((id) => id !== excludeId && !stamped.has(id)).length;
    };

    const result = await sweepUnmatchedArtifactBlobs(env, fakeDb() as never);

    expect(commands).toHaveLength(1);
    expect(storageDeletes).toEqual([`agents/tenant-1/app-1/${shaA}`]);
    expect(updates.map((u) => u.id)).toEqual(['row-a', 'row-b']);
    expect(result).toEqual({ examined: 2, blobsDeleted: 1, rowsMarked: 2, failures: 0 });
  });

  it('leaves a row unstamped when the object-storage delete fails, so the next sweep retries it', async () => {
    batchRows = [unmatchedRow()];
    storageDeleteShouldThrow = new Error('storage 500');

    const result = await sweepUnmatchedArtifactBlobs(env, fakeDb() as never);

    // The ClickHouse half already ran — safe, because the retry re-issues it
    // as an idempotent no-op.
    expect(commands).toHaveLength(1);
    expect(updates).toEqual([]);
    expect(result).toEqual({ examined: 1, blobsDeleted: 0, rowsMarked: 0, failures: 1 });
  });

  it('leaves a row unstamped and skips object storage when the ClickHouse delete fails', async () => {
    batchRows = [unmatchedRow()];
    commandShouldThrow = new Error('CH saturated');

    const result = await sweepUnmatchedArtifactBlobs(env, fakeDb() as never);

    expect(storageDeletes).toEqual([]);
    expect(updates).toEqual([]);
    expect(result).toEqual({ examined: 1, blobsDeleted: 0, rowsMarked: 0, failures: 1 });
    expect(closes).toHaveLength(1);
  });

  it('completes with the ClickHouse delete alone when no object storage is configured', async () => {
    batchRows = [unmatchedRow()];
    blobStorageAvailable = false;

    const result = await sweepUnmatchedArtifactBlobs(env, fakeDb() as never);

    expect(commands).toHaveLength(1);
    expect(storageDeletes).toEqual([]);
    expect(updates).toEqual([{ id: 'row-1', tenantId: 'tenant-1', values: { blob_deleted: true } }]);
    expect(result).toEqual({ examined: 1, blobsDeleted: 1, rowsMarked: 1, failures: 0 });
  });

  it('opens no ClickHouse client or storage when there is nothing to sweep', async () => {
    const result = await sweepUnmatchedArtifactBlobs(env, fakeDb() as never);

    expect(result).toEqual({ examined: 0, blobsDeleted: 0, rowsMarked: 0, failures: 0 });
    expect(createClientMock).not.toHaveBeenCalled();
    expect(createBlobStorageMock).not.toHaveBeenCalled();
  });

  it('throws when the unmatched read itself fails (the cron logs it; nothing is touched)', async () => {
    batchReadError = { message: 'connection refused' };

    await expect(sweepUnmatchedArtifactBlobs(env, fakeDb() as never)).rejects.toThrow(
      'unmatched read failed: connection refused',
    );
    expect(createClientMock).not.toHaveBeenCalled();
  });

  it('continues past a failing row and still sweeps the rest', async () => {
    batchRows = [unmatchedRow({ id: 'row-bad', sha256: 'b'.repeat(64) }), unmatchedRow({ id: 'row-good' })];
    countResolver = ({ excludeId }) => {
      if (excludeId === 'row-bad') throw new Error('count boom');
      return 0;
    };

    const result = await sweepUnmatchedArtifactBlobs(env, fakeDb() as never);

    expect(updates.map((u) => u.id)).toEqual(['row-good']);
    expect(storageDeletes).toEqual([`agents/tenant-1/app-1/${shaA}`]);
    expect(result).toEqual({ examined: 2, blobsDeleted: 1, rowsMarked: 1, failures: 1 });
  });

  it('leaves a row unstamped when the stamp write fails, deleting at most once thanks to idempotent deletes', async () => {
    batchRows = [unmatchedRow()];
    updateError = { message: 'row lock timeout' };

    const result = await sweepUnmatchedArtifactBlobs(env, fakeDb() as never);

    expect(commands).toHaveLength(1);
    expect(updates).toEqual([]);
    expect(result).toEqual({ examined: 1, blobsDeleted: 1, rowsMarked: 0, failures: 1 });
  });
});
