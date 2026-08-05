/**
 * resolveBlobStorageConfig — the blob-storage backend toggle.
 *
 * Decides which object store the blob-offload seam wires: the Cloudflare R2
 * binding (`r2`, hosted default) or an S3-compatible store (`s3`, for
 * self-hosters with no Cloudflare account — MinIO, Supabase Storage, AWS S3).
 * Pure: the caller passes the already-read env strings in, so the decision is
 * unit-testable without an Env binding or a live store.
 *
 * Built on {@link @repo/adapter-config}'s `resolveToggle` so the backend
 * selection matches every other migration seam. Unlike the telemetry/email
 * seams, blob storage is not opt-in — the product always offloads — so the
 * meaningful output is `backend` plus, for `s3`, a fully-resolved connection.
 * `enabled` reflects "a usable store is configured": always true for `r2` (the
 * Worker binding is present in the hosted runtime), and true for `s3` only when
 * the full connection resolves — a half-configured `s3` deploy must NOT silently
 * fall back to writing nowhere.
 *
 * This resolver is intentionally not wired into the offload/rehydrate call sites
 * yet: the S3 adapter (`createS3BlobStorage`) + the factory that swaps the six
 * `createR2BlobStorage` call sites land in the follow-up "R2 → MinIO adapter" PR.
 */

import { resolveToggle, parseEnvBoolean } from '@repo/adapter-config';

export type BlobBackend = 'r2' | 's3';

/** The env values this resolver reads. All optional; all raw env strings. */
export interface BlobStorageEnv {
  BLOB_STORAGE_BACKEND?: string;
  BLOB_S3_ENDPOINT?: string;
  BLOB_S3_REGION?: string;
  BLOB_S3_ACCESS_KEY_ID?: string;
  BLOB_S3_SECRET_ACCESS_KEY?: string;
  BLOB_S3_BUCKET?: string;
  BLOB_S3_FORCE_PATH_STYLE?: string;
}

/** A fully-resolved S3 connection. Only present when `backend === 's3'`. */
export interface S3Connection {
  endpoint: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
  forcePathStyle: boolean;
}

export interface BlobStorageConfig {
  /** The selected store. `r2` (default) or `s3`. */
  backend: BlobBackend;
  /** True iff a usable store is configured (see module doc). */
  enabled: boolean;
  /** The S3 connection — present iff `backend === 's3'` AND it fully resolves. */
  s3: S3Connection | null;
}

const BLOB_BACKENDS = ['r2', 's3'] as const;

/** Default S3 region when `BLOB_S3_REGION` is unset (MinIO accepts any region). */
const DEFAULT_S3_REGION = 'us-east-1';

/**
 * Build the S3 connection from env — all-or-nothing on the four required fields
 * (endpoint, access key, secret, bucket). Returns null if any is missing, so a
 * partial `s3` config never resolves to a half-built client.
 */
function readS3Connection(env: BlobStorageEnv): S3Connection | null {
  const endpoint = env.BLOB_S3_ENDPOINT?.trim();
  const accessKeyId = env.BLOB_S3_ACCESS_KEY_ID?.trim();
  const secretAccessKey = env.BLOB_S3_SECRET_ACCESS_KEY?.trim();
  const bucket = env.BLOB_S3_BUCKET?.trim();

  if (!endpoint || !accessKeyId || !secretAccessKey || !bucket) return null;

  return {
    endpoint,
    region: env.BLOB_S3_REGION?.trim() || DEFAULT_S3_REGION,
    accessKeyId,
    secretAccessKey,
    bucket,
    // MinIO and most self-hosted S3 servers require path-style addressing
    // (virtual-host style needs per-bucket DNS); default it on.
    forcePathStyle: parseEnvBoolean(env.BLOB_S3_FORCE_PATH_STYLE) ?? true,
  };
}

export function resolveBlobStorageConfig(env: BlobStorageEnv): BlobStorageConfig {
  // Reuse the shared backend-selection (case-insensitive, defaults to backends[0]='r2').
  // Only `backend` is used here — blob storage isn't an opt-in seam, so `enabled`
  // is computed below from whether the selected store actually resolves.
  const { backend } = resolveToggle<BlobBackend>({
    backendValue: env.BLOB_STORAGE_BACKEND,
    backends: BLOB_BACKENDS,
  });

  if (backend === 'r2') {
    return { backend, enabled: true, s3: null };
  }

  const s3 = readS3Connection(env);
  return { backend, enabled: s3 !== null, s3 };
}
