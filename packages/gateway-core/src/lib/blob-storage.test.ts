/**
 * blob-storage — the S3 adapter + the backend factory. The backend *selection*
 * (env → r2/s3 + connection) is covered by blob-storage-config.test.ts; here we
 * pin the SigV4-signed S3 put/get, URL addressing, and the factory's wiring +
 * fail-loud guard. The R2 path is exercised end-to-end by get-blob-route.test.ts.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../types';
import type { S3Connection } from './blob-storage-config';
import {
  createBlobStorage,
  createS3BlobStorage,
  s3ObjectUrl,
} from './blob-storage';

const CONN: S3Connection = {
  endpoint: 'http://127.0.0.1:9300',
  region: 'us-east-1',
  accessKeyId: 'minioadmin',
  secretAccessKey: 'minioadmin',
  bucket: 'trace-blobs',
  forcePathStyle: true,
};

describe('s3ObjectUrl', () => {
  it('builds a path-style URL with per-segment encoding, keeping / as separators', () => {
    expect(s3ObjectUrl(CONN, 'tnt/app 1/trace/span/Output')).toBe(
      'http://127.0.0.1:9300/trace-blobs/tnt/app%201/trace/span/Output'
    );
  });

  it('builds a virtual-host-style URL when forcePathStyle is false', () => {
    expect(
      s3ObjectUrl(
        { ...CONN, endpoint: 'https://s3.amazonaws.com', forcePathStyle: false },
        'tnt/k'
      )
    ).toBe('https://trace-blobs.s3.amazonaws.com/tnt/k');
  });
});

describe('createS3BlobStorage (SigV4 over fetch)', () => {
  let store: Map<string, Uint8Array>;
  let requests: Request[];

  beforeEach(() => {
    store = new Map();
    requests = [];
    const fetchMock = vi.fn(async (input: Request | string, init?: RequestInit) => {
      const req = input instanceof Request ? input : new Request(input, init);
      requests.push(req);
      if (req.method === 'PUT') {
        store.set(req.url, new Uint8Array(await req.arrayBuffer()));
        return new Response(null, { status: 200 });
      }
      if (req.method === 'DELETE') {
        // S3 answers 204 whether or not the key existed.
        store.delete(req.url);
        return new Response(null, { status: 204 });
      }
      const found = store.get(req.url);
      if (!found) return new Response('NoSuchKey', { status: 404 });
      return new Response(found, { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => vi.unstubAllGlobals());

  it('round-trips bytes through a path-style, SigV4-signed request', async () => {
    const storage = createS3BlobStorage(CONN);
    const payload = new TextEncoder().encode('the full output payload');

    await storage.put('tnt/app/trace/span/Output', payload, 'text/plain');
    const got = await storage.get('tnt/app/trace/span/Output');

    expect(got).toEqual(payload);

    const put = requests.find((r) => r.method === 'PUT')!;
    expect(put.url).toBe('http://127.0.0.1:9300/trace-blobs/tnt/app/trace/span/Output');
    // Proves the request was actually SigV4-signed, not sent bare.
    expect(put.headers.get('authorization')).toMatch(/^AWS4-HMAC-SHA256 Credential=minioadmin\//);
    // SigV4 requires the content-sha256 header; aws4fetch sends UNSIGNED-PAYLOAD
    // (accepted by MinIO/S3 over a signed request — see the live MinIO test).
    expect(put.headers.get('x-amz-content-sha256')).toBe('UNSIGNED-PAYLOAD');
    expect(put.headers.get('content-type')).toBe('text/plain');
  });

  it('returns null for an absent object (404), not an error', async () => {
    expect(await createS3BlobStorage(CONN).get('tnt/missing')).toBeNull();
  });

  it('throws on a non-404 get error (e.g. 403/500), surfacing the status', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('AccessDenied', { status: 403 })));
    await expect(createS3BlobStorage(CONN).get('tnt/x')).rejects.toThrow('failed (403)');
  });

  it('throws when a put is rejected by the store', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 500 })));
    await expect(
      createS3BlobStorage(CONN).put('tnt/x', new Uint8Array([1]), 'application/octet-stream')
    ).rejects.toThrow('S3 put tnt/x failed (500)');
  });

  it('deletes an object with a signed DELETE, after which a get misses', async () => {
    const storage = createS3BlobStorage(CONN);
    await storage.put('tnt/app/blob', new Uint8Array([1, 2, 3]), 'image/png');

    await storage.delete('tnt/app/blob');

    expect(await storage.get('tnt/app/blob')).toBeNull();
    const del = requests.find((r) => r.method === 'DELETE')!;
    expect(del.url).toBe('http://127.0.0.1:9300/trace-blobs/tnt/app/blob');
    expect(del.headers.get('authorization')).toMatch(/^AWS4-HMAC-SHA256 Credential=minioadmin\//);
  });

  it('treats deleting an absent object as an idempotent no-op (404 as well as 204)', async () => {
    // The shared mock answers 204 for any DELETE — the faithful S3 shape.
    await expect(createS3BlobStorage(CONN).delete('tnt/never-stored')).resolves.toBeUndefined();
    // A gateway that answers 404 instead must read the same way.
    vi.stubGlobal('fetch', vi.fn(async () => new Response('NoSuchKey', { status: 404 })));
    await expect(createS3BlobStorage(CONN).delete('tnt/never-stored')).resolves.toBeUndefined();
  });

  it('throws on a non-404 delete failure, surfacing the status', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('AccessDenied', { status: 403 })));
    await expect(createS3BlobStorage(CONN).delete('tnt/x')).rejects.toThrow('S3 delete tnt/x failed (403)');
  });
});

describe('createBlobStorage (factory)', () => {
  it('uses the R2 binding by default (no BLOB_STORAGE_BACKEND)', async () => {
    const put = vi.fn(async () => {});
    const env = { TRACE_BLOBS: { put, get: vi.fn() } } as unknown as Env;
    await createBlobStorage(env).put('k', new Uint8Array([1]), 'text/plain');
    expect(put).toHaveBeenCalledWith('k', new Uint8Array([1]), {
      httpMetadata: { contentType: 'text/plain' },
    });
  });

  it('routes deletes to the R2 binding by key', async () => {
    const del = vi.fn(async () => {});
    const env = { TRACE_BLOBS: { put: vi.fn(), get: vi.fn(), delete: del } } as unknown as Env;
    await createBlobStorage(env).delete('tnt/app/blob');
    expect(del).toHaveBeenCalledWith('tnt/app/blob');
  });

  it('wires the S3 adapter when backend=s3 with a complete connection', async () => {
    const fetchMock = vi.fn(async () => new Response('hi', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const env = {
      BLOB_STORAGE_BACKEND: 's3',
      BLOB_S3_ENDPOINT: 'http://127.0.0.1:9300',
      BLOB_S3_ACCESS_KEY_ID: 'minioadmin',
      BLOB_S3_SECRET_ACCESS_KEY: 'minioadmin',
      BLOB_S3_BUCKET: 'trace-blobs',
    } as unknown as Env;

    await createBlobStorage(env).get('tnt/k');

    const req = fetchMock.mock.calls[0]![0] as Request;
    expect(req.url).toBe('http://127.0.0.1:9300/trace-blobs/tnt/k');
    expect(req.headers.get('authorization')).toMatch(/^AWS4-HMAC-SHA256/);
    vi.unstubAllGlobals();
  });

  it('throws (never a silent no-op) when backend=s3 but the connection is incomplete', () => {
    const env = { BLOB_STORAGE_BACKEND: 's3', BLOB_S3_ENDPOINT: 'http://x' } as unknown as Env;
    expect(() => createBlobStorage(env)).toThrow('S3 connection is incomplete');
  });
});
