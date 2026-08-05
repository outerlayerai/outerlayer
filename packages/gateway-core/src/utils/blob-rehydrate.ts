/**
 * Blob rehydration — the read-side counterpart of blob-offload.
 *
 * When a span field was offloaded at ingest, its inline ClickHouse column holds
 * only a preview and the full value lives in object storage (R2). Full-fidelity
 * consumers (dataset import, experiment replay, export) MUST call this to
 * restore the complete values before use — otherwise they silently operate on
 * truncated previews. Hot read paths (list/preview) skip it.
 *
 * It is a no-op when nothing was offloaded (no blobRefs), so it is safe to call
 * on every span — only offloaded fields incur a storage fetch.
 */

import type { BlobStorage } from '../lib/blob-storage';

/** Maps a BlobRef.field (ClickHouse column) to the IO object's property. */
const FIELD_TO_KEY = {
  Input: 'input',
  Output: 'output',
  OutputObject: 'outputObject',
  ToolCalls: 'toolCalls',
} as const;

type IoKey = (typeof FIELD_TO_KEY)[keyof typeof FIELD_TO_KEY];

/** Minimal shape this operates on — any object carrying IO columns + blobRefs. */
export interface RehydratableIO {
  input?: string;
  output?: string;
  outputObject?: string | null;
  toolCalls?: string | null;
  blobRefs?: string;
}

const decoder = new TextDecoder('utf-8');

/**
 * Return a copy of `io` with any offloaded fields replaced by their full value
 * fetched from `storage`. Returns the input unchanged when there are no
 * blobRefs. A missing/failed blob fetch leaves that field's preview in place
 * (degraded but non-throwing) so one bad blob never aborts the whole import.
 */
export async function rehydrateBlobs<T extends RehydratableIO>(
  io: T,
  storage: BlobStorage,
): Promise<T> {
  if (!io.blobRefs) return io;

  let refs: Array<{ field: string; blob_id: string }>;
  try {
    refs = JSON.parse(io.blobRefs);
  } catch {
    return io;
  }
  if (!Array.isArray(refs) || refs.length === 0) return io;

  const out: T = { ...io };
  for (const ref of refs) {
    const key = FIELD_TO_KEY[ref.field as keyof typeof FIELD_TO_KEY] as IoKey | undefined;
    if (!key || typeof ref.blob_id !== 'string') continue;
    try {
      const bytes = await storage.get(ref.blob_id);
      if (bytes) (out as Record<string, unknown>)[key] = decoder.decode(bytes);
    } catch {
      // Leave the preview in place — best-effort.
    }
  }
  return out;
}
