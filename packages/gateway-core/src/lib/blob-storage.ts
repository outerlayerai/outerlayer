/**
 * Blob storage for oversized span payloads lifted out at ingest.
 *
 * One interface, two swappable implementations selected at boot by
 * {@link resolveBlobStorageConfig}:
 *   - `r2`  — the Cloudflare R2 binding (cloud default + local `wrangler dev`,
 *             which simulates R2). Zero egress + a native binding, so no
 *             HTTP/auth hop on the hot ingest path. Used by hosted.
 *   - `s3`  — an S3-compatible store (MinIO / Supabase Storage / AWS S3) reached
 *             over SigV4-signed HTTP. Lets a self-hoster with no Cloudflare
 *             account run blob-offload (`BLOB_STORAGE_BACKEND=s3`).
 *
 * Both back the same {@link BlobStorage} surface, so every call site uses
 * {@link createBlobStorage} and never learns which backend it got.
 *
 * `put`/`get` are the server-side paths: the offload write, the rehydration
 * resolver, and the tenant-scoped `GET /v1/blobs` read. Browser-direct reads via
 * presigned URLs are a later optimization and not required by either backend.
 */

import { AwsClient } from 'aws4fetch';
import type { Env } from '../types';
import {
  resolveBlobStorageConfig,
  type S3Connection,
} from './blob-storage-config';

export interface BlobStorage {
  /**
   * Upload bytes under `key`. Overwrites (S3/R2 put is last-writer-wins) so a
   * retried ingest re-PUTting the same deterministic key is idempotent.
   */
  put(key: string, body: Uint8Array, contentType: string): Promise<void>;
  /** Fetch full bytes (server-side rehydration). Null when the object is absent. */
  get(key: string): Promise<Uint8Array | null>;
  /**
   * Delete the object under `key`. Deleting an absent object is an idempotent
   * no-op on both backends (R2 resolves; S3 answers 204 either way), so a
   * sweep that re-runs after a partial failure never errors on the half it
   * already finished.
   */
  delete(key: string): Promise<void>;
}

/** Raised when a blob key is not a plain, tenant-prefixed object path. */
export class InvalidBlobKeyError extends Error {
  constructor() {
    // The message omits the key: it is caller-supplied on a request path, so
    // echoing it back would tell the caller how it was read.
    super('blob-offload: invalid blob key');
    this.name = 'InvalidBlobKeyError';
  }
}

/** S3/R2 object-key ceiling. */
const MAX_BLOB_KEY_LENGTH = 1024;

/**
 * Reject any key that is not a plain object path.
 *
 * Nothing beneath this normalises a key: `s3ObjectUrl` encodes each `/`-segment
 * with `encodeURIComponent`, which leaves `.` and `..` untouched (both are
 * unreserved characters), and `aws4fetch` then builds a `URL`, whose parser
 * resolves dot-segments into the pathname it signs. A key must therefore already
 * be plain by the time it reaches the store.
 *
 * The check lives at the storage boundary rather than per call site because
 * every read and write in the process funnels through `put`/`get`. Callers that
 * build keys server-side from verified ids are unaffected.
 */
export function assertSafeBlobKey(key: string): void {
  // S3/R2 cap object keys at 1024 bytes; a longer one is malformed by
  // definition, and rejecting it here keeps the store from deciding.
  if (key.length > MAX_BLOB_KEY_LENGTH) throw new InvalidBlobKeyError();

  // A backslash is a path separator to some S3 gateways, so `a\..\b` is a
  // traversal there even though the segment split below does not see it.
  if (key.includes('\\')) throw new InvalidBlobKeyError();

  // Control characters, and `%` — the latter would let a caller smuggle a
  // second round of encoding past the per-segment encodeURIComponent.
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f%]/.test(key)) throw new InvalidBlobKeyError();

  // The segment walk is the only check needed here; it subsumes several cases
  // worth naming so nobody adds a redundant guard beside it:
  //   ''      -> ['']            empty segment
  //   '/a'    -> ['', 'a']       empty first segment (absolute path)
  //   'a//b'  -> ['a', '', 'b']  empty middle segment
  //   'a/'    -> ['a', '']       empty last segment
  // An explicit empty-string, leading-slash or '//' guard is dead code here.
  for (const segment of key.split('/')) {
    if (segment === '' || segment === '.' || segment === '..') {
      throw new InvalidBlobKeyError();
    }
  }
}

