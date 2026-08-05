import { describe, expect, it, vi } from 'vitest';
import type { ClickHouseRow } from '../services/span-converter';
import type { BlobStorage } from '../lib/blob-storage';
import {
  offloadRowsBlobs,
  previewOf,
  OFFLOAD_THRESHOLD_BYTES,
  PREVIEW_BYTES,
  MAX_BLOB_BYTES,
} from './blob-offload';

const utf8 = (s: string) => new TextEncoder().encode(s).length;

describe('previewOf — UTF-8-safe byte truncation', () => {
  it('returns the value unchanged when it is within the byte cap', () => {
    expect(previewOf('hello', 10)).toBe('hello'); // 5 bytes <= 10
  });

  it('returns the value unchanged at EXACTLY the cap (boundary: <=, not <)', () => {
    expect(previewOf('abcde', 5)).toBe('abcde'); // 5 bytes === cap → no truncation
  });

  it('truncates an over-cap ASCII value to within the byte cap', () => {
    const out = previewOf('x'.repeat(100), 10);
    expect(out).toBe('x'.repeat(10));
    expect(utf8(out)).toBe(10);
  });

  it('cuts on a whole code point — never mid multi-byte sequence', () => {
    // '€' is 3 UTF-8 bytes. Cap 7 lands mid-third-€; must back up to 6 bytes (2 €),
    // not emit a lone continuation byte.
    const out = previewOf('€€€€', 7);
    expect(out).toBe('€€');
    expect(utf8(out)).toBeLessThanOrEqual(7);
    expect(out.endsWith('€')).toBe(true); // no broken char
  });

  it('a cap that lands exactly on a code-point boundary keeps the whole char', () => {
    expect(previewOf('€€€', 6)).toBe('€€'); // 6 bytes === two whole € → exactly 2
  });
});

// Minimal row factory — only the fields blob-offload reads/writes. The rest of
// ClickHouseRow is irrelevant here, so cast a partial.
const row = (over: Partial<ClickHouseRow>): ClickHouseRow =>
  ({
    TenantId: 'tnt',
    AppId: 'app',
    TraceId: 'trace-1',
    SpanId: 'span-1',
    SpanName: 'gen',
    Input: '',
    Output: '',
    OutputObject: '',
    ToolCalls: '',
    BlobRefs: '',
    ...over,
  }) as ClickHouseRow;

interface Put { key: string; size: number; contentType: string }

const makeStorage = (opts: { failAll?: boolean } = {}) => {
  const puts: Put[] = [];
  const storage: BlobStorage = {
    put: async (key, body, contentType) => {
      if (opts.failAll) throw new Error('r2 down');
      puts.push({ key, size: body.byteLength, contentType });
    },
    get: async () => null,
  };
  return { storage, puts };
};

const big = (n: number) => 'x'.repeat(n);

