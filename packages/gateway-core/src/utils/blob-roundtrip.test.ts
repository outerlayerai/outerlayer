/**
 * Integration: offload (write) ↔ rehydrate (read) round-trip through ONE shared
 * storage. This is the contract that the two halves must agree on — offload
 * writes `BlobRefs[].field` as the ClickHouse column name; rehydrate maps that
 * field back to the IO key. If either side drifts, the full value lands in the
 * wrong place (or nowhere) and the round-trip below fails.
 */

import { describe, expect, it } from 'vitest';
import type { BlobStorage } from '../lib/blob-storage';
import type { ClickHouseRow } from '../services/span-converter';
import { offloadRowsBlobs, OFFLOAD_THRESHOLD_BYTES } from './blob-offload';
import { rehydrateBlobs } from './blob-rehydrate';

/** A single in-memory store shared by both offload and rehydrate. */
function sharedStorage() {
  const map = new Map<string, Uint8Array>();
  const storage: BlobStorage = {
    put: async (key, body) => {
      map.set(key, body instanceof Uint8Array ? body : new Uint8Array(body));
    },
    get: async (key) => map.get(key) ?? null,
  };
  return { storage, map };
}

const big = (n: number) => 'x'.repeat(n);

const row = (over: Partial<ClickHouseRow>): ClickHouseRow =>
  ({
    TenantId: 'tnt',
    AppId: 'app',
    TraceId: 'trace-1',
    SpanId: 'span-1',
    SpanName: 'image-generation',
    Input: '',
    Output: '',
    OutputObject: '',
    ToolCalls: '',
    BlobRefs: '',
    ...over,
  }) as ClickHouseRow;

describe('blob offload ↔ rehydrate round-trip', () => {
  it('restores every offloaded field to its exact original value via the same storage', async () => {
    const { storage } = sharedStorage();
    const fullOutput = JSON.stringify([{ mimeType: 'image/png', base64: big(60_000) }]);
    const fullInput = big(OFFLOAD_THRESHOLD_BYTES + 10_000);

    const r = row({ Input: fullInput, Output: fullOutput });

    const result = await offloadRowsBlobs([r], storage);
    expect(result.blobCount).toBe(2); // Input + Output both offloaded

    // Inline columns now hold only previews.
    expect(r.Output.length).toBeLessThan(fullOutput.length);
    expect(r.Input.length).toBeLessThan(fullInput.length);

    // Rehydrate from the SAME storage — field→column contract must hold.
    const rehydrated = await rehydrateBlobs(
      {
        input: r.Input,
        output: r.Output,
        outputObject: r.OutputObject,
        toolCalls: r.ToolCalls,
        blobRefs: r.BlobRefs,
      },
      storage,
    );

    expect(rehydrated.output).toBe(fullOutput);
    expect(rehydrated.input).toBe(fullInput);
    // Non-offloaded fields are untouched.
    expect(rehydrated.outputObject).toBe('');
    expect(rehydrated.toolCalls).toBe('');
  });

  it('is a no-op for a row with no oversized fields (round-trip identity)', async () => {
    const { storage, map } = sharedStorage();
    const r = row({ Input: 'small in', Output: 'small out' });

    const result = await offloadRowsBlobs([r], storage);
    expect(result).toEqual({ blobCount: 0, rowCount: 0 });
    expect(map.size).toBe(0);
    expect(r.BlobRefs).toBe('');

    const rehydrated = await rehydrateBlobs(
      { input: r.Input, output: r.Output, blobRefs: r.BlobRefs },
      storage,
    );
    expect(rehydrated.input).toBe('small in');
    expect(rehydrated.output).toBe('small out');
  });

  it('preserves media inside an offloaded Output so the UI can render it after rehydration', async () => {
    const { storage } = sharedStorage();
    // Image-generation output: array of {mimeType, base64}, large enough to offload.
    const media = [{ mimeType: 'image/png', base64: big(50_000) }];
    const r = row({ Output: JSON.stringify(media) });

    await offloadRowsBlobs([r], storage);
    const rehydrated = await rehydrateBlobs({ output: r.Output, blobRefs: r.BlobRefs }, storage);

    const parsed = JSON.parse(rehydrated.output!);
    expect(parsed[0].mimeType).toBe('image/png');
    expect(parsed[0].base64).toBe(media[0].base64);
  });
});
