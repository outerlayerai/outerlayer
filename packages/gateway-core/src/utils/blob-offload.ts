/**
 * Size-driven blob offload for trace ingestion.
 *
 * Runs at ingest, AFTER normalization + row construction but BEFORE enqueue.
 * For each oversized string column (Input/Output/OutputObject/ToolCalls) it
 * uploads the full value to object storage (R2), replaces the column with a
 * small inline PREVIEW, and records a pointer in BlobRefs. This:
 *   - keeps every queue message well under the 128KB Cloudflare limit,
 *   - preserves the full payload (unlike truncation, which destroyed it),
 *   - keeps the hot read path cheap (preview is inline; full is fetched only
 *     on demand, browser-direct via a presigned URL).
 *
 * Offload is primarily size-driven: it stores the column's exact string bytes.
 * The ONE content rule is media: a field whose value contains a
 * `{ mimeType|mediaType, base64 }` leaf is ALWAYS offloaded, even below the size
 * threshold. The trace viewer renders media from blobs, so a small generated
 * image must be a blob too — otherwise it would render as a base64 text wall
 * while a large one renders as an image. Offloading all media keeps that path
 * uniform (and keeps the base64 out of ClickHouse's hot columns).
 *
 * Full-fidelity consumers (dataset import, experiments, export) MUST rehydrate
 * via the resolver — the inline column is only a preview once offloaded.
 */

import type { ClickHouseRow } from '../services/span-converter';
import type { BlobStorage } from '../lib/blob-storage';
import { containsMedia } from './media-detection';

/** Inline preview kept in ClickHouse for an offloaded field (cheap hot-path read). */
export const PREVIEW_BYTES = 8 * 1024;
/** Fields at or below this stay fully inline (the common case). */
export const OFFLOAD_THRESHOLD_BYTES = 32 * 1024;
/** Above this we don't upload (bounds Worker memory) — truncate inline as a last resort. */
export const MAX_BLOB_BYTES = 20 * 1024 * 1024;

/** Row string columns eligible for offload (each maps 1:1 to a ClickHouse column). */
export const OFFLOAD_FIELDS = ['Input', 'Output', 'OutputObject', 'ToolCalls'] as const;
export type OffloadField = (typeof OFFLOAD_FIELDS)[number];

/** Pointer stored in the BlobRefs column. `field` IS the ClickHouse column. */
export interface BlobRef {
  field: OffloadField;
  /** Storage object key (also the tenant-scoped path). */
  blob_id: string;
  /** UTF-8 byte size of the full value (for the UI to show "load full (N KB)"). */
  size: number;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8');

function utf8Len(s: string): number {
  return encoder.encode(s).length;
}

/** Truncate to <= maxBytes at a UTF-8 code-point boundary (no broken sequences). */
export function previewOf(value: string, maxBytes: number): string {
  const bytes = encoder.encode(value);
  if (bytes.length <= maxBytes) return value;
  let end = Math.max(0, maxBytes);
  while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end--;
  return decoder.decode(bytes.subarray(0, end));
}

/** Tenant-scoped, deterministic key so a retried ingest re-PUTs the same object. */
function blobKey(row: ClickHouseRow, field: OffloadField): string {
  return `${row.TenantId}/${row.AppId}/${row.TraceId}/${row.SpanId}/${field}`;
}

/**
 * Offload one row's oversized columns IN PLACE. Returns the number of fields
 * lifted to storage. Upload failure (or a field over MAX_BLOB_BYTES) degrades
 * to an inline preview so the row always fits the queue — never throws into the
 * ingest path.
 */
async function offloadRow(row: ClickHouseRow, storage: BlobStorage): Promise<number> {
  const refs: BlobRef[] = [];
  // Identical field values (e.g. Output and OutputObject are byte-equal when the
  // output is already JSON) are uploaded ONCE — the later field points its
  // BlobRef at the first field's object instead of writing a duplicate. Keyed by
  // the full value; only offloaded values reach here, so the map stays tiny.
  const uploadedByValue = new Map<string, string>();

  for (const field of OFFLOAD_FIELDS) {
    const value = row[field];
    if (typeof value !== 'string' || value.length === 0) continue;
    const size = utf8Len(value);
    // Offload when oversized OR when the value is media — media is always lifted
    // to a blob so the viewer renders it as an image at any size. The size check
    // short-circuits, so large fields never pay the media parse.
    if (size <= OFFLOAD_THRESHOLD_BYTES && !containsMedia(value)) continue;

    const preview = previewOf(value, PREVIEW_BYTES);

    // Too large to hold in Worker memory for upload — truncate inline. This is
    // the last resort for an oversized value: no blob is written, so the full
    // value is not recoverable. (The upload-failure path below degrades the
    // same way, but only when the PUT itself fails.)
    if (size > MAX_BLOB_BYTES) {
      row[field] = preview;
      continue;
    }

    // Reuse an already-uploaded object when this field's bytes are identical to
    // an earlier field's (no second PUT, no duplicate R2 object).
    const existingKey = uploadedByValue.get(value);
    if (existingKey) {
      row[field] = preview;
      refs.push({ field, blob_id: existingKey, size });
      continue;
    }

    const key = blobKey(row, field);
    try {
      await storage.put(key, encoder.encode(value), 'application/json');
    } catch (e) {
      // Upload failed — keep the row valid for the queue by previewing inline.
      row[field] = preview;
      console.error('[traces] blob upload failed; field previewed inline', {
        traceId: row.TraceId,
        spanId: row.SpanId,
        field,
        error: e instanceof Error ? e.message : String(e),
      });
      continue;
    }

    uploadedByValue.set(value, key);
    row[field] = preview;
    refs.push({ field, blob_id: key, size });
  }

  if (refs.length > 0) {
    row.BlobRefs = JSON.stringify(refs);
  }

  return refs.length;
}

export interface BlobOffloadResult {
  /** Number of fields lifted to storage across the batch. */
  blobCount: number;
  /** Number of rows that had at least one field offloaded. */
  rowCount: number;
}

/**
 * Offload oversized columns across a batch of rows IN PLACE. Per-row failures
 * are isolated so one bad row never fails the batch.
 */
export async function offloadRowsBlobs(
  rows: ClickHouseRow[],
  storage: BlobStorage,
): Promise<BlobOffloadResult> {
  let blobCount = 0;
  let rowCount = 0;
  for (const row of rows) {
    try {
      const n = await offloadRow(row, storage);
      if (n > 0) {
        blobCount += n;
        rowCount++;
      }
    } catch (e) {
      // Isolate: one bad row must never fail the batch. The row keeps its
      // inline (possibly oversized) value; the chunker rejects it downstream
      // if it still doesn't fit.
      console.error('[traces] blob offload failed for row', {
        traceId: row.TraceId,
        spanId: row.SpanId,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }
  return { blobCount, rowCount };
}
