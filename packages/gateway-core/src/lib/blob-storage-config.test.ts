import { describe, it, expect } from 'vitest';
import {
  resolveBlobStorageConfig,
  type BlobStorageEnv,
} from './blob-storage-config';

const FULL_S3: BlobStorageEnv = {
  BLOB_STORAGE_BACKEND: 's3',
  BLOB_S3_ENDPOINT: 'http://127.0.0.1:9300',
  BLOB_S3_REGION: 'eu-west-2',
  BLOB_S3_ACCESS_KEY_ID: 'minioadmin',
  BLOB_S3_SECRET_ACCESS_KEY: 'minioadmin',
  BLOB_S3_BUCKET: 'trace-blobs',
  BLOB_S3_FORCE_PATH_STYLE: 'false',
};

/** The four fields a usable s3 connection requires. */
const REQUIRED_S3_FIELDS = [
  'BLOB_S3_ENDPOINT',
  'BLOB_S3_ACCESS_KEY_ID',
  'BLOB_S3_SECRET_ACCESS_KEY',
  'BLOB_S3_BUCKET',
] as const;

describe('resolveBlobStorageConfig', () => {
  it('defaults to the r2 backend when nothing is set (hosted default)', () => {
    expect(resolveBlobStorageConfig({})).toEqual({
      backend: 'r2',
      enabled: true,
      s3: null,
    });
  });

  it('ignores BLOB_S3_* and reports no connection when backend stays r2', () => {
    // Stray S3 vars must NOT leak a connection while r2 is selected.
    expect(
      resolveBlobStorageConfig({ ...FULL_S3, BLOB_STORAGE_BACKEND: 'r2' }),
    ).toEqual({ backend: 'r2', enabled: true, s3: null });
  });

  it('resolves a full s3 connection, honoring explicit region + path-style', () => {
    expect(resolveBlobStorageConfig(FULL_S3)).toEqual({
      backend: 's3',
      enabled: true,
      s3: {
        endpoint: 'http://127.0.0.1:9300',
        region: 'eu-west-2',
        accessKeyId: 'minioadmin',
        secretAccessKey: 'minioadmin',
        bucket: 'trace-blobs',
        forcePathStyle: false,
      },
    });
  });

  it('defaults region to us-east-1 and force-path-style to true when omitted', () => {
    const { s3 } = resolveBlobStorageConfig({
      BLOB_STORAGE_BACKEND: 's3',
      BLOB_S3_ENDPOINT: 'http://127.0.0.1:9300',
      BLOB_S3_ACCESS_KEY_ID: 'minioadmin',
      BLOB_S3_SECRET_ACCESS_KEY: 'minioadmin',
      BLOB_S3_BUCKET: 'trace-blobs',
    });
    expect(s3?.region).toBe('us-east-1');
    expect(s3?.forcePathStyle).toBe(true);
  });

  it('selects the backend case-insensitively', () => {
    expect(
      resolveBlobStorageConfig({ ...FULL_S3, BLOB_STORAGE_BACKEND: 'S3' }).backend,
    ).toBe('s3');
  });

  it('falls back to r2 for an unknown backend value', () => {
    expect(resolveBlobStorageConfig({ BLOB_STORAGE_BACKEND: 'gcs' })).toEqual({
      backend: 'r2',
      enabled: true,
      s3: null,
    });
  });

  // Each required field, missing OR whitespace-only, must independently clamp an
  // s3 deploy to disabled — never a half-built client. Covering them one at a
  // time pins the OR-chain and the per-field `?.trim()` (a stray-whitespace value
  // must be treated as unset, not passed through).
  describe.each(REQUIRED_S3_FIELDS)('required field %s', (field) => {
    it('clamps to disabled when undefined', () => {
      const env = { ...FULL_S3 };
      delete env[field];
      expect(resolveBlobStorageConfig(env)).toEqual({
        backend: 's3',
        enabled: false,
        s3: null,
      });
    });

    it('clamps to disabled when whitespace-only', () => {
      expect(
        resolveBlobStorageConfig({ ...FULL_S3, [field]: '   ' }),
      ).toEqual({ backend: 's3', enabled: false, s3: null });
    });
  });

  it('trims surrounding whitespace on resolved connection fields', () => {
    const s3 = resolveBlobStorageConfig({
      BLOB_STORAGE_BACKEND: 's3',
      BLOB_S3_ENDPOINT: '  http://127.0.0.1:9300  ',
      BLOB_S3_REGION: '  ap-south-1  ',
      BLOB_S3_ACCESS_KEY_ID: '  key  ',
      BLOB_S3_SECRET_ACCESS_KEY: '  secret  ',
      BLOB_S3_BUCKET: '  trace-blobs  ',
    }).s3;
    expect(s3).toEqual({
      endpoint: 'http://127.0.0.1:9300',
      region: 'ap-south-1',
      accessKeyId: 'key',
      secretAccessKey: 'secret',
      bucket: 'trace-blobs',
      forcePathStyle: true,
    });
  });
});