describe('offloadRowsBlobs', () => {
  it('offloads an oversized column: uploads full, leaves a preview, records a ref', async () => {
    const { storage, puts } = makeStorage();
    const output = big(OFFLOAD_THRESHOLD_BYTES + 5_000); // > 32KB
    const r = row({ Output: output, Input: 'small input' });

    const result = await offloadRowsBlobs([r], storage);

    expect(result).toEqual({ blobCount: 1, rowCount: 1 });
    // Full value uploaded under the tenant-scoped, field-named key.
    expect(puts).toEqual([
      { key: 'tnt/app/trace-1/span-1/Output', size: output.length, contentType: 'application/json' },
    ]);
    // Inline column is now a bounded preview, not the full value.
    expect(r.Output.length).toBeLessThanOrEqual(PREVIEW_BYTES);
    expect(r.Output).toBe(output.slice(0, r.Output.length));
    // Small field untouched.
    expect(r.Input).toBe('small input');
    // Pointer recorded for the resolver/UI; field == column.
    expect(JSON.parse(r.BlobRefs)).toEqual([
      { field: 'Output', blob_id: 'tnt/app/trace-1/span-1/Output', size: output.length },
    ]);
  });

  it('leaves small columns fully inline and uploads nothing', async () => {
    const { storage, puts } = makeStorage();
    const r = row({ Output: 'just a normal answer', Input: 'hi' });

    const result = await offloadRowsBlobs([r], storage);

    expect(result).toEqual({ blobCount: 0, rowCount: 0 });
    expect(puts).toEqual([]);
    expect(r.Output).toBe('just a normal answer');
    expect(r.BlobRefs).toBe('');
  });

  it('ALWAYS offloads a SUB-threshold media field, so a small image renders as media, not base64 text', async () => {
    const { storage, puts } = makeStorage();
    const output = '[{"mimeType":"image/png","base64":"iVBORw0KGgo="}]'; // a few dozen bytes
    expect(utf8(output)).toBeLessThan(OFFLOAD_THRESHOLD_BYTES);
    const r = row({ Output: output });

    const result = await offloadRowsBlobs([r], storage);

    expect(result).toEqual({ blobCount: 1, rowCount: 1 });
    expect(puts).toEqual([
      { key: 'tnt/app/trace-1/span-1/Output', size: output.length, contentType: 'application/json' },
    ]);
    expect(JSON.parse(r.BlobRefs)).toEqual([
      { field: 'Output', blob_id: 'tnt/app/trace-1/span-1/Output', size: output.length },
    ]);
  });

  it('does NOT offload a small non-media field that merely mentions base64/mimeType', async () => {
    const { storage, puts } = makeStorage();
    const r = row({ Output: 'to decode base64 with a mimeType you call atob()' });

    const result = await offloadRowsBlobs([r], storage);

    expect(result).toEqual({ blobCount: 0, rowCount: 0 });
    expect(puts).toEqual([]);
    expect(r.BlobRefs).toBe('');
  });

  it('degrades to an inline preview (no ref) when upload fails — row still fits the queue', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const { storage } = makeStorage({ failAll: true });
      const output = big(OFFLOAD_THRESHOLD_BYTES + 5_000);
      const r = row({ Output: output });

      const result = await offloadRowsBlobs([r], storage);

      expect(result).toEqual({ blobCount: 0, rowCount: 0 });
      expect(r.Output.length).toBeLessThanOrEqual(PREVIEW_BYTES); // previewed, not full
      expect(r.BlobRefs).toBe(''); // no pointer — nothing was stored
      // The failure is logged WITH diagnostic context (field + ids), not silently.
      expect(errorSpy).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ field: 'Output', traceId: 'trace-1', spanId: 'span-1' }),
      );
    } finally {
      errorSpy.mockRestore();
    }
  });

  it('offloads multiple oversized columns on one row', async () => {
    const { storage, puts } = makeStorage();
    // Distinct content per field so each gets its own object (identical values
    // are deduped — covered separately).
    const r = row({
      Input: 'i'.repeat(OFFLOAD_THRESHOLD_BYTES + 1),
      Output: 'o'.repeat(OFFLOAD_THRESHOLD_BYTES + 1),
    });

    const result = await offloadRowsBlobs([r], storage);

    expect(result).toEqual({ blobCount: 2, rowCount: 1 });
    expect(puts.map((p) => p.key).sort()).toEqual([
      'tnt/app/trace-1/span-1/Input',
      'tnt/app/trace-1/span-1/Output',
    ]);
    expect(JSON.parse(r.BlobRefs).map((b: { field: string }) => b.field).sort()).toEqual([
      'Input',
      'Output',
    ]);
  });
});

