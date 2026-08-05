/**
 * Live S3 adapter ↔ MinIO round-trip.
 *
 * The unit tests (packages/gateway-core/src/lib/blob-storage.test.ts) prove the
 * adapter's logic against a mocked `fetch`; what they CAN'T prove is that the
 * SigV4 signature aws4fetch produces is actually accepted by a real S3 server,
 * that path-style addressing hits the right object, and that a real "no such key"
 * comes back as a 404 (→ null). This exercises `createS3BlobStorage` against the
 * MinIO the CI `gateway-integration-tests` job provisions (apps/gateway-node/
 * minio/docker-compose.yml, S3 API on :9300, bucket `trace-blobs`).
 *
 * Skips when MinIO isn't reachable (local runs without the compose up), so it
 * never produces a false failure outside the provisioned CI job.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { createS3BlobStorage } from '@repo/gateway-core/lib/blob-storage';
import type { S3Connection } from '@repo/gateway-core/lib/blob-storage-config';

const CONN: S3Connection = {
  endpoint: process.env.BLOB_S3_ENDPOINT || 'http://127.0.0.1:9300',
  region: process.env.BLOB_S3_REGION || 'us-east-1',
  accessKeyId: process.env.BLOB_S3_ACCESS_KEY_ID || 'minioadmin',
  secretAccessKey: process.env.BLOB_S3_SECRET_ACCESS_KEY || 'minioadmin',
  bucket: process.env.BLOB_S3_BUCKET || 'trace-blobs',
  forcePathStyle: true,
};

async function minioReachable(): Promise<boolean> {
  try {
    const res = await fetch(`${CONN.endpoint}/minio/health/live`);
    return res.ok;
  } catch {
    return false;
  }
}

describe('S3 blob storage ↔ live MinIO', () => {
  let reachable = false;

  beforeAll(async () => {
    reachable = await minioReachable();
  });

  it('round-trips an exact byte payload through a real SigV4 PUT/GET', async (ctx) => {
    if (!reachable) ctx.skip();
    const storage = createS3BlobStorage(CONN);
    const key = `tnt-test/${crypto.randomUUID()}/Output`;

    // A non-trivial payload: bytes across the full 0–255 range, > the inline
    // preview size, so this mirrors what offload actually writes.
    const payload = new Uint8Array(20_000).map((_, i) => i % 256);

    await storage.put(key, payload, 'application/octet-stream');
    const got = await storage.get(key);

    expect(got).toEqual(payload);
  });

  it('returns null for a key that does not exist (real 404)', async (ctx) => {
    if (!reachable) ctx.skip();
    const got = await createS3BlobStorage(CONN).get(`tnt-test/${crypto.randomUUID()}/missing`);
    expect(got).toBeNull();
  });

  it('overwrites idempotently (retried ingest re-PUTs the same key)', async (ctx) => {
    if (!reachable) ctx.skip();
    const storage = createS3BlobStorage(CONN);
    const key = `tnt-test/${crypto.randomUUID()}/Output`;

    await storage.put(key, new TextEncoder().encode('first'), 'text/plain');
    await storage.put(key, new TextEncoder().encode('second'), 'text/plain');

    expect(new TextDecoder().decode((await storage.get(key))!)).toBe('second');
  });
});
