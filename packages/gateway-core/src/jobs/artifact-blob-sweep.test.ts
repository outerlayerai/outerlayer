/**
 * Unit tests for sweepUnmatchedArtifactBlobs (jobs/artifact-blob-sweep.ts) —
 * the storage half of artifact age-out.
 *
 * ClickHouse commands/reads and object-storage operations are captured at
 * their module seams; the admin Supabase client is a stateful fake whose
 * builder chains capture their filter COLUMN NAMES alongside the values, so
 * a filter on the wrong column fails even when the values line up.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Captured ClickHouse traffic: point deletes via command(), rehydration reads
// via query().
const commands: Array<{ query: string; query_params: Record<string, unknown> }> = [];
let commandShouldThrow: Error | null = null;
const blobReads: Array<{ query: string; query_params: Record<string, unknown> }> = [];
let chBlobRow: { MediaType: string; Data: string } | null = null;
const closes: Array<true> = [];
vi.mock('@clickhouse/client-web', () => ({
  createClient: vi.fn(() => ({
    command: vi.fn(async (params: { query: string; query_params: Record<string, unknown> }) => {
      if (commandShouldThrow) throw commandShouldThrow;
      commands.push({ query: params.query, query_params: params.query_params });
    }),
    query: vi.fn(async (params: { query: string; query_params: Record<string, unknown> }) => {
      blobReads.push({ query: params.query, query_params: params.query_params });
      return { json: async () => (chBlobRow ? [chBlobRow] : []) };
    }),
    close: vi.fn(async () => {
      closes.push(true);
    }),
  })),
}));

// Object-storage seam: a keyed map so get/put/delete interact the way the
// restore path relies on.
const storageObjects = new Map<string, Uint8Array>();
const storageDeletes: string[] = [];
const storagePuts: Array<{ key: string; bytes: number[]; contentType: string }> = [];
let storageDeleteShouldThrow: Error | null = null;
let blobStorageAvailable = true;
vi.mock('../lib/blob-storage', () => ({
  createBlobStorage: vi.fn(() => {
    if (!blobStorageAvailable) throw new Error('no object storage configured');
    return {
      put: async (key: string, bytes: Uint8Array, contentType: string) => {
        storagePuts.push({ key, bytes: Array.from(bytes), contentType });
        storageObjects.set(key, bytes);
      },
      get: async (key: string) => storageObjects.get(key) ?? null,
      delete: async (key: string) => {
        if (storageDeleteShouldThrow) throw storageDeleteShouldThrow;
        storageDeletes.push(key);
        storageObjects.delete(key);
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
// Supabase fake — builder methods are plain closures capturing filter columns
// and values into arrays.
// ---------------------------------------------------------------------------

type BatchRow = { id: string; tenant_id: string; app_id: string; sha256: string };
type CountQuery = { filters: Array<[string, unknown]>; excludeId: [string, unknown] };

let batchRows: BatchRow[] = [];
let batchReadError: { message: string } | null = null;
const batchReads: Array<{ select: string; filters: Array<[string, unknown]>; limit: number }> = [];
let countResolver: (q: CountQuery, nthCallForRow: number) => number = () => 0;
let countReadError: { message: string } | null = null;
const countQueries: CountQuery[] = [];
const updates: Array<{ values: Record<string, unknown>; filters: Array<[string, unknown]> }> = [];
let updateError: { message: string } | null = null;

function fakeDb() {
  const countCallsByExclude = new Map<unknown, number>();
  return {
    from: (table: string) => {
      if (table !== 'artifact') throw new Error(`unexpected table: ${table}`);
      return {
        select: (select: string, opts?: { count?: string; head?: boolean }) => {
          if (opts?.head) {
            return {
              eq: (c1: string, v1: unknown) => ({
                eq: (c2: string, v2: unknown) => ({
                  eq: (c3: string, v3: unknown) => ({
                    eq: (c4: string, v4: unknown) => ({
                      neq: async (c5: string, v5: unknown) => {
                        const q: CountQuery = {
                          filters: [
                            [c1, v1],
                            [c2, v2],
                            [c3, v3],
                            [c4, v4],
                          ],
                          excludeId: [c5, v5],
                        };
                        countQueries.push(q);
                        if (countReadError) return { count: null, error: countReadError };
                        const nth = (countCallsByExclude.get(v5) ?? 0) + 1;
                        countCallsByExclude.set(v5, nth);
                        return { count: countResolver(q, nth), error: null };
                      },
                    }),
                  }),
                }),
              }),
            };
          }
          return {
            eq: (c1: string, v1: unknown) => ({
              eq: (c2: string, v2: unknown) => ({
                limit: async (limit: number) => {
                  batchReads.push({
                    select,
                    filters: [
                      [c1, v1],
                      [c2, v2],
                    ],
                    limit,
                  });
                  if (batchReadError) return { data: null, error: batchReadError };
                  return { data: batchRows, error: null };
                },
              }),
            }),
          };
        },
        update: (values: Record<string, unknown>) => ({
          eq: (c1: string, v1: unknown) => ({
            eq: async (c2: string, v2: unknown) => {
              if (updateError) return { error: updateError };
              updates.push({
                values,
                filters: [
                  [c1, v1],
                  [c2, v2],
                ],
              });
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
const keyA = `agents/tenant-1/app-1/${shaA}`;

const FENCED_DELETE_QUERY =
  'DELETE FROM agent_blobs ' +
  'WHERE TenantId = {t:String} AND AppId = {a:String} AND Sha256 = {s:String} ' +
  'AND InsertedAt < (now() - INTERVAL 1 HOUR)';

function unmatchedRow(over: Partial<BatchRow> = {}): BatchRow {
  return { id: 'row-1', tenant_id: 'tenant-1', app_id: 'app-1', sha256: shaA, ...over };
}

function claimCountFilters(row: BatchRow): CountQuery {
  return {
    filters: [
      ['tenant_id', row.tenant_id],
      ['app_id', row.app_id],
      ['sha256', row.sha256],
      ['blob_deleted', false],
    ],
    excludeId: ['id', row.id],
  };
}

beforeEach(() => {
  commands.length = 0;
  commandShouldThrow = null;
  blobReads.length = 0;
  chBlobRow = null;
  closes.length = 0;
  storageObjects.clear();
  storageDeletes.length = 0;
  storagePuts.length = 0;
  storageDeleteShouldThrow = null;
  blobStorageAvailable = true;
  batchRows = [];
  batchReadError = null;
  batchReads.length = 0;
  countResolver = () => 0;
  countReadError = null;
  countQueries.length = 0;
  updates.length = 0;
  updateError = null;
  createClientMock.mockClear();
  createBlobStorageMock.mockClear();
});

describe('sweepUnmatchedArtifactBlobs', () => {
  // proves AC-084-08
  it('deletes an unmatched row\'s blob from both stores and stamps the row', async () => {
    batchRows = [unmatchedRow()];

    const result = await sweepUnmatchedArtifactBlobs(env, fakeDb() as never);

    // Only unmatched, not-yet-swept rows are ever read — on those columns.
    expect(batchReads).toEqual([
      {
        select: 'id,tenant_id,app_id,sha256',
        filters: [
          ['verification', 'unmatched'],
          ['blob_deleted', false],
        ],
        limit: ARTIFACT_BLOB_SWEEP_BATCH_SIZE,
      },
    ]);
    // ClickHouse copy: a point delete scoped to the row's own tenant + app
    // and fenced to rows older than the emit-in-flight window.
    expect(commands).toEqual([
      {
        query: FENCED_DELETE_QUERY,
        query_params: { t: 'tenant-1', a: 'app-1', s: shaA },
      },
    ]);
    // Object-storage copy under the same content-addressed key the emit wrote.
    expect(storageDeletes).toEqual([keyA]);
    // Liveness is read on the exact claim columns, before AND after the
    // deletes (the recount barrier), excluding the row itself.
    expect(countQueries).toEqual([claimCountFilters(batchRows[0]!), claimCountFilters(batchRows[0]!)]);
    // Stamped only after both deletes, keyed by id within the row's tenant.
    expect(updates).toEqual([
      {
        values: { blob_deleted: true },
        filters: [
          ['id', 'row-1'],
          ['tenant_id', 'tenant-1'],
        ],
      },
    ]);
    expect(result).toEqual({ examined: 1, blobsDeleted: 1, blobsRestored: 0, rowsMarked: 1, failures: 0 });
    expect(closes).toHaveLength(1);
  });

  it('releases a shared-sha row without deleting the bytes another artifact still claims', async () => {
    batchRows = [unmatchedRow()];
    storageObjects.set(keyA, new Uint8Array([1, 2, 3]));
    countResolver = () => 1;

    const result = await sweepUnmatchedArtifactBlobs(env, fakeDb() as never);

    expect(countQueries).toEqual([claimCountFilters(batchRows[0]!)]);
    expect(commands).toEqual([]);
    expect(storageDeletes).toEqual([]);
    // The object copy exists, so the release-path heal reads nothing back.
    expect(blobReads).toEqual([]);
    expect(storagePuts).toEqual([]);
    // The claim is still released — the surviving reference keeps the bytes.
    expect(updates).toEqual([
      {
        values: { blob_deleted: true },
        filters: [
          ['id', 'row-1'],
          ['tenant_id', 'tenant-1'],
        ],
      },
    ]);
    expect(result).toEqual({ examined: 1, blobsDeleted: 0, blobsRestored: 0, rowsMarked: 1, failures: 0 });
  });

  it('heals a missing object copy from ClickHouse while releasing a shared-sha row', async () => {
    // A prior interrupted run deleted the object copy out from under a
    // surviving claim; the release path restores it from agent_blobs.
    batchRows = [unmatchedRow()];
    countResolver = () => 1;
    chBlobRow = { MediaType: 'image/png', Data: Buffer.from([9, 8, 7]).toString('base64') };

    const result = await sweepUnmatchedArtifactBlobs(env, fakeDb() as never);

    expect(blobReads).toEqual([
      {
        query:
          'SELECT MediaType, Data FROM agent_blobs ' +
          'WHERE TenantId = {t:String} AND AppId = {a:String} AND Sha256 = {s:String} ' +
          'ORDER BY InsertedAt DESC LIMIT 1',
        query_params: { t: 'tenant-1', a: 'app-1', s: shaA },
      },
    ]);
    expect(storagePuts).toEqual([{ key: keyA, bytes: [9, 8, 7], contentType: 'image/png' }]);
    expect(updates.map((u) => u.filters[0])).toEqual([['id', 'row-1']]);
    expect(result).toEqual({ examined: 1, blobsDeleted: 0, blobsRestored: 1, rowsMarked: 1, failures: 0 });
  });

  it('restores the object copy when a concurrent emit claims the sha between the count and the deletes', async () => {
    // The emit inserts its artifact row before writing bytes, so the claim
    // that raced the deletes is visible to the recount; its fenced ClickHouse
    // row is the restore source.
    batchRows = [unmatchedRow()];
    countResolver = (_q, nthCallForRow) => (nthCallForRow === 1 ? 0 : 1);
    chBlobRow = { MediaType: 'video/webm', Data: Buffer.from([4, 5, 6]).toString('base64') };

    const result = await sweepUnmatchedArtifactBlobs(env, fakeDb() as never);

    expect(commands).toEqual([
      { query: FENCED_DELETE_QUERY, query_params: { t: 'tenant-1', a: 'app-1', s: shaA } },
    ]);
    expect(storageDeletes).toEqual([keyA]);
    expect(storagePuts).toEqual([{ key: keyA, bytes: [4, 5, 6], contentType: 'video/webm' }]);
    // The racing claim keeps the bytes: released, not deleted.
    expect(updates.map((u) => u.filters[0])).toEqual([['id', 'row-1']]);
    expect(result).toEqual({ examined: 1, blobsDeleted: 0, blobsRestored: 1, rowsMarked: 1, failures: 0 });
  });

  it('fails the row (no stamp) when a claim appears mid-delete and no ClickHouse copy is visible yet', async () => {
    batchRows = [unmatchedRow()];
    countResolver = (_q, nthCallForRow) => (nthCallForRow === 1 ? 0 : 1);
    chBlobRow = null;

    const result = await sweepUnmatchedArtifactBlobs(env, fakeDb() as never);

    expect(storageDeletes).toEqual([keyA]);
    expect(storagePuts).toEqual([]);
    expect(updates).toEqual([]);
    expect(result).toEqual({ examined: 1, blobsDeleted: 0, blobsRestored: 0, rowsMarked: 0, failures: 1 });
  });

  it('converges when one batch holds every claimant of a sha: earlier rows release, the last deletes', async () => {
    batchRows = [unmatchedRow({ id: 'row-a' }), unmatchedRow({ id: 'row-b' })];
    storageObjects.set(keyA, new Uint8Array([1]));
    // Liveness reflects stamps already applied this run — the un-stamped
    // sibling counts as a live claim, a stamped one does not.
    countResolver = ({ excludeId }) => {
      const stamped = new Set(updates.map((u) => u.filters[0]![1]));
      return ['row-a', 'row-b'].filter((id) => id !== excludeId[1] && !stamped.has(id)).length;
    };

    const result = await sweepUnmatchedArtifactBlobs(env, fakeDb() as never);

    expect(commands).toHaveLength(1);
    expect(storageDeletes).toEqual([keyA]);
    expect(updates.map((u) => u.filters[0]![1])).toEqual(['row-a', 'row-b']);
    expect(result).toEqual({ examined: 2, blobsDeleted: 1, blobsRestored: 0, rowsMarked: 2, failures: 0 });
  });

  it('leaves a row unstamped when the object-storage delete fails, so the next sweep retries it', async () => {
    batchRows = [unmatchedRow()];
    storageDeleteShouldThrow = new Error('storage 500');

    const result = await sweepUnmatchedArtifactBlobs(env, fakeDb() as never);

    // The ClickHouse half already ran — safe, because the retry re-issues it
    // as an idempotent no-op.
    expect(commands).toHaveLength(1);
    expect(updates).toEqual([]);
    expect(result).toEqual({ examined: 1, blobsDeleted: 0, blobsRestored: 0, rowsMarked: 0, failures: 1 });
  });

  it('leaves a row unstamped and skips object storage when the ClickHouse delete fails', async () => {
    batchRows = [unmatchedRow()];
    commandShouldThrow = new Error('CH saturated');

    const result = await sweepUnmatchedArtifactBlobs(env, fakeDb() as never);

    expect(storageDeletes).toEqual([]);
    expect(updates).toEqual([]);
    expect(result).toEqual({ examined: 1, blobsDeleted: 0, blobsRestored: 0, rowsMarked: 0, failures: 1 });
    expect(closes).toHaveLength(1);
  });

  it('completes with the ClickHouse delete alone when no object storage is configured', async () => {
    batchRows = [unmatchedRow()];
    blobStorageAvailable = false;

    const result = await sweepUnmatchedArtifactBlobs(env, fakeDb() as never);

    expect(commands).toHaveLength(1);
    expect(storageDeletes).toEqual([]);
    expect(updates.map((u) => u.filters[0])).toEqual([['id', 'row-1']]);
    expect(result).toEqual({ examined: 1, blobsDeleted: 1, blobsRestored: 0, rowsMarked: 1, failures: 0 });
  });

  it('opens no ClickHouse client or storage when there is nothing to sweep', async () => {
    const result = await sweepUnmatchedArtifactBlobs(env, fakeDb() as never);

    expect(result).toEqual({ examined: 0, blobsDeleted: 0, blobsRestored: 0, rowsMarked: 0, failures: 0 });
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
      if (excludeId[1] === 'row-bad') throw new Error('count boom');
      return 0;
    };

    const result = await sweepUnmatchedArtifactBlobs(env, fakeDb() as never);

    expect(updates.map((u) => u.filters[0]![1])).toEqual(['row-good']);
    expect(storageDeletes).toEqual([keyA]);
    expect(result).toEqual({ examined: 2, blobsDeleted: 1, blobsRestored: 0, rowsMarked: 1, failures: 1 });
  });

  it('leaves a row unstamped when the stamp write fails, deleting at most once thanks to idempotent deletes', async () => {
    batchRows = [unmatchedRow()];
    updateError = { message: 'row lock timeout' };

    const result = await sweepUnmatchedArtifactBlobs(env, fakeDb() as never);

    expect(commands).toHaveLength(1);
    expect(updates).toEqual([]);
    expect(result).toEqual({ examined: 1, blobsDeleted: 1, blobsRestored: 0, rowsMarked: 0, failures: 1 });
  });
});