describe('offloadRowsBlobs — edge cases', () => {
  it('does NOT offload a field exactly at the threshold; offloads one byte over', async () => {
    const { storage, puts } = makeStorage();
    const atThreshold = row({ Output: big(OFFLOAD_THRESHOLD_BYTES) });
    const overThreshold = row({ SpanId: 'span-2', Output: big(OFFLOAD_THRESHOLD_BYTES + 1) });

    const res = await offloadRowsBlobs([atThreshold, overThreshold], storage);

    expect(res.blobCount).toBe(1); // only the over-threshold row
    expect(atThreshold.BlobRefs).toBe('');
    expect(atThreshold.Output.length).toBe(OFFLOAD_THRESHOLD_BYTES); // untouched
    expect(puts.map((p) => p.key)).toEqual(['tnt/app/trace-1/span-2/Output']);
  });

  it('uploads a field exactly AT the 20MB cap (boundary: only strictly-over truncates)', async () => {
    const { storage, puts } = makeStorage();
    // `'x'` is 1 byte in UTF-8, so length === byte length === MAX_BLOB_BYTES.
    const r = row({ Output: big(MAX_BLOB_BYTES) });

    const res = await offloadRowsBlobs([r], storage);

    expect(res).toEqual({ blobCount: 1, rowCount: 1 }); // uploaded, not truncated
    expect(puts).toHaveLength(1);
    expect(puts[0]!.size).toBe(MAX_BLOB_BYTES);
    expect(JSON.parse(r.BlobRefs)[0].size).toBe(MAX_BLOB_BYTES);
  });

  it('does NOT upload a field over the 20MB cap; truncates inline with no ref (last resort)', async () => {
    const { storage, puts } = makeStorage();
    const r = row({ Output: big(MAX_BLOB_BYTES + 1) });

    const res = await offloadRowsBlobs([r], storage);

    expect(res).toEqual({ blobCount: 0, rowCount: 0 });
    expect(puts).toEqual([]); // nothing uploaded — too big to hold in memory
    expect(r.Output.length).toBeLessThanOrEqual(PREVIEW_BYTES); // truncated inline
    expect(r.BlobRefs).toBe(''); // no pointer (data-losing last resort)
  });

  it('records size as UTF-8 BYTE length and cuts the preview at a code-point boundary', async () => {
    const { storage, puts } = makeStorage();
    // 12k multi-byte chars (€ = 3 UTF-8 bytes) → 36k bytes > 32k threshold.
    const value = '€'.repeat(12_000);
    const r = row({ Output: value });

    await offloadRowsBlobs([r], storage);

    const refs = JSON.parse(r.BlobRefs);
    expect(refs[0].size).toBe(36_000); // byte length, not 12_000 chars
    expect(puts[0]!.size).toBe(36_000);
    // Preview is valid UTF-8 (no lone continuation byte) and within the byte cap.
    expect(new TextEncoder().encode(r.Output).length).toBeLessThanOrEqual(PREVIEW_BYTES);
    expect(r.Output.endsWith('€')).toBe(true); // cut on a whole char, not mid-sequence
  });

  it('uses a deterministic, tenant-scoped key so a retried ingest re-PUTs (idempotent)', async () => {
    const { storage, puts } = makeStorage();
    const mk = () => row({ Output: big(OFFLOAD_THRESHOLD_BYTES + 1) });

    await offloadRowsBlobs([mk()], storage);
    await offloadRowsBlobs([mk()], storage); // retry of the same trace/span/field

    expect(puts.map((p) => p.key)).toEqual([
      'tnt/app/trace-1/span-1/Output',
      'tnt/app/trace-1/span-1/Output', // same key — overwrite, not a new object
    ]);
  });

  it('skips empty and non-string fields', async () => {
    const { storage, puts } = makeStorage();
    const r = row({ Input: '', Output: undefined as unknown as string });
    const res = await offloadRowsBlobs([r], storage);
    expect(res).toEqual({ blobCount: 0, rowCount: 0 });
    expect(puts).toEqual([]);
  });

  it('skips a non-string field but still offloads a sibling oversized field (guard is OR, not AND)', async () => {
    // A row with one non-string field (Output: undefined) and one oversized
    // string field. The skip guard must `continue` past the undefined field
    // WITHOUT evaluating `.length` on it (an AND-guard would throw on
    // `undefined.length`, abort the whole row, and offload nothing).
    const { storage, puts } = makeStorage();
    const r = row({ Output: undefined as unknown as string, Input: big(OFFLOAD_THRESHOLD_BYTES + 1) });

    const res = await offloadRowsBlobs([r], storage);

    expect(res).toEqual({ blobCount: 1, rowCount: 1 }); // Input offloaded despite the bad sibling
    expect(puts.map((p) => p.key)).toEqual(['tnt/app/trace-1/span-1/Input']);
    expect(JSON.parse(r.BlobRefs)[0].field).toBe('Input');
  });

  it('uploads identical field values ONCE and points both refs at the same object', async () => {
    // Output and OutputObject are byte-identical when the output is already JSON.
    // Offloading both must not write two duplicate R2 objects.
    const { storage, puts } = makeStorage();
    const shared = JSON.stringify({ answer: 'x'.repeat(OFFLOAD_THRESHOLD_BYTES + 1_000) });
    const r = row({ Output: shared, OutputObject: shared });

    const res = await offloadRowsBlobs([r], storage);

    expect(res.blobCount).toBe(2); // both fields recorded a ref
    expect(puts).toHaveLength(1); // ...but only ONE object was written
    const refs = JSON.parse(r.BlobRefs) as Array<{ field: string; blob_id: string }>;
    const byField = Object.fromEntries(refs.map((b) => [b.field, b.blob_id]));
    // Both point at the first field's (Output) object — no duplicate.
    expect(byField.Output).toBe('tnt/app/trace-1/span-1/Output');
    expect(byField.OutputObject).toBe('tnt/app/trace-1/span-1/Output');
    expect(r.Output.length).toBeLessThanOrEqual(PREVIEW_BYTES);
    expect(r.OutputObject.length).toBeLessThanOrEqual(PREVIEW_BYTES);
  });

  it('still writes separate objects when two oversized fields DIFFER', async () => {
    const { storage, puts } = makeStorage();
    const r = row({
      Output: 'A'.repeat(OFFLOAD_THRESHOLD_BYTES + 1),
      Input: 'B'.repeat(OFFLOAD_THRESHOLD_BYTES + 1),
    });

    await offloadRowsBlobs([r], storage);

    expect(puts.map((p) => p.key).sort()).toEqual([
      'tnt/app/trace-1/span-1/Input',
      'tnt/app/trace-1/span-1/Output',
    ]);
  });

  it('isolates a per-row upload failure: the rest of the batch still offloads', async () => {
    const puts: Put[] = [];
    const storage: BlobStorage = {
      put: async (key, body, contentType) => {
        if (key.startsWith('tnt/app/bad/')) throw new Error('r2 down for this row');
        puts.push({ key, size: body.byteLength, contentType });
      },
      get: async () => null,
    };
    const bad = row({ TraceId: 'bad', Output: big(OFFLOAD_THRESHOLD_BYTES + 1) });
    const good = row({ TraceId: 'good', Output: big(OFFLOAD_THRESHOLD_BYTES + 1) });

    const res = await offloadRowsBlobs([bad, good], storage);

    expect(res).toEqual({ blobCount: 1, rowCount: 1 }); // only the good row
    expect(bad.BlobRefs).toBe(''); // bad row degraded to inline preview
    expect(bad.Output.length).toBeLessThanOrEqual(PREVIEW_BYTES);
    expect(JSON.parse(good.BlobRefs)[0].field).toBe('Output');
  });
});
