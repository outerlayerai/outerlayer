/**
 * Generated-media detection for trace ingestion.
 *
 * A field "is media" when its value contains a `{ mimeType|mediaType, base64 }`
 * leaf anywhere in its parsed JSON — the shape the SDK records for image/speech
 * generation. Media fields are ALWAYS offloaded to object storage (regardless of
 * size) so the trace viewer renders them as an image/audio at any size, and the
 * redundant raw attribute is dropped so no base64 lingers in ClickHouse.
 *
 * Shared by `blob-offload` (offload decision) and `span-converter`
 * (`stripRedundantIoAttributes`) so the two agree on what counts as media.
 */

/** Recursively true when any leaf is a `{ mimeType|mediaType, base64 }` object. */
export function hasMediaLeaf(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.some(hasMediaLeaf);
  const obj = value as Record<string, unknown>;
  const mime = obj.mimeType ?? obj.mediaType;
  if (typeof mime === "string" && typeof obj.base64 === "string") return true;
  return Object.values(obj).some(hasMediaLeaf);
}

/**
 * True when a serialized field value contains generated media. A cheap substring
 * guard runs first so a normal text field is NEVER JSON-parsed — only a value
 * that genuinely looks like media pays the parse.
 */
export function containsMedia(value: string): boolean {
  if (!value.includes("base64")) return false;
  if (!value.includes("mimeType") && !value.includes("mediaType")) return false;
  try {
    return hasMediaLeaf(JSON.parse(value));
  } catch {
    return false;
  }
}