/**
 * Build the active {@link BlobStorage} for this request/deploy, per the resolved
 * backend config. The `s3` backend is an explicit opt-in
 * (`BLOB_STORAGE_BACKEND=s3`), so a selected-but-unresolved S3 connection throws
 * here rather than silently no-op'ing — a blob write that goes nowhere would
 * drop the oversized payload while leaving a dangling `BlobRef` on the span.
 */
export function createBlobStorage(env: Env): BlobStorage {
  const config = resolveBlobStorageConfig(env);
  if (config.backend === 's3') {
    if (!config.s3) {
      throw new Error(
        'blob-offload: BLOB_STORAGE_BACKEND=s3 but the S3 connection is incomplete. ' +
          'Set BLOB_S3_ENDPOINT, BLOB_S3_ACCESS_KEY_ID, BLOB_S3_SECRET_ACCESS_KEY, and BLOB_S3_BUCKET.'
      );
    }
    return createS3BlobStorage(config.s3);
  }
  return createR2BlobStorage(env);
}

/** R2-binding-backed storage (cloud + local wrangler dev). */
export function createR2BlobStorage(env: Env): BlobStorage {
  const bucket = env.TRACE_BLOBS;
  return {
    put: async (key, body, contentType) => {
      assertSafeBlobKey(key);
      await bucket.put(key, body, { httpMetadata: { contentType } });
    },
    get: async (key) => {
      assertSafeBlobKey(key);
      const obj = await bucket.get(key);
      if (!obj) return null;
      return new Uint8Array(await obj.arrayBuffer());
    },
    delete: async (key) => {
      assertSafeBlobKey(key);
      await bucket.delete(key);
    },
  };
}

/**
 * Object URL for a key. Path-style (`{endpoint}/{bucket}/{key}`) is the default
 * and what MinIO/most self-hosted servers need (virtual-host style requires
 * per-bucket DNS). When `forcePathStyle` is false, use virtual-host style
 * (`{scheme}://{bucket}.{host}/{key}`) for AWS S3 proper. Each `/`-segment of
 * the key is encoded individually so the slashes stay real path separators and
 * the signed canonical path matches exactly what we send.
 */
export function s3ObjectUrl(conn: S3Connection, key: string): string {
  const encodedKey = key.split('/').map(encodeURIComponent).join('/');
  const endpoint = conn.endpoint.replace(/\/+$/, '');
  if (conn.forcePathStyle) {
    return `${endpoint}/${encodeURIComponent(conn.bucket)}/${encodedKey}`;
  }
  const url = new URL(endpoint);
  url.hostname = `${conn.bucket}.${url.hostname}`;
  return `${url.origin}/${encodedKey}`;
}

/**
 * S3-compatible storage via SigV4-signed `fetch` (Worker-safe — aws4fetch signs
 * with WebCrypto, no Node SDK). Used by self-hosters pointing at MinIO/S3.
 */
export function createS3BlobStorage(conn: S3Connection): BlobStorage {
  const client = new AwsClient({
    accessKeyId: conn.accessKeyId,
    secretAccessKey: conn.secretAccessKey,
    service: 's3',
    region: conn.region,
    // Bound aws4fetch's built-in retry (it defaults to ~10 with backoff, which
    // would pile latency onto the hot ingest path on a persistent 5xx). Writes
    // already get outer retries from the queue consumer; 2 covers transient blips.
    retries: 2,
  });

  return {
    put: async (key, body, contentType) => {
      assertSafeBlobKey(key);
      const res = await client.fetch(s3ObjectUrl(conn, key), {
        method: 'PUT',
        body,
        headers: { 'content-type': contentType },
      });
      if (!res.ok) {
        throw new Error(`blob-offload: S3 put ${key} failed (${res.status})`);
      }
    },
    get: async (key) => {
      assertSafeBlobKey(key);
      const res = await client.fetch(s3ObjectUrl(conn, key), { method: 'GET' });
      if (res.status === 404) return null;
      if (!res.ok) {
        throw new Error(`blob-offload: S3 get ${key} failed (${res.status})`);
      }
      return new Uint8Array(await res.arrayBuffer());
    },
    delete: async (key) => {
      assertSafeBlobKey(key);
      const res = await client.fetch(s3ObjectUrl(conn, key), { method: 'DELETE' });
      // S3 answers 204 for present and absent keys alike; a 404 from a
      // less-faithful S3 gateway still means "not there" — both are the
      // idempotent no-op this surface promises.
      if (!res.ok && res.status !== 404) {
        throw new Error(`blob-offload: S3 delete ${key} failed (${res.status})`);
      }
    },
  };
}
