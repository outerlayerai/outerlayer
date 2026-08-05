import { describe, expect, it, vi } from 'vitest';
import type { BlobStorage } from '../lib/blob-storage';
import { rehydrateBlobs } from './blob-rehydrate';

const encoder = new TextEncoder();

const storageOf = (map: Record<string, string>): BlobStorage => ({
  put: async () => {},
  get: async (key) => (key in map ? encoder.encode(map[key]!) : null),
});

describe('rehydrateBlobs', () => {
  it('returns the input unchanged when there are no blobRefs', async () => {
    const io = { input: 'a', output: 'b' };
    const result = await rehydrateBlobs(io, storageOf({}));
    expect(result).toEqual({ input: 'a', output: 'b' });
  });

  it('replaces the previewed field with the full value fetched by blob_id', async () => {
    const full = JSON.stringify([{ mimeType: 'image/png', base64: 'AAAA' }]);
    const io = {
      input: 'small input',
      output: 'preview…',
      blobRefs: JSON.stringify([{ field: 'Output', blob_id: 'tnt/app/t/s/Output', size: 999 }]),
    };
    const result = await rehydrateBlobs(io, storageOf({ 'tnt/app/t/s/Output': full }));

    expect(result.output).toBe(full); // full value restored
    expect(result.input).toBe('small input'); // untouched
  });

  it('restores multiple offloaded fields in one pass', async () => {
    const io = {
      input: 'in-preview',
      output: 'out-preview',
      blobRefs: JSON.stringify([
        { field: 'Input', blob_id: 'k/Input', size: 1 },
        { field: 'Output', blob_id: 'k/Output', size: 1 },
      ]),
    };
    const result = await rehydrateBlobs(io, storageOf({ 'k/Input': 'IN', 'k/Output': 'OUT' }));
    expect(result.input).toBe('IN');
    expect(result.output).toBe('OUT');
  });

  it('leaves the preview in place when the blob is missing (best-effort, no throw)', async () => {
    const io = {
      output: 'preview…',
      blobRefs: JSON.stringify([{ field: 'Output', blob_id: 'gone', size: 1 }]),
    };
    const result = await rehydrateBlobs(io, storageOf({}));
    expect(result.output).toBe('preview…');
  });

  it('ignores malformed blobRefs JSON', async () => {
    const io = { output: 'preview…', blobRefs: 'not json' };
    const result = await rehydrateBlobs(io, storageOf({}));
    expect(result.output).toBe('preview…');
  });

  it('is a no-op for an empty blobRefs array', async () => {
    const io = { output: 'preview…', blobRefs: '[]' };
    const result = await rehydrateBlobs(io, storageOf({}));
    expect(result.output).toBe('preview…');
  });

  it('is a no-op (no throw) for valid JSON that is not an array', async () => {
    // `{}` parses fine but isn't an array. The Array.isArray guard must bail
    // BEFORE the `for…of refs` loop — otherwise iterating a non-iterable throws.
    const io = { output: 'preview…', blobRefs: '{"field":"Output","blob_id":"k"}' };
    const result = await rehydrateBlobs(io, storageOf({ k: 'full' }));
    expect(result.output).toBe('preview…'); // unchanged, and crucially: did not throw
  });

  it('does NOT hit storage for refs it skips (unknown field / non-string blob_id)', async () => {
    // The skip guard must `continue` before the storage.get — a flipped guard
    // would fetch (and try to assign) for a ref it should ignore.
    const get = vi.fn(async () => encoder.encode('SHOULD NOT BE USED'));
    const storage: BlobStorage = { put: async () => {}, get };
    const io = {
      output: 'preview…',
      blobRefs: JSON.stringify([
        { field: 'NotAColumn', blob_id: 'k1', size: 1 },
        { field: 'Output', blob_id: 999, size: 1 },
      ]),
    };
    const result = await rehydrateBlobs(io, storage);
    expect(result.output).toBe('preview…');
    expect(get).not.toHaveBeenCalled();
  });

  it('skips a ref with an unknown field name (no crash)', async () => {
    const io = {
      output: 'preview…',
      blobRefs: JSON.stringify([{ field: 'NotAColumn', blob_id: 'k', size: 1 }]),
    };
    const result = await rehydrateBlobs(io, storageOf({ k: 'full' }));
    expect(result.output).toBe('preview…'); // untouched — unknown field ignored
  });

  it('skips a ref with a non-string blob_id', async () => {
    const io = {
      output: 'preview…',
      blobRefs: JSON.stringify([{ field: 'Output', blob_id: 123, size: 1 }]),
    };
    const result = await rehydrateBlobs(io, storageOf({}));
    expect(result.output).toBe('preview…');
  });

  it('keeps the preview (best-effort) when storage.get throws', async () => {
    const storage: BlobStorage = {
      put: async () => {},
      get: async () => {
        throw new Error('r2 unavailable');
      },
    };
    const io = {
      output: 'preview…',
      blobRefs: JSON.stringify([{ field: 'Output', blob_id: 'k', size: 1 }]),
    };
    const result = await rehydrateBlobs(io, storage); // must not throw
    expect(result.output).toBe('preview…');
  });

  it('partial restore: one blob present, one missing — present restored, missing keeps preview', async () => {
    const io = {
      input: 'in-preview',
      output: 'out-preview',
      blobRefs: JSON.stringify([
        { field: 'Input', blob_id: 'k/in', size: 1 },
        { field: 'Output', blob_id: 'k/out-missing', size: 1 },
      ]),
    };
    const result = await rehydrateBlobs(io, storageOf({ 'k/in': 'FULL INPUT' }));
    expect(result.input).toBe('FULL INPUT');
    expect(result.output).toBe('out-preview'); // missing blob → preview kept
  });

  it('round-trips multi-byte UTF-8 blob content', async () => {
    const full = '日本語の出力 😀 ' + '€'.repeat(100);
    const io = {
      output: 'preview…',
      blobRefs: JSON.stringify([{ field: 'Output', blob_id: 'k', size: 1 }]),
    };
    const result = await rehydrateBlobs(io, storageOf({ k: full }));
    expect(result.output).toBe(full);
  });
});
